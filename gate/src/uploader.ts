import { Backoff } from './backoff.ts';
import type { Log } from './log.ts';
import type { QueuedScan, ScanQueue } from './queue.ts';
import { explainFailure, type Rpc } from './supabase.ts';

export const UPLOAD_BATCH_SIZE = 50;
// A scan older than this when it is sent is flagged queued=true, so
// notify-guardian's message.ts tells the parent the message was delayed.
export const LATE_AFTER_S = 15;

export interface AttendanceEvent {
  event_id: string;
  card_uid: string;
  device_id: string;
  scanned_at: string;
  clock_synced: boolean;
  direction: 'in';
  queued: boolean;
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

  #queue: ScanQueue;
  #rpc: Rpc;
  #deviceId: string;
  #log: Log;
  #backoff: Backoff;
  #stopped = false;
  #wake: (() => void) | null = null;

  constructor(queue: ScanQueue, rpc: Rpc, deviceId: string, log: Log, backoff = new Backoff(1000, 60_000)) {
    this.#queue = queue;
    this.#rpc = rpc;
    this.#deviceId = deviceId;
    this.#log = log;
    this.#backoff = backoff;
  }

  // One attempt. Returns how long to wait before the next one.
  async step(nowMs = Date.now()): Promise<number> {
    if (!this.netOn) return 500;
    const batch = this.#queue.take(UPLOAD_BATCH_SIZE);
    if (batch.length === 0) return 250;

    const res = await this.#rpc('record_attendance', { events: toPayload(batch, nowMs) });
    const is2xx = res.status >= 200 && res.status < 300;
    const inserted = is2xx ? parseInserted(res.body) : null;

    if (inserted !== null) {
      this.#queue.ack(batch.map((s) => s.id), new Date(nowMs).toISOString());
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

    this.failed++;
    this.lastOk = false;
    this.#backoff.onFailure();
    const why = is2xx ? `http=${res.status} but the body is not a row count (captive portal?)` : `http=${res.status}`;
    this.#log(
      `[upload] FAILED ${why} attempt=${this.#backoff.failures} retry_in=${this.#backoff.delayMs}ms ` +
        res.body.slice(0, 200),
    );
    const hint = explainFailure(res.body, this.#deviceId);
    if (hint) this.#log(`[upload] hint: ${hint}`);
    return this.#backoff.delayMs;
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
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait);
          this.#wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.#wake = null;
      }
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#wake?.();
  }
}
