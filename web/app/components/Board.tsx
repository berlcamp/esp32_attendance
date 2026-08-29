"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FeedPayload } from "@/lib/types";
import { StatTile } from "./StatTile";
import { StationClock } from "./StationClock";
import { GateFeed } from "./GateFeed";
import { RosterPanel } from "./RosterPanel";
import { SetupNotice } from "./SetupNotice";

const POLL_MS = 4000;

function GateStatus({ seconds }: { seconds: number | null }) {
  let tone = "text-muted", dot = "bg-rule", label = "awaiting first scan";
  if (seconds !== null) {
    if (seconds < 30) { tone = "text-signal"; dot = "bg-signal pulse"; label = "live"; }
    else if (seconds < 300) { tone = "text-amber"; dot = "bg-amber"; label = "idle"; }
    else { tone = "text-alarm"; dot = "bg-alarm"; label = "no contact"; }
  }
  const ago =
    seconds === null ? "" :
    seconds < 60 ? `${Math.floor(seconds)}s ago` :
    seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` :
    `${Math.floor(seconds / 3600)}h ago`;

  return (
    <div className="flex items-center gap-2.5 border border-rule px-3 py-2">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className={`font-mono text-[10px] uppercase tracking-[0.2em] ${tone}`}>
        {label}
      </span>
      {ago && <span className="font-mono text-[10px] tracking-wider text-muted">{ago}</span>}
    </div>
  );
}

export function Board() {
  const [data, setData] = useState<FeedPayload | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;

    const tick = async () => {
      try {
        const res = await fetch("/api/feed", { cache: "no-store" });
        const json: FeedPayload = await res.json();
        if (!alive) return;

        // Animate only rows we have not rendered before, so a poll does not
        // make the whole board flap every four seconds.
        const incoming = new Set<string>();
        for (const r of json.feed ?? []) {
          if (!seen.current.has(r.event_id)) incoming.add(r.event_id);
        }
        if (seen.current.size === 0) incoming.clear(); // first paint: no flap
        for (const r of json.feed ?? []) seen.current.add(r.event_id);

        setFresh(incoming);
        setData(json);
        setNetError(null);
      } catch (e) {
        if (alive) setNetError(e instanceof Error ? e.message : "network error");
      }
    };

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const tz = data?.tz ?? "Asia/Manila";
  // Distinct unknown UIDs waiting to be bound to a student.
  const unknownCount = data?.stats?.unknownCards?.length ?? 0;
  const s = data?.stats;
  const flagged = (s?.lateSync ?? 0) + (s?.inferredTime ?? 0);

  return (
    <main className="mx-auto min-h-screen w-full max-w-[1400px] px-6 py-10 sm:px-10">
      {/* Masthead ---------------------------------------------------------- */}
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.4em] text-amber">
            {data?.gate?.deviceId ?? "gate-01"} · school gate
          </div>
          <h1 className="mt-2 text-5xl font-extrabold leading-[0.9] tracking-[-0.03em] text-paper sm:text-6xl">
            Smart<span className="text-amber">.</span>Campus
          </h1>
          <p className="mt-3 max-w-md text-sm text-muted">
            Live attendance as cards pass the gate.
          </p>
        </div>
        <div className="flex items-end gap-5">
          <Link
            href="/enroll"
            className="border border-rule px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted transition-colors hover:border-amber hover:text-amber"
          >
            Enrol cards
            {unknownCount > 0 && (
              <span className="ml-2 text-amber">{unknownCount}</span>
            )}
          </Link>
          <GateStatus seconds={data?.gate?.secondsSince ?? null} />
          <StationClock tz={tz} />
        </div>
      </header>

      <div className="livewire my-8" />

      {/* Not-connected states --------------------------------------------- */}
      {data && !data.configured && (
        <SetupNotice error={data.error ?? "Not configured"} hint={data.hint} />
      )}
      {data?.configured && data.error && (
        <SetupNotice error={data.error} hint={data.hint} />
      )}
      {netError && !data && (
        <SetupNotice error={`Cannot reach /api/feed — ${netError}`} />
      )}

      {data?.configured && !data.error && (
        <>
          <div className="grid grid-cols-2 gap-px bg-rule lg:grid-cols-4">
            <StatTile
              label="Present today"
              value={`${s!.present}`}
              sub={`of ${s!.enrolled} enrolled`}
              accent="signal"
              bar={s!.enrolled ? s!.present / s!.enrolled : 0}
            />
            <StatTile label="Scans today" value={`${s!.scansToday}`} sub="card reads at the gate" />
            <StatTile
              label="Unregistered"
              value={`${s!.unknownScans}`}
              sub={s!.unknownCards.length ? s!.unknownCards.join(" · ") : "all cards known"}
              accent={s!.unknownScans ? "amber" : "paper"}
            />
            <StatTile
              label="Qualified rows"
              value={`${flagged}`}
              sub={`${s!.lateSync} late-sync · ${s!.inferredTime} est. time`}
              accent={flagged ? "alarm" : "paper"}
            />
          </div>

          <div className="mt-8 grid grid-cols-1 gap-8 xl:grid-cols-[1.85fr_1fr]">
            <GateFeed rows={data.feed} tz={tz} freshIds={fresh} />
            <RosterPanel roster={data.roster} tz={tz} present={s!.present} />
          </div>

          <footer className="mt-10 border-t border-rule pt-5">
            <p className="max-w-3xl text-[11px] leading-relaxed text-muted">
              A row records that <span className="text-paper">a card passed the gate</span> — not
              that a student was present. Times shown in{" "}
              <span className="text-amber">amber with a dotted underline</span> were reconstructed
              from device uptime after a power cut, not measured.{" "}
              <span className="text-amber">Late-sync</span> rows arrived after a network outage.
              Refreshing every {POLL_MS / 1000}s.
            </p>
          </footer>
        </>
      )}

      {!data && !netError && (
        <div className="py-24 text-center font-mono text-[11px] uppercase tracking-[0.3em] text-muted">
          Connecting to board…
        </div>
      )}
    </main>
  );
}
