"use client";
import type { RosterEntry } from "@/lib/types";

export function RosterPanel({
  roster, tz, present,
}: {
  roster: RosterEntry[];
  tz: string;
  present: number;
}) {
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(iso));

  return (
    <section className="border border-rule bg-surface/40">
      <header className="flex items-baseline justify-between border-b border-rule px-5 py-3">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-paper">
          Roster
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          {present} / {roster.length} in
        </span>
      </header>

      <ul className="max-h-[560px] divide-y divide-rule-soft overflow-y-auto">
        {roster.length === 0 && (
          <li className="px-5 py-10 text-center font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
            No students enrolled this school year
          </li>
        )}
        {roster.map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-surface-2"
          >
            <div className="min-w-0">
              <div className={`truncate text-sm ${s.arrivedAt ? "text-paper" : "text-muted"}`}>
                {s.name}
              </div>
              <div className="font-mono text-[10px] tracking-wider text-muted">
                {[s.studentNo, [s.gradeLevel, s.section].filter(Boolean).join(" · ")]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </div>
            </div>
            <div className="shrink-0 text-right">
              {s.arrivedAt ? (
                <>
                  <div
                    className={`font-mono text-sm tabular ${s.estimated ? "text-amber" : "text-signal"}`}
                    title={s.estimated ? "Reconstructed from device uptime" : undefined}
                  >
                    {fmt(s.arrivedAt)}
                  </div>
                  {(s.late || s.estimated) && (
                    <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted">
                      {s.estimated ? "est." : "late-sync"}
                    </div>
                  )}
                </>
              ) : (
                <div className="font-mono text-sm text-rule">— — : — —</div>
              )}
            </div>
          </li>
        ))}
      </ul>

      <footer className="border-t border-rule px-5 py-3">
        <p className="text-[11px] leading-relaxed text-muted">
          Arrival = first scan of the day. One reader cannot tell entry from
          exit, so this is a rule applied here, not a measurement.
        </p>
      </footer>
    </section>
  );
}
