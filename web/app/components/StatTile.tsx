export function StatTile({
  label, value, sub, accent = "paper", bar,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "paper" | "amber" | "signal" | "alarm";
  bar?: number;
}) {
  const tone = {
    paper: "text-paper",
    amber: "text-amber",
    signal: "text-signal",
    alarm: "text-alarm",
  }[accent];

  return (
    <div className="relative border border-rule bg-surface/60 px-5 py-4 backdrop-blur-sm">
      <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
        {label}
      </div>
      <div className={`mt-3 font-mono text-4xl leading-none tabular ${tone}`}>
        {value}
      </div>
      {typeof bar === "number" && (
        <div className="mt-3 h-[3px] w-full bg-rule-soft">
          <div
            className="h-full bg-signal transition-[width] duration-700 ease-out"
            style={{ width: `${Math.min(100, Math.max(0, bar * 100))}%` }}
          />
        </div>
      )}
      {sub && (
        <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
          {sub}
        </div>
      )}
    </div>
  );
}
