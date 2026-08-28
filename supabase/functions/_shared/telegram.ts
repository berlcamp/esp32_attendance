// Thin Telegram Bot API wrapper. Deliberately small: the interesting decisions
// (who to tell, whether an event is too stale to be worth telling them about)
// live in SQL, so this file only knows how to put bytes on the wire.

const API = "https://api.telegram.org";

export type SendResult =
  | { ok: true }
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

async function call(method: string, body: unknown): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, blocked: false, error: `network: ${e}` };
  }

  if (res.ok) return { ok: true };

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
 * `photo` is a URL string, not bytes. Telegram fetches it once and re-hosts its
 * own copy, so the signed URL only has to outlive this call -- and we never
 * proxy the image through the function.
 */
export function sendPhoto(chatId: string, photoUrl: string, captionHtml: string) {
  return call("sendPhoto", {
    chat_id: chatId,
    photo: photoUrl,
    caption: captionHtml.slice(0, 1024), // Telegram's caption cap
    parse_mode: "HTML",
  });
}
