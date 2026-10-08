import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The kiosk shows a tap for one minute; a few recent ones cover a queue of
// students tapping in quick succession.
const RECENT = 8;

// Photos of the taps, on disk until they are uploaded (so a capture survives a
// restart while offline, like the scan itself) and in memory for the kiosk,
// which must never race the uploader deleting the file.
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

  save(eventId: string, jpeg: Buffer): void {
    this.#recent.set(eventId, jpeg);
    while (this.#recent.size > RECENT) this.#recent.delete(this.#recent.keys().next().value!);
    writeFileSync(this.#path(eventId), jpeg, { mode: 0o600 });
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
