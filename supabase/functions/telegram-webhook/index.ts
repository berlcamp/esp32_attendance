// ===========================================================================
// telegram-webhook
//
// Guardian onboarding, and the only reason any of this can work at all.
//
// A Telegram bot cannot start a conversation -- the API answers
// "Forbidden: bot can't initiate conversation with a user". The guardian MUST
// message the bot first. So enrolment is: print a single-use token as a QR for
//   https://t.me/<YourSchoolBot>?start=<token>
// on the enrolment slip; the parent taps it; Telegram opens the bot and sends
// "/start <token>"; this function turns that into a linked chat_id.
//
// One tap, no typing, no support call. Expect roughly 70% of parents to
// complete it -- the dashboard needs an "unlinked guardians" list from day one.
//
// Deploy:
//   supabase functions deploy telegram-webhook --no-verify-jwt
//   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
//     -H 'Content-Type: application/json' \
//     -d '{"url":"https://<ref>.supabase.co/functions/v1/telegram-webhook",
//          "secret_token":"<TELEGRAM_WEBHOOK_SECRET>",
//          "allowed_updates":["message"]}'
// ===========================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { esc, sendMessage } from "../_shared/telegram.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { db: { schema: "mvts_esp32" }, auth: { persistSession: false } },
);

// Telegram sends this header on every update, matching the secret_token given
// to setWebhook. It is the only thing standing between this endpoint and
// anyone who guesses the URL.
function secretOk(req: Request): boolean {
  const want = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  if (!want) return false;
  return req.headers.get("x-telegram-bot-api-secret-token") === want;
}

const HELP =
  "This bot sends you a message when your child passes the school gate.\n\n" +
  "To link your account, scan the QR code on the enrolment slip the school " +
  "gave you, or tap the link on it. If you have lost it, please ask the " +
  "school office for a new one.";

async function handle(chatId: string, displayName: string, text: string) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ");

  if (cmd === "/start" && arg) {
    const { data, error } = await db.rpc("redeem_enroll_token", {
      p_token: arg,
      p_chat_id: chatId,
      p_display_name: displayName,
    });

    if (error) {
      console.error("redeem_enroll_token", error.message);
      return sendMessage(chatId, "Something went wrong. Please try again later.");
    }

    if (!data?.ok) {
      const why = {
        unknown_token: "That link was not recognised.",
        already_used: "That link has already been used.",
        expired: "That link has expired.",
      }[data?.reason as string] ?? "That link could not be used.";
      return sendMessage(
        chatId,
        `${esc(why)} Please ask the school office for a new enrolment link.`,
      );
    }

    return sendMessage(
      chatId,
      `You are now linked to <b>${esc(data.student_name)}</b>` +
        (data.student_no ? ` (${esc(data.student_no)})` : "") +
        ".\n\nYou will get a message with a photo each time they pass the " +
        "school gate. Send /stop at any time to turn these off.",
    );
  }

  if (cmd === "/stop") {
    const { data } = await db.rpc("set_notify_preference", {
      p_chat_id: chatId, p_on: false,
    });
    return sendMessage(
      chatId,
      data?.ok
        ? "Notifications are off. Send /resume to turn them back on."
        : "This chat is not linked to a student yet.",
    );
  }

  if (cmd === "/resume") {
    const { data } = await db.rpc("set_notify_preference", {
      p_chat_id: chatId, p_on: true,
    });
    return sendMessage(
      chatId,
      data?.ok
        ? "Notifications are back on."
        : "This chat is not linked to a student yet.",
    );
  }

  return sendMessage(chatId, HELP);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!secretOk(req)) return new Response("forbidden", { status: 403 });

  let update: Record<string, any>;
  try {
    update = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const msg = update.message ?? update.edited_message;
  const chatId = msg?.chat?.id;
  const text = msg?.text;

  // Always 200: a non-2xx makes Telegram redeliver the same update, and there
  // is nothing to gain from replaying something we could not parse.
  if (!chatId || typeof text !== "string") return new Response("ok");

  const from = msg.from ?? {};
  const displayName =
    [from.first_name, from.last_name].filter(Boolean).join(" ") ||
    from.username || "Guardian";

  try {
    await handle(String(chatId), displayName, text);
  } catch (e) {
    console.error("handler failed", e);
  }
  return new Response("ok");
});
