// ===========================================================================
// gate-capture
//
// Takes the JPEG the gate camera shot at a tap and puts it in the private
// capture bucket, returning the object path the gate then sends to
// record_attendance() as image_path. notify-guardian sends the photo with the
// parent's Telegram message, then deletes it.
//
// Why a function and not a storage policy: the gate holds the anon key, which
// is the shared project's PUBLIC key. A write policy for anon on gate-captures
// would let anyone fill the bucket. The gate's own secret (GATE_TOKEN, the one
// gate_roster_snapshot() already checks) is verified here with service_role,
// and storage.objects keeps having no gate-captures policy for anon at all.
//
//   POST /functions/v1/gate-capture
//   x-device-id: gate-01-pc
//   x-gate-token: gt_...
//   x-event-id: <the scan's uuid>
//   Content-Type: image/jpeg
//   <jpeg bytes>
//   -> 200 {"path":"<school_id>/<device_id>/<event_id>.jpg"}
//
// Idempotent: a retry of the same event overwrites the same object.
//
// Deploy:
//   supabase functions deploy gate-capture --no-verify-jwt
// ===========================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = Deno.env.get("CAPTURE_BUCKET") ?? "gate-captures";
// A 640x480 frame at the gate's quality is ~40-80 KB. Anything near this is
// not a gate capture.
const MAX_BYTES = 1_000_000;
const DEVICE_ID = /^[a-z0-9][a-z0-9._-]{1,62}$/;
const GATE_TOKEN = /^gt_[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { db: { schema: "pta" }, auth: { persistSession: false } },
);

/** Same hash as pta.gate_token_hash(): hex SHA-256 of the UTF-8 token. */
async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const fail = (status: number, error: string) => Response.json({ error }, { status });

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail(405, "method not allowed");

  const deviceId = req.headers.get("x-device-id") ?? "";
  const token = req.headers.get("x-gate-token") ?? "";
  const eventId = (req.headers.get("x-event-id") ?? "").toLowerCase();
  if (!DEVICE_ID.test(deviceId) || !GATE_TOKEN.test(token) || !UUID.test(eventId)) {
    return fail(400, "x-device-id, x-gate-token and x-event-id are required");
  }

  const { data: device, error } = await db
    .from("gate_devices")
    .select("school_id, token_hash, active")
    .eq("device_id", deviceId)
    .maybeSingle();
  if (error) {
    console.error("gate_devices", error.message);
    return fail(500, "device lookup failed");
  }
  // One answer for every way of being wrong, so it says nothing about which
  // device ids exist.
  if (!device || !device.active || !device.token_hash ||
      !sameString(await tokenHash(token), device.token_hash)) {
    return fail(403, "invalid gate device credentials");
  }

  const jpeg = new Uint8Array(await req.arrayBuffer());
  if (jpeg.length > MAX_BYTES) return fail(413, "image too large");
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) {
    return fail(415, "body is not a JPEG");
  }

  // Tenant first, like every other bucket in this project.
  const path = `${device.school_id}/${deviceId}/${eventId}.jpg`;
  const { error: upErr } = await db.storage
    .from(BUCKET)
    .upload(path, jpeg, { contentType: "image/jpeg", upsert: true });
  if (upErr) {
    console.error("upload", path, upErr.message);
    return fail(502, "upload failed");
  }

  return Response.json({ path });
});
