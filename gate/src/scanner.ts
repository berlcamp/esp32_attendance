import { randomUUID } from 'node:crypto';
import type { Cooldown } from './cooldown.ts';
import type { Log } from './log.ts';
import type { ScanQueue } from './queue.ts';
import type { RosterMirror, Student } from './roster.ts';

export interface ScanView {
  uid: string;
  at: string;
  student: Student | null;
}

export interface ScannerDeps {
  deviceId: string;
  queue: Pick<ScanQueue, 'enqueue'>;
  mirror: Pick<RosterMirror, 'lookup'>;
  cooldown: Cooldown;
  clockSynced: () => boolean;
  show: (view: ScanView) => void;
  unknownCard: () => void;
  log: Log;
  now?: () => number;
  mono?: () => number;
  newId?: () => string;
}

export type ScanOutcome = 'queued' | 'cooldown' | 'dropped';

// keystrokes -> uid -> cooldown -> roster.lookup() -> SCREEN -> queue
// The screen updates first, from the local mirror, so a slow network or a
// failing disk can never make the monitor lag behind the turnstile.
export class Scanner {
  failures = 0;
  #d: Required<ScannerDeps>;

  constructor(deps: ScannerDeps) {
    this.#d = {
      now: () => Date.now(),
      mono: () => performance.now(),
      newId: () => randomUUID(),
      ...deps,
    } as Required<ScannerDeps>;
  }

  handle(uid: string): ScanOutcome {
    const d = this.#d;
    if (!d.cooldown.accept(uid, d.mono())) {
      d.log(`[scan] ${uid} ignored (cooldown)`);
      return 'cooldown';
    }

    const at = new Date(d.now()).toISOString();
    const student = d.mirror.lookup(uid);
    d.show({ uid, at, student });
    if (!student) d.unknownCard();

    let saved = false;
    try {
      saved = d.queue.enqueue({ eventId: d.newId(), cardUid: uid, deviceId: d.deviceId, scannedAt: at, clockSynced: d.clockSynced() });
    } catch (err) {
      this.failures++;
      d.log(`[scan] *** could not save ${uid}: ${err instanceof Error ? err.message : String(err)} ***`);
      return 'dropped';
    }
    if (!saved) {
      d.log(`[scan] *** QUEUE FULL -- DROPPED scan ${uid}. Oldest scans are kept; newest are refused. ***`);
      return 'dropped';
    }
    d.log(`[scan] ${uid} queued (${student ? student.full_name : 'unknown card'})`);
    return 'queued';
  }
}
