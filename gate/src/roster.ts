import type { DatabaseSync } from 'node:sqlite';
import { getMeta, setMeta, tx } from './db.ts';
import type { Log } from './log.ts';
import { explainFailure, type Rpc } from './supabase.ts';

export interface Student {
  student_id: string;
  full_name: string;
  student_no: string | null;
  grade_level: string | null;
  section_name: string | null;
}

export interface Snapshot {
  school_id: string;
  device_id: string;
  generated_at: string;
  students: Student[];
  cards: { card_uid: string; student_id: string }[];
}

export const RESYNC_MIN_GAP_MS = 60_000;
export const STALE_AFTER_MS = 3_600_000;

// The local copy of pta.gate_roster the screen reads from. It is ADVISORY: a
// card it does not know still queues and uploads, and attendance_resolved
// names the student server-side. It exists so the screen works offline.
export class RosterMirror {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // Wholesale, in one transaction: a few thousand rows, so diffing would be
  // complexity for nothing, and a reader never sees half a roster.
  replace(snap: Snapshot, syncedAt: string): void {
    tx(this.#db, () => {
      this.#db.exec('delete from cards; delete from roster;');
      const student = this.#db.prepare(
        'insert into roster (student_id, full_name, student_no, grade_level, section_name) values (?, ?, ?, ?, ?)',
      );
      for (const s of snap.students) {
        student.run(s.student_id, s.full_name, s.student_no ?? null, s.grade_level ?? null, s.section_name ?? null);
      }
      const card = this.#db.prepare('insert or replace into cards (card_uid, student_id) values (?, ?)');
      for (const c of snap.cards) card.run(c.card_uid, c.student_id);
      setMeta(this.#db, 'roster_synced_at', syncedAt);
    });
  }

  lookup(uid: string): Student | null {
    const row = this.#db
      .prepare(
        `select r.student_id, r.full_name, r.student_no, r.grade_level, r.section_name
           from cards c join roster r on r.student_id = c.student_id
          where c.card_uid = ?`,
      )
      .get(uid) as Student | undefined;
    return row ? { ...row } : null;
  }

  studentCount(): number {
    return (this.#db.prepare('select count(*) as n from roster').get() as { n: number }).n;
  }

  syncedAt(): string | null {
    return getMeta(this.#db, 'roster_synced_at');
  }
}

export type SyncResult = 'ok' | 'failed' | 'refused-empty';

export class RosterSync {
  #mirror: RosterMirror;
  #rpc: Rpc;
  #deviceId: string;
  #token: string;
  #log: Log;
  #lastAttemptMs = -Infinity;
  #inFlight: Promise<SyncResult> | null = null;

  constructor(mirror: RosterMirror, rpc: Rpc, deviceId: string, token: string, log: Log) {
    this.#mirror = mirror;
    this.#rpc = rpc;
    this.#deviceId = deviceId;
    this.#token = token;
    this.#log = log;
  }

  sync(nowMs = Date.now()): Promise<SyncResult> {
    if (this.#inFlight) return this.#inFlight;
    this.#lastAttemptMs = nowMs;
    this.#inFlight = this.#doSync(nowMs).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  // An unknown card might have been enrolled a minute ago, so ask again --
  // but not more than once a minute, or a burst of strangers hammers the RPC.
  requestResync(nowMs = Date.now()): boolean {
    if (nowMs - this.#lastAttemptMs < RESYNC_MIN_GAP_MS) return false;
    void this.sync(nowMs);
    return true;
  }

  isStale(nowMs = Date.now()): boolean {
    const at = this.#mirror.syncedAt();
    return at === null || nowMs - Date.parse(at) > STALE_AFTER_MS;
  }

  async #doSync(nowMs: number): Promise<SyncResult> {
    const res = await this.#rpc('gate_roster_snapshot', { p_device_id: this.#deviceId, p_token: this.#token });
    if (res.status < 200 || res.status >= 300) {
      this.#log(`[roster] sync FAILED http=${res.status} ${res.body.slice(0, 200)} -- keeping the last good mirror`);
      const hint = explainFailure(res.body, this.#deviceId);
      if (hint) this.#log(`[roster] hint: ${hint}`);
      return 'failed';
    }

    let snap: Snapshot;
    try {
      snap = JSON.parse(res.body) as Snapshot;
      if (!Array.isArray(snap?.students) || !Array.isArray(snap?.cards)) throw new Error('no students/cards arrays');
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.#log(`[roster] sync FAILED: unreadable snapshot (${why}) -- keeping the last good mirror`);
      return 'failed';
    }

    const have = this.#mirror.studentCount();
    if (snap.students.length === 0 && have > 0) {
      this.#log(
        `[roster] snapshot has NO students but the mirror has ${have}; refusing to blank the screen. ` +
          "Check the school's active school year in PTA Collections.",
      );
      return 'refused-empty';
    }

    this.#mirror.replace(snap, new Date(nowMs).toISOString());
    this.#log(`[roster] synced ${snap.students.length} students, ${snap.cards.length} cards`);
    return 'ok';
  }
}
