import { randomUUID } from 'node:crypto';
import type { Cooldown } from './cooldown.ts';
import type { Log } from './log.ts';
import type { ScanQueue } from './queue.ts';
import type { RosterMirror, Student } from './roster.ts';

export interface ScanView {
  uid: string;
  at: string;
  student: Student | null;
  // The kiosk URL of this tap's camera photo, or null if there is none.
  photo: string | null;
}

export interface ScannerDeps {
  deviceId: string;
  queue: Pick<ScanQueue, 'enqueue'>;
  mirror: Pick<RosterMirror, 'lookup'>;
  cooldown: Cooldown;
  clockSynced: () => boolean;
  show: (view: ScanView) => void;
  // Saves the camera's current frame as this scan's photo; false if there is
  // no camera or no fresh frame. Optional: a gate without a camera still works.
  capture?: (eventId: string) => boolean;
  unknownCard: () => void;
  log: Log;
  now?: () => number;
  mono?: () => number;
  newId?: () => string;
}

export type ScanOutcome = 'queued' | 'cooldown' | 'dropped';

// keystrokes -> uid -> cooldown -> camera -> roster.lookup() -> SCREEN -> queue
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
      capture: () => false,
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
    const eventId = d.newId();
    // First, while the student is still at the reader. A camera or disk
    // problem costs the photo, never the scan.
    let photo = false;
    try {
      photo = d.capture(eventId);
    } catch (err) {
      d.log(`[scan] could not save the photo for ${uid}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A failed read must not cost the scan: show it as unknown and queue it;
    // the server still resolves who it was.
    let student: Student | null = null;
    try {
      student = d.mirror.lookup(uid);
    } catch (err) {
      this.failures++;
      d.log(`[scan] *** could not look up ${uid}: ${err instanceof Error ? err.message : String(err)} ***`);
    }
    d.show({ uid, at, student, photo: photo ? `/captures/${eventId}.jpg` : null });
    if (!student) d.unknownCard();

    let saved = false;
    try {
      saved = d.queue.enqueue({ eventId, cardUid: uid, deviceId: d.deviceId, scannedAt: at, clockSynced: d.clockSynced(), photo });
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
