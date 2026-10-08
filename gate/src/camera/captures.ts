import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot } from './camera.ts';

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The kiosk shows a tap for one minute; a few recent ones cover a queue of
// students tapping in quick succession.
const RECENT = 8;

// Photos of the taps. The small upload picture is on disk until it is
// uploaded (so it survives a restart while offline, like the scan itself);
// the sharp kiosk picture is only in memory, which the kiosk reads without
// ever racing the uploader deleting the file.
export class CaptureStore {
  #dir: string;
  #recent = new Map<string, Buffer>();

  constructor(dir: string) {
    this.#dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  #path(eventId: string): string {
    if (!EVENT_ID.test(eventId)) throw new Error(`not an event id: ${eventId}`);
    return join(this.#dir, `${eventId}.jpg`);
  }

  save(eventId: string, shot: Snapshot): void {
    const path = this.#path(eventId);
    this.#recent.set(eventId, shot.kiosk);
    while (this.#recent.size > RECENT) this.#recent.delete(this.#recent.keys().next().value!);
    writeFileSync(path, shot.upload, { mode: 0o600 });
  }

  // For the kiosk: memory only, so it is fast and cannot be used to read
  // older photos off the disk.
  recent(eventId: string): Buffer | null {
    return this.#recent.get(eventId) ?? null;
  }

  read(eventId: string): Buffer | null {
    try {
      return readFileSync(this.#path(eventId));
    } catch {
      return null;
    }
  }

  remove(eventId: string): void {
    rmSync(this.#path(eventId), { force: true });
  }

  // Captures nothing will ever upload (a scan given up on, a crash between
  // ack and remove). Photos of minors are not kept by accident.
  prune(olderThanMs: number, nowMs = Date.now()): number {
    let n = 0;
    for (const name of readdirSync(this.#dir)) {
      const path = join(this.#dir, name);
      try {
        if (nowMs - statSync(path).mtimeMs > olderThanMs) {
          rmSync(path, { force: true });
          n++;
        }
      } catch {
        // Removed underneath us: nothing to prune.
      }
    }
    return n;
  }

  count(): number {
    return readdirSync(this.#dir).length;
  }
}
