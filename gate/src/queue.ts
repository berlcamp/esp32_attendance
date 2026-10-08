import type { DatabaseSync } from 'node:sqlite';
import { bumpMeta, getMeta, tx } from './db.ts';

export interface NewScan {
  eventId: string;
  cardUid: string;
  deviceId: string;
  scannedAt: string;
  clockSynced: boolean;
  photo?: boolean;
}

export interface QueuedScan extends NewScan {
  id: number;
  photo: boolean;
  imagePath: string | null;
  photoFailures: number;
}

interface Row {
  id: number;
  event_id: string;
  card_uid: string;
  device_id: string;
  scanned_at: string;
  clock_synced: number;
  photo: number;
  image_path: string | null;
  photo_failures: number;
}

const toScan = (r: Row): QueuedScan => ({
  id: r.id,
  eventId: r.event_id,
  cardUid: r.card_uid,
  deviceId: r.device_id,
  scannedAt: r.scanned_at,
  clockSynced: r.clock_synced === 1,
  photo: r.photo === 1,
  imagePath: r.image_path,
  photoFailures: r.photo_failures,
});

// The durable queue between the reader and the uploader. Same contract as the
// firmware's LittleFS log: a full queue keeps the OLDEST scans and refuses the
// newest, counting each refusal, so a wedged uploader cannot fill the disk.
export class ScanQueue {
  #db: DatabaseSync;
  #max: number;

  constructor(db: DatabaseSync, maxPending = 100_000) {
    this.#db = db;
    this.#max = maxPending;
  }

  enqueue(scan: NewScan): boolean {
    if (this.depth() >= this.#max) {
      bumpMeta(this.#db, 'dropped');
      return false;
    }
    this.#db
      .prepare(
        'insert into scans (event_id, card_uid, device_id, scanned_at, clock_synced, photo) values (?, ?, ?, ?, ?, ?)',
      )
      .run(scan.eventId, scan.cardUid, scan.deviceId, scan.scannedAt, scan.clockSynced ? 1 : 0, scan.photo ? 1 : 0);
    return true;
  }

  take(n: number): QueuedScan[] {
    const rows = this.#db
      .prepare(
        'select id, event_id, card_uid, device_id, scanned_at, clock_synced, photo, image_path, photo_failures ' +
          'from scans where sent_at is null order by id limit ?',
      )
      .all(n) as unknown as Row[];
    return rows.map(toScan);
  }

  ack(ids: number[], sentAt: string): void {
    if (ids.length === 0) return;
    tx(this.#db, () => {
      const stmt = this.#db.prepare('update scans set sent_at = ? where id = ? and sent_at is null');
      for (const id of ids) stmt.run(sentAt, id);
    });
  }

  setImagePath(id: number, imagePath: string): void {
    this.#db.prepare('update scans set image_path = ? where id = ?').run(imagePath, id);
  }

  photoFailed(id: number): number {
    this.#db.prepare('update scans set photo_failures = photo_failures + 1 where id = ?').run(id);
    return (this.#db.prepare('select photo_failures as n from scans where id = ?').get(id) as { n: number }).n;
  }

  // The capture is gone (deleted, never written): stop waiting for it.
  photoLost(id: number): void {
    this.#db.prepare('update scans set photo = 0 where id = ?').run(id);
  }

  depth(): number {
    return (this.#db.prepare('select count(*) as n from scans where sent_at is null').get() as { n: number }).n;
  }

  prune(sentBefore: string): number {
    return Number(this.#db.prepare('delete from scans where sent_at is not null and sent_at < ?').run(sentBefore).changes);
  }

  dropped(): number {
    return Number(getMeta(this.#db, 'dropped') ?? '0');
  }
}
