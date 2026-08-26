"use client";
import type { FeedRow } from "@/lib/supabase";

function Tag({ children, tone }: { children: React.ReactNode; tone: "amber" | "alarm" }) {
  const c = tone === "amber"
    ? "border-amber/40 text-amber"
    : "border-alarm/40 text-alarm";
  return (
    <span className={`border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] ${c}`}>
      {children}
    </span>
  );
}

export function GateFeed({
  rows, tz, freshIds,
}: {
  rows: FeedRow[];
  tz: string;
  freshIds: Set<string>;
}) {
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour: "2-digit", minute: "2-digit",
      second: "2-digit", hour12: false,
    }).format(new Date(iso));

  return (
    <section className="border border-rule bg-surface/40">
      <header className="flex items-baseline justify-between border-b border-rule px-5 py-3">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-paper">
          Gate feed
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          last {rows.length}
        </span>
      </header>

      {rows.length === 0 ? (
        <div className="px-5 py-16 text-center">
          <div className="font-mono text-[11px] uppercase tracking-[0.28em] text-muted">
            No scans recorded
          </div>
          <p className="mx-auto mt-3 max-w-sm text-sm text-muted">
            The board is connected and waiting. Start the gate simulation with{" "}
            <code className="text-amber">sim on</code> over serial.
          </p>
        </div>
      ) : (
        <div className="max-h-[560px] overflow-y-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="border-b border-rule text-left">
                {["Time", "Student", "Card", "Status"].map((h) => (
                  <th key={h} className="px-5 py-2 font-mono text-[9px] uppercase tracking-[0.22em] font-normal text-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const unknown = !r.student_id;
                return (
                  <tr
                    key={r.event_id}
                    className={`border-b border-rule-soft transition-colors hover:bg-surface-2 ${
                      freshIds.has(r.event_id) ? "flap" : ""
                    } ${unknown ? "hatch" : ""}`}
                  >
                    <td className="px-5 py-3 align-middle">
                      <span
                        className={`font-mono text-sm tabular ${
                          r.clock_synced ? "text-paper" : "text-amber"
                        }`}
                        style={
                          r.clock_synced
                            ? undefined
                            : { textDecoration: "underline dotted", textUnderlineOffset: "4px" }
                        }
                        title={r.clock_synced ? undefined : "Reconstructed from device uptime — not measured"}
                      >
                        {fmt(r.scanned_at)}
                      </span>
                    </td>
                    <td className="px-5 py-3 align-middle">
                      {unknown ? (
                        <span className="font-mono text-xs uppercase tracking-[0.14em] text-amber">
                          Unregistered card
                        </span>
                      ) : (
                        <span className="text-[15px] text-paper">{r.full_name}</span>
                      )}
                      {r.student_no && (
                        <span className="ml-2 font-mono text-[10px] text-muted">{r.student_no}</span>
                      )}
                    </td>
                    <td className="px-5 py-3 align-middle font-mono text-[11px] tracking-wider text-muted">
                      {r.card_uid}
                    </td>
                    <td className="px-5 py-3 align-middle">
                      <div className="flex flex-wrap gap-1.5">
                        {r.queued && <Tag tone="amber">Late-sync</Tag>}
                        {!r.clock_synced && <Tag tone="alarm">Est. time</Tag>}
                        {!r.queued && r.clock_synced && (
                          <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted">
                            live
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
