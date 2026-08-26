"use client";
import { useEffect, useState } from "react";

export function StationClock({ tz }: { tz: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Rendered empty on the server so the clock cannot hydrate-mismatch.
  const time = now
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: tz, hour: "2-digit", minute: "2-digit",
        second: "2-digit", hour12: false,
      }).format(now)
    : "--:--:--";
  const date = now
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: tz, weekday: "short", day: "2-digit", month: "short",
      }).format(now).toUpperCase()
    : "";

  return (
    <div className="text-right">
      <div className="font-mono text-3xl leading-none tabular text-amber sm:text-4xl">
        {time}
      </div>
      <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
        {date} · {tz.replace("_", " ")}
      </div>
    </div>
  );
}
