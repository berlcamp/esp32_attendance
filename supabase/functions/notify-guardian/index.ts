// ===========================================================================
// notify-guardian
//
// Fans one attendance row out to that student's guardians on Telegram.
//
// This runs server-side rather than on the ESP32 for one reason above all:
// a bot token in the device's flash is readable over USB, and whoever reads it
// can message every parent as the school. There is no RLS equivalent that
// would contain that, the way RLS contains the anon key.
//
// Two entry points, same body:
//   - the pg_net trigger on INSERT into pta.attendance (sql/webhook.sql), or
//     an equivalent Supabase Database Webhook
//   - {"mode":"retry"} from pg_cron, to sweep up rows this function claimed
//     and then died before sending
//
// Deploy:
//   supabase functions deploy notify-guardian --no-verify-jwt
//   supabase secrets set TELEGRAM_BOT_TOKEN=... WEBHOOK_SECRET=...
// ===========================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendMessage, sendPhoto } from "../_shared/telegram.ts";
import { caption, type Job } from "../_shared/message.ts";

const BUCKET = Deno.env.get("CAPTURE_BUCKET") ?? "gate-captures";
// Only for the fallback when a capture cannot be downloaded: Telegram then
// fetches it from a signed URL, which has to outlive the sendPhoto call.
const SIGNED_URL_TTL_S = Number(Deno.env.get("SIGNED_URL_TTL_S") ?? "3600");
// Telegram throttles bursts across many chats. A morning rush is hundreds of
// taps; pacing here is cheaper than handling 429s for all of them.
const GAP_MS = Number(Deno.env.get("SEND_GAP_MS") ?? "60");
// A stand-in photo for scans that carry none, so the photo message can be seen
// and approved before the camera exists. Empty (the default) means every such
// scan stays a text message, which is what a live school must keep getting:
// this is opt-in per deployment, never on by accident.
//
//   supabase secrets set SAMPLE_PHOTO="https://placehold.co/640x480.jpg?text=Gate+Camera+Sample"
//
// Either an http(s) URL Telegram can fetch, or an object path inside the
// capture bucket, which is signed exactly like a real capture would be. Delete
// this and its three uses the day the camera lands.
const SAMPLE_PHOTO = (Deno.env.get("SAMPLE_PHOTO") ?? "").trim();

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { db: { schema: "pta" }, auth: { persistSession: false } },
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Constant-time-ish compare so a wrong secret leaks nothing by timing. */
function secretOk(req: Request): boolean {
  const want = Deno.env.get("WEBHOOK_SECRET");
  if (!want) return false;
  const got = req.headers.get("x-webhook-secret") ?? "";
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

async function mark(
  job: Job,
  status: "sent" | "failed",
  error: string | null,
  deactivate = false,
) {
  const { error: e } = await db.rpc("mark_notification", {
    p_event_id: job.event_id,
    p_guardian_id: job.guardian_id,
    p_status: status,
    p_error: error,
    p_deactivate: deactivate,
  });
  if (e) console.error("mark_notification failed", job.event_id, e.message);
}

/** What sendPhoto takes: the JPEG bytes, a Telegram file_id, or a URL. */
type Photo = Blob | string;

/**
 * A capture path becomes its bytes, read straight from storage by this
 * function and uploaded to Telegram in the sendPhoto request itself. That is
 * faster than handing Telegram a signed URL, which it would have to turn round
 * and fetch before it could send anything. A URL (the sample photo) stays a
 * URL. If the download fails, a signed URL is the fallback.
 */
async function loadPhoto(pathOrUrl: string): Promise<Photo | null> {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;

  const { data: bytes, error: dlErr } = await db.storage.from(BUCKET).download(pathOrUrl);
  if (bytes) return bytes;
  console.warn("download failed, trying a signed URL", pathOrUrl, dlErr?.message);

  const { data, error } = await db.storage
    .from(BUCKET)
    .createSignedUrl(pathOrUrl, SIGNED_URL_TTL_S);

  if (error || !data?.signedUrl) {
    console.warn("sign failed", pathOrUrl, error?.message);
    return null;
  }
  return data.signedUrl;
}

/**
 * One request's photos, by source. A student's guardians all get the same
 * picture: the first send uploads it, and Telegram's file_id from that send
 * serves every guardian after, with nothing uploaded again.
 */
type PhotoCache = Map<string, Photo | null>;

// Matches retry_notifications()'s default: below it, a failed send may still
// be retried and needs its photo.
const MAX_ATTEMPTS = 5;

/** True while some guardian's message for this scan may still be (re)sent. */
async function photoStillNeeded(eventId: string): Promise<boolean> {
  const { count, error } = await db
    .from("gate_notifications")
    .select("event_id", { count: "exact", head: true })
    .eq("event_id", eventId)
    .in("status", ["sending", "failed"])
    .lt("attempts", MAX_ATTEMPTS);
  if (error) {
    console.warn("could not check pending notifications; keeping the photo", eventId, error.message);
    return true;
  }
  return (count ?? 0) > 0;
}

/**
 * Deletes a scan's photo, then forgets its path. In that order: if the second
 * step fails, the row still names the photo, so the sweep below finds it and
 * tries again (removing an object that is already gone is not an error).
 */
async function forgetPhoto(eventId: string, path: string): Promise<void> {
  const { error } = await db.storage.from(BUCKET).remove([path]);
  if (error) {
    console.warn("could not delete photo", path, error.message);
    return;
  }
  const { error: e } = await db.rpc("forget_capture", { p_event_id: eventId });
  if (e) console.warn("forget_capture failed", eventId, e.message);
}

/**
 * The safety net: photos left behind by a send that failed for good, a crash,
 * or a scan nobody was told about, once older than the school's
 * capture_retention_days. Runs on every call, so it needs no cron of its own.
 */
async function sweepExpiredPhotos(): Promise<void> {
  const { data, error } = await db.rpc("expired_captures", { p_limit: 50 });
  if (error) {
    console.warn("expired_captures", error.message);
    return;
  }
  for (const row of (data ?? []) as { event_id: string; image_path: string }[]) {
    await forgetPhoto(row.event_id, row.image_path);
  }
}

async function deliver(job: Job, photos: PhotoCache): Promise<"sent" | "failed"> {
  const sample = !job.image_path && SAMPLE_PHOTO !== "";
  const source = job.image_path ?? (sample ? SAMPLE_PHOTO : null);
  // The label is part of the photo, so it goes on whichever message carries it
  // and comes off again on any fallback to text.
  const text = caption(job, { samplePhoto: sample });
  let result;

  let photo: Photo | null = null;
  if (source) {
    if (!photos.has(source)) photos.set(source, await loadPhoto(source));
    photo = photos.get(source) ?? null;
  }
  if (photo) {
    result = await sendPhoto(job.chat_id, photo, text);
    if (result.ok && result.fileId && source) photos.set(source, result.fileId);
    if (!result.ok && !result.blocked) {
      // Telegram rejected the image or could not fetch the URL. The arrival
      // still needs reporting.
      console.warn("sendPhoto failed, falling back to text", result.error);
      result = await sendMessage(job.chat_id, caption(job));
    }
  } else {
    // The photo is corroboration, not the record. Losing it must never cost
    // the parent the notification itself.
    result = await sendMessage(job.chat_id, caption(job));
  }

  if (result.ok) {
    await mark(job, "sent", null);
    return "sent";
  }

  await mark(job, "failed", result.error, result.blocked);
  if (result.retryAfterS) await sleep(Math.min(result.retryAfterS, 30) * 1000);
  return "failed";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!secretOk(req)) return new Response("forbidden", { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  let jobs: Job[] = [];
  // Every photo this call touched, by event: candidates for deletion once
  // their messages are done.
  const captures = new Map<string, string>();

  if (body.mode === "retry") {
    const { data, error } = await db.rpc("retry_notifications", {
      p_older_than_s: Number(body.older_than_s ?? 120),
      p_max_attempts: Number(body.max_attempts ?? 5),
      p_limit: Number(body.limit ?? 100),
    });
    if (error) {
      console.error("retry_notifications", error.message);
      return new Response(error.message, { status: 500 });
    }
    // retry_notifications() already returns event_id, so these are complete.
    jobs = (data ?? []) as Job[];
  } else {
    const record = (body.record ?? body) as Record<string, unknown>;
    const eventId = record.event_id as string | undefined;
    if (!eventId) return new Response("no event_id", { status: 400 });

    // Returns only rows it newly inserted, so a webhook that fires twice sends
    // nothing the second time. Suppressed (too stale) events come back empty.
    const { data, error } = await db.rpc("claim_notifications", {
      p_event_id: eventId,
    });
    if (error) {
      console.error("claim_notifications", error.message);
      return new Response(error.message, { status: 500 });
    }
    jobs = (data ?? []).map((r: Record<string, unknown>) => ({
      ...r,
      event_id: eventId,
    })) as Job[];
    // Even with nobody to tell (no linked guardian, a stale scan), the photo
    // has served its purpose.
    if (typeof record.image_path === "string" && record.image_path) {
      captures.set(eventId, record.image_path);
    }
  }
  for (const job of jobs) if (job.image_path) captures.set(job.event_id, job.image_path);

  let sent = 0, failed = 0;
  const photos: PhotoCache = new Map();
  for (const job of jobs) {
    const outcome = await deliver(job, photos);
    outcome === "sent" ? sent++ : failed++;
    if (GAP_MS > 0) await sleep(GAP_MS);
  }

  // After the sends, so deleting never delays a parent's message.
  let deleted = 0;
  for (const [eventId, path] of captures) {
    if (await photoStillNeeded(eventId)) continue;
    await forgetPhoto(eventId, path);
    deleted++;
  }
  await sweepExpiredPhotos();

  return Response.json({ claimed: jobs.length, sent, failed, photos_deleted: deleted });
});
