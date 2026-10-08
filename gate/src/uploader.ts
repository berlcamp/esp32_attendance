import { Backoff } from './backoff.ts';
import type { Log } from './log.ts';
import type { QueuedScan, ScanQueue } from './queue.ts';
import { explainFailure, parsePhotoPath, type PhotoUpload, type Rpc } from './supabase.ts';
import type { CaptureStore } from './camera/captures.ts';

export const UPLOAD_BATCH_SIZE = 50;
// A scan older than this when it is sent is flagged queued=true, so
// notify-guardian's message.ts tells the parent the message was delayed.
export const LATE_AFTER_S = 15;
// A photo the server keeps failing (5xx, timeouts) is retried this often, then
// the scan goes without it: the photo is corroboration, not the record.
export const MAX_PHOTO_FAILURES = 3;
// Photo uploads in one step, so a backlog of photos after an outage does not
// hold every scan behind it for long.
export const PHOTOS_PER_STEP = 10;
// How long an empty queue waits before looking again. A tap does not wait
// for it: kick() starts the upload at once.
export const IDLE_MS = 250;

export interface AttendanceEvent {
  event_id: string;
  card_uid: string;
  device_id: string;
  scanned_at: string;
  clock_synced: boolean;
  direction: 'in';
  queued: boolean;
  image_path?: string;
}

export interface PhotoDeps {
  upload: PhotoUpload;
  store: Pick<CaptureStore, 'read' | 'remove'>;
}

export function toPayload(scans: QueuedScan[], nowMs: number): AttendanceEvent[] {
  return scans.map((s) => ({
    event_id: s.eventId,
    card_uid: s.cardUid,
    device_id: s.deviceId,
    scanned_at: s.scannedAt,
    clock_synced: s.clockSynced,
    direction: 'in',
    queued: (nowMs - Date.parse(s.scannedAt)) / 1000 > LATE_AFTER_S,
    ...(s.imagePath ? { image_path: s.imagePath } : {}),
  }));
}

// record_attendance() returns how many rows were new. Anything that is not a
// bare integer -- an HTML login page from a captive portal, a proxy error with
// a 200 -- did NOT reach Postgres, and acking it would lose the batch.
export function parseInserted(body: string): number | null {
  const m = /^\s*(\d+)\s*$/.exec(body);
  return m ? Number(m[1]) : null;
}

export class Uploader {
  netOn = true;
  sent = 0;
  failed = 0;
  duplicates = 0;
  lastOk: boolean | null = null;
  photosSent = 0;
  photosSkipped = 0;

  #queue: ScanQueue;
  #rpc: Rpc;
  #deviceId: string;
  #log: Log;
  #backoff: Backoff;
  #photos: PhotoDeps | null;
  #stopped = false;
  #wake: (() => void) | null = null;
  #idle = false;

  constructor(
    queue: ScanQueue,
    rpc: Rpc,
    deviceId: string,
    log: Log,
    photos: PhotoDeps | null = null,
    backoff = new Backoff(1000, 60_000),
  ) {
    this.#photos = photos;
    this.#queue = queue;
    this.#rpc = rpc;
    this.#deviceId = deviceId;
    this.#log = log;
    this.#backoff = backoff;
  }

  // One attempt. Returns how long to wait before the next one.
  async step(nowMs = Date.now()): Promise<number> {
    if (!this.netOn) return 500;
    const taken = this.#queue.take(UPLOAD_BATCH_SIZE);
    if (taken.length === 0) return IDLE_MS;

    // Photos first: notify-guardian fires on the INSERT, so a scan's
    // image_path must be in the row it creates or the parent gets text.
    const photos = await this.#attachPhotos(taken);
    const batch = photos.ready;
    if (batch.length === 0) return this.#fail(photos.why ?? 'photo upload pending', '');

    const res = await this.#rpc('record_attendance', { events: toPayload(batch, nowMs) });
    const is2xx = res.status >= 200 && res.status < 300;
    const inserted = is2xx ? parseInserted(res.body) : null;

    if (inserted !== null) {
      this.#queue.ack(batch.map((s) => s.id), new Date(nowMs).toISOString());
      for (const s of batch) if (s.photo) this.#removeCapture(s.eventId);
      const dup = Math.max(0, batch.length - inserted);
      this.sent += batch.length;
      this.duplicates += dup;
      this.lastOk = true;
      this.#backoff.onSuccess();
      this.#log(
        `[upload] ${batch.length} sent, ${inserted} inserted` +
          (dup ? `, ${dup} duplicate(s) ignored` : '') +
          `, ${this.#queue.depth()} still queued`,
      );
      return 0;
    }

    const why = is2xx ? `http=${res.status} but the body is not a row count (captive portal?)` : `http=${res.status}`;
    const wait = this.#fail(why, res.body);
    const hint = explainFailure(res.body, this.#deviceId);
    if (hint) this.#log(`[upload] hint: ${hint}`);
    return wait;
  }

  #fail(why: string, body: string): number {
    this.failed++;
    this.lastOk = false;
    this.#backoff.onFailure();
    this.#log(
      `[upload] FAILED ${why} attempt=${this.#backoff.failures} retry_in=${this.#backoff.delayMs}ms ` +
        body.slice(0, 200),
    );
    return this.#backoff.delayMs;
  }

  // Uploads the photos of the scans at the head of the batch and returns the
  // scans that are ready to send, in order. It stops at the first photo that
  // should be retried, so scans are never sent out of order.
  async #attachPhotos(batch: QueuedScan[]): Promise<{ ready: QueuedScan[]; why?: string }> {
    const ready: QueuedScan[] = [];
    if (!this.#photos) return { ready: batch.map((s) => (s.photo ? { ...s, photo: false } : s)) };
    const { upload, store } = this.#photos;
    let uploads = 0;
    for (const s of batch) {
      if (!s.photo || s.imagePath || s.photoFailures >= MAX_PHOTO_FAILURES) {
        ready.push(s);
        continue;
      }
      if (uploads >= PHOTOS_PER_STEP) break;
      const jpeg = store.read(s.eventId);
      if (!jpeg) {
        this.#queue.photoLost(s.id);
        this.photosSkipped++;
        this.#log(`[photo] ${s.eventId} capture is missing on disk -- sending the scan without it`);
        ready.push({ ...s, photo: false });
        continue;
      }
      uploads++;
      const res = await upload(s.eventId, jpeg);
      const is2xx = res.status >= 200 && res.status < 300;
      const path = is2xx ? parsePhotoPath(res.body) : null;
      if (path) {
        this.#queue.setImagePath(s.id, path);
        this.photosSent++;
        ready.push({ ...s, imagePath: path });
        continue;
      }
      // No connection, or a captive portal answering for the internet: the
      // attendance call would fail the same way, so neither is the photo's fault.
      if (res.status === 0 || is2xx) {
        return { ready, why: `photo upload http=${res.status} (offline?)` };
      }
      // 4xx will not fix itself on retry (function not deployed, bad token, a
      // rejected image): send the scan now, without the photo.
      const n = res.status < 500 ? MAX_PHOTO_FAILURES : this.#queue.photoFailed(s.id);
      if (n < MAX_PHOTO_FAILURES) {
        this.#log(`[photo] ${s.eventId} upload FAILED http=${res.status} (${n}/${MAX_PHOTO_FAILURES}) ${res.body.slice(0, 200)}`);
        return { ready, why: `photo upload http=${res.status}` };
      }
      this.photosSkipped++;
      this.#log(
        `[photo] ${s.eventId} upload FAILED http=${res.status} -- sending the scan without its photo ` +
          res.body.slice(0, 200),
      );
      if (res.status === 404) this.#log('[photo] hint: deploy it: supabase functions deploy gate-capture --no-verify-jwt');
      if (res.status === 403) this.#log(`[photo] hint: GATE_TOKEN is not the current token for '${this.#deviceId}'`);
      ready.push({ ...s, imagePath: null });
    }
    return { ready };
  }

  #removeCapture(eventId: string): void {
    try {
      this.#photos?.store.remove(eventId);
    } catch (err) {
      this.#log(`[photo] could not delete ${eventId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async run(): Promise<void> {
    while (!this.#stopped) {
      let wait: number;
      try {
        wait = await this.step();
      } catch (err) {
        // A database error must not kill the loop; scans keep queueing.
        this.#log(`[upload] error: ${err instanceof Error ? err.message : String(err)}`);
        wait = 5000;
      }
      if (wait > 0 && !this.#stopped) {
        this.#idle = wait === IDLE_MS;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait);
          this.#wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.#wake = null;
        this.#idle = false;
      }
    }
  }

  // A new scan was queued: send it now rather than at the next idle check.
  // Only an idle wait is cut short; a backoff after a failure is kept.
  kick(): void {
    if (this.#idle) this.#wake?.();
  }

  stop(): void {
    this.#stopped = true;
    this.#wake?.();
  }
}
