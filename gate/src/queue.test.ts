import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { ScanQueue, type NewScan } from './queue.ts';
import { tmpPath } from './test-helpers.ts';

const scan = (n: number, uid = '0002008108'): NewScan => ({
  eventId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  cardUid: uid,
  deviceId: 'gate-01-pc',
  scannedAt: `2026-10-05T07:00:${String(n % 60).padStart(2, '0')}.000Z`,
  clockSynced: true,
});

test('scans come back oldest first, uid still a string with its zeros', () => {
  const q = new ScanQueue(openDb(':memory:'));
  for (const n of [1, 2, 3]) assert.equal(q.enqueue(scan(n)), true);
  const taken = q.take(10);
  assert.deepEqual(taken.map((s) => s.eventId), [scan(1).eventId, scan(2).eventId, scan(3).eventId]);
  assert.equal(taken[0].cardUid, '0002008108');
  assert.equal(taken[0].clockSynced, true);
  assert.equal(taken[0].scannedAt, scan(1).scannedAt);
});

test('take returns at most n', () => {
  const q = new ScanQueue(openDb(':memory:'));
  for (const n of [1, 2, 3, 4, 5]) q.enqueue(scan(n));
  assert.equal(q.take(2).length, 2);
});

test('acked scans leave the queue, and acking twice is harmless', () => {
  const q = new ScanQueue(openDb(':memory:'));
  for (const n of [1, 2, 3]) q.enqueue(scan(n));
  const [a, b] = q.take(2);
  q.ack([a.id, b.id], '2026-10-05T07:01:00.000Z');
  q.ack([a.id, b.id], '2026-10-05T07:02:00.000Z');
  assert.equal(q.depth(), 1);
  assert.deepEqual(q.take(10).map((s) => s.eventId), [scan(3).eventId]);
});

test('a full queue refuses the NEWEST scan and counts it as dropped', () => {
  const q = new ScanQueue(openDb(':memory:'), 2);
  assert.deepEqual([1, 2, 3].map((n) => q.enqueue(scan(n))), [true, true, false]);
  assert.equal(q.depth(), 2);
  assert.equal(q.dropped(), 1);
  assert.deepEqual(q.take(10).map((s) => s.eventId), [scan(1).eventId, scan(2).eventId]);
});

test('a duplicate event_id is rejected by the database, never stored twice', () => {
  const q = new ScanQueue(openDb(':memory:'));
  q.enqueue(scan(1));
  assert.throws(() => q.enqueue(scan(1)), /UNIQUE/);
  assert.equal(q.depth(), 1);
});

test('pending scans survive a restart', () => {
  const path = tmpPath('gate.db');
  const db = openDb(path);
  new ScanQueue(db).enqueue(scan(1));
  db.close();
  assert.equal(new ScanQueue(openDb(path)).depth(), 1);
});

test('prune deletes only SENT rows older than the cutoff', () => {
  const q = new ScanQueue(openDb(':memory:'));
  for (const n of [1, 2, 3]) q.enqueue(scan(n));
  const [a, b] = q.take(2);
  q.ack([a.id], '2026-10-01T00:00:00.000Z');
  q.ack([b.id], '2026-10-09T00:00:00.000Z');
  assert.equal(q.prune('2026-10-05T00:00:00.000Z'), 1);
  assert.equal(q.depth(), 1);
});
