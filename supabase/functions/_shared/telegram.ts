// Thin Telegram Bot API wrapper. Deliberately small: the interesting decisions
// (who to tell, whether an event is too stale to be worth telling them about)
// live in SQL, so this file only knows how to put bytes on the wire.

const API = "https://api.telegram.org";

export type SendResult =
  // fileId: Telegram's id for a photo it now hosts. Sending that id again
  // reuses its copy, with no upload at all.
  | { ok: true; fileId?: string }
  // `blocked` means stop trying this recipient forever, not "retry later".
  | { ok: false; retryAfterS?: number; blocked: boolean; error: string };

function token(): string {
  const t = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  return t;
}

/** Telegram's HTML parse mode only cares about these three. */
export function esc(s: string | null | undefined): string {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Permanent conditions. Retrying these just burns attempts and, in the
// blocked-by-user case, keeps messaging someone who has opted out at their end.
const PERMANENT = [
  "bot was blocked by the user",
  "user is deactivated",
  "chat not found",
  "bot can't initiate conversation",
  "peer_id_invalid",
];

async function call(method: string, body: Record<string, unknown> | FormData): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token()}/${method}`, body instanceof FormData
      // multipart: fetch sets the Content-Type with its boundary itself.
      ? { method: "POST", body }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    return { ok: false, blocked: false, error: `network: ${e}` };
  }

  if (res.ok) {
    try {
      // A photo comes back in several sizes; the last is the largest.
      const sizes = (await res.json())?.result?.photo;
      const fileId = Array.isArray(sizes) ? sizes.at(-1)?.file_id : undefined;
      return typeof fileId === "string" ? { ok: true, fileId } : { ok: true };
    } catch {
      return { ok: true };
    }
  }

  const text = await res.text();
  let description = text;
  let retryAfterS: number | undefined;
  try {
    const j = JSON.parse(text);
    description = j.description ?? text;
    retryAfterS = j.parameters?.retry_after;
  } catch { /* keep the raw body */ }

  const lower = description.toLowerCase();
  return {
    ok: false,
    retryAfterS,
    blocked: PERMANENT.some((p) => lower.includes(p)),
    error: `${res.status} ${description}`.slice(0, 500),
  };
}

export function sendMessage(chatId: string, html: string) {
  return call("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

/**
 * `photo` is one of:
 *  - the JPEG bytes, uploaded in this request: the fastest first send, since
 *    Telegram does not have to turn round and fetch anything;
 *  - a file_id from an earlier send, which reuses Telegram's own copy;
 *  - an http(s) URL, which Telegram fetches (the sample photo).
 */
export function sendPhoto(chatId: string, photo: Blob | string, captionHtml: string) {
  const caption = captionHtml.slice(0, 1024); // Telegram's caption cap
  if (typeof photo === "string") {
    return call("sendPhoto", { chat_id: chatId, photo, caption, parse_mode: "HTML" });
  }
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("photo", photo, "gate.jpg");
  form.set("caption", caption);
  form.set("parse_mode", "HTML");
  return call("sendPhoto", form);
}
