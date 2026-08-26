// The gate is in the Philippines; the database stores UTC. Computing "today"
// on the UTC boundary would roll the school day over at 8am local, so every
// day-bounded figure on this dashboard goes through here.
export const SCHOOL_TZ = process.env.SCHOOL_TZ ?? "Asia/Manila";

function tzOffsetMs(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(
    dtf.formatToParts(at).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const asUTC = Date.UTC(
    +p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second,
  );
  return asUTC - at.getTime();
}

/** The UTC instant at which the current local school day began. */
export function startOfSchoolDay(at: Date = new Date()): Date {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHOOL_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at).split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  return new Date(guess - tzOffsetMs(SCHOOL_TZ, new Date(guess)));
}

export function timeOfDay(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: SCHOOL_TZ, hour: "2-digit", minute: "2-digit",
    second: "2-digit", hour12: false,
  }).format(new Date(iso));
}
