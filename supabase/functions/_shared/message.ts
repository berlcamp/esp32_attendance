import { esc } from "./telegram.ts";

export const SCHOOL_TZ = Deno.env.get("SCHOOL_TZ") ?? "Asia/Manila";
export const SCHOOL_NAME = Deno.env.get("SCHOOL_NAME") ?? "the school gate";

export type Job = {
  event_id: string;
  guardian_id: string;
  chat_id: string;
  guardian_name: string | null;
  student_name: string | null;
  student_no: string | null;
  scanned_at: string;
  image_path: string | null;
  clock_synced: boolean;
  delivery_class: "fresh" | "delayed";
  delay_s: number;
};

function clockTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: SCHOOL_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

function dayLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: SCHOOL_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(iso));
}

function isToday(iso: string): boolean {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHOOL_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date(iso)) === fmt.format(new Date());
}

/**
 * Every caveat the database knows about a timestamp gets said out loud. A
 * parent who is told "7:02 AM" for a scan the device reconstructed from uptime
 * after a power cut has been told something we do not actually know.
 */
export function caption(job: Job): string {
  const who = esc(job.student_name ?? "A student");
  const when = clockTime(job.scanned_at);
  const day = isToday(job.scanned_at) ? "" : ` on ${esc(dayLabel(job.scanned_at))}`;

  const lines = [
    `<b>${who}</b> passed ${esc(SCHOOL_NAME)} at <b>${esc(when)}</b>${day}.`,
  ];

  if (job.delivery_class === "delayed") {
    const mins = Math.round(job.delay_s / 60);
    lines.push(
      `<i>Delayed notification — the gate was offline and reported this ${mins} minute${mins === 1 ? "" : "s"} late.</i>`,
    );
  }

  if (!job.clock_synced) {
    lines.push(
      "<i>The gate's clock had not synced yet, so this time is approximate.</i>",
    );
  }

  return lines.join("\n");
}
