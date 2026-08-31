"use client";

import { useEffect, useMemo, useState } from "react";

const POLL_MS = 3000;

type UnassignedCard = { cardUid: string; lastSeenAt: string; scans: number };
type EnrollStudent = {
  id: string;
  name: string;
  studentNo: string | null;
  gradeLevel: string | null;
  section: string | null;
  cards: string[];
};
type EnrollPayload = {
  configured: boolean;
  error: string | null;
  school: string | null;
  unassigned: UnassignedCard[];
  students: EnrollStudent[];
};

/** Pure fetch, no state: both the poll and the mutation handlers reuse it. */
async function fetchPayload(): Promise<EnrollPayload | null> {
  try {
    const res = await fetch("/api/enroll", { cache: "no-store" });
    return (await res.json()) as EnrollPayload;
  } catch {
    return null; // transient; the next poll picks it up
  }
}

function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return `${Math.max(0, Math.floor(s))}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function classOf(s: EnrollStudent): string {
  return [s.gradeLevel, s.section].filter(Boolean).join(" · ");
}

export function EnrollPanel() {
  const [data, setData] = useState<EnrollPayload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [studentId, setStudentId] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  // Selection is held by uid rather than by list position, so a poll landing
  // mid-assignment cannot yank the card out from under the operator.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const json = await fetchPayload();
      if (alive && json) setData(json);
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const refresh = async () => {
    const json = await fetchPayload();
    if (json) setData(json);
  };

  // A real school roster is hundreds of names, so this is a search box rather
  // than a <select>. Name, student number and section all match, because at a
  // gate the operator knows "Grade 7 Rizal" long before they know an LRN.
  const matches = useMemo(() => {
    const all = data?.students ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((s) =>
      [s.name, s.studentNo ?? "", classOf(s)].join(" ").toLowerCase().includes(q),
    );
  }, [data?.students, query]);

  const chosen = data?.students.find((s) => s.id === studentId) ?? null;

  const submit = async () => {
    if (!selected || !studentId) return;
    setBusy(true);
    setFlash(null);
    try {
      const res = await fetch("/api/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardUid: selected, studentId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setFlash({ tone: "bad", text: json.error ?? "Assignment failed" });
      } else {
        const who = chosen?.name ?? "student";
        setFlash({
          tone: "ok",
          text: json.replaced
            ? `${selected} reassigned to ${who}. Earlier scans still resolve to the previous holder.`
            : `${selected} assigned to ${who}.`,
        });
        setSelected(null);
        setStudentId("");
        setQuery("");
        await refresh();
      }
    } catch (e) {
      setFlash({ tone: "bad", text: e instanceof Error ? e.message : "Network error" });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (cardUid: string) => {
    setBusy(true);
    try {
      await fetch("/api/enroll", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardUid }),
      });
      await refresh();
      setFlash({ tone: "ok", text: `${cardUid} retired. It will read as unknown from now on.` });
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !!selected && !!studentId && !busy;

  if (data && (!data.configured || data.error)) {
    return (
      <p className="border border-alarm/40 bg-alarm/5 px-5 py-4 font-mono text-[11px] leading-relaxed text-alarm">
        {data.error}
      </p>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {/* ---- Unknown cards ------------------------------------------------ */}
      <section className="border border-rule bg-surface/40">
        <header className="flex items-baseline justify-between border-b border-rule px-5 py-3">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-paper">
            Unassigned cards
          </h2>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            {data?.unassigned.length ?? 0} seen
          </span>
        </header>

        <p className="border-b border-rule-soft px-5 py-3 font-mono text-[10px] leading-relaxed tracking-wider text-muted">
          Tap a card on the gate reader. It arrives here within a few seconds
          because the gate records every scan, known or not.
        </p>

        <ul className="max-h-[420px] divide-y divide-rule-soft overflow-y-auto">
          {(data?.unassigned.length ?? 0) === 0 && (
            <li className="px-5 py-10 text-center font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
              Waiting for an unknown card
            </li>
          )}
          {data?.unassigned.map((c) => {
            const active = c.cardUid === selected;
            return (
              <li key={c.cardUid}>
                <button
                  type="button"
                  onClick={() => setSelected(active ? null : c.cardUid)}
                  className={`flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition-colors ${
                    active ? "bg-amber/10" : "hover:bg-surface-2"
                  }`}
                >
                  <span
                    className={`font-mono text-sm tracking-[0.16em] ${
                      active ? "text-amber" : "text-paper"
                    }`}
                  >
                    {c.cardUid}
                  </span>
                  <span className="shrink-0 text-right font-mono text-[10px] tracking-wider text-muted">
                    {ago(c.lastSeenAt)}
                    {c.scans > 1 && ` · ${c.scans} scans`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ---- Assignment --------------------------------------------------- */}
      <section className="border border-rule bg-surface/40">
        <header className="flex items-baseline justify-between border-b border-rule px-5 py-3">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-paper">
            Assign to student
          </h2>
          {data?.school && (
            <span className="truncate font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
              {data.school}
            </span>
          )}
        </header>

        <div className="space-y-5 px-5 py-5">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
              Card
            </span>
            <span
              className={`font-mono text-sm tracking-[0.16em] ${
                selected ? "text-amber" : "text-muted"
              }`}
            >
              {selected ?? "— pick one on the left —"}
            </span>
          </div>

          <div className="space-y-2">
            <label className="block space-y-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
                Student
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, student number or section…"
                className="w-full border border-rule bg-ink px-3 py-2 text-sm text-paper outline-none placeholder:text-muted/50 focus:border-amber"
              />
            </label>

            <ul className="max-h-[220px] divide-y divide-rule-soft overflow-y-auto border border-rule">
              {matches.length === 0 && (
                <li className="px-4 py-6 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
                  {(data?.students.length ?? 0) === 0
                    ? "No students enrolled this school year"
                    : "No match"}
                </li>
              )}
              {matches.map((s) => {
                const active = s.id === studentId;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setStudentId(active ? "" : s.id)}
                      className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors ${
                        active ? "bg-amber/10" : "hover:bg-surface-2"
                      }`}
                    >
                      <span className="min-w-0">
                        <span
                          className={`block truncate text-sm ${
                            active ? "text-amber" : "text-paper"
                          }`}
                        >
                          {s.name}
                        </span>
                        <span className="block font-mono text-[10px] tracking-wider text-muted">
                          {[s.studentNo, classOf(s)].filter(Boolean).join(" · ") || "—"}
                        </span>
                      </span>
                      {s.cards.length > 0 && (
                        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
                          holds {s.cards.length}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* The gate binds plastic to people; it does not invent people. A
                student created here would have no enrolment, so no school year,
                no section and no student number — invisible in PTA Collections. */}
            <p className="font-mono text-[10px] leading-relaxed tracking-wider text-muted">
              Student not listed? Add them in PTA Collections. This board shows
              the roster for the active school year and does not create students.
            </p>
          </div>

          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="w-full border border-amber bg-amber/10 px-4 py-3 font-mono text-[11px] uppercase tracking-[0.24em] text-amber transition-colors hover:bg-amber/20 disabled:border-rule disabled:bg-transparent disabled:text-muted"
          >
            {busy ? "Working…" : "Assign card"}
          </button>

          {flash && (
            <p
              className={`border px-4 py-3 font-mono text-[10px] leading-relaxed tracking-wider ${
                flash.tone === "ok"
                  ? "border-signal/40 bg-signal/5 text-signal"
                  : "border-alarm/40 bg-alarm/5 text-alarm"
              }`}
            >
              {flash.text}
            </p>
          )}
        </div>

        {/* ---- Who holds what --------------------------------------------- */}
        <header className="border-y border-rule px-5 py-3">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-paper">
            Cards issued
          </h2>
        </header>
        <ul className="max-h-[300px] divide-y divide-rule-soft overflow-y-auto">
          {data?.students.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm text-paper">{s.name}</div>
                <div className="font-mono text-[10px] tracking-wider text-muted">
                  {[s.studentNo, classOf(s)].filter(Boolean).join(" · ") || "—"}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                {s.cards.length === 0 && (
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
                    no card
                  </span>
                )}
                {s.cards.map((uid) => (
                  <button
                    key={uid}
                    type="button"
                    disabled={busy}
                    onClick={() => revoke(uid)}
                    title="Retire this card"
                    className="border border-rule px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-paper transition-colors hover:border-alarm hover:text-alarm"
                  >
                    {uid} ×
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
