import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDb } from './db.ts';
import { ScanQueue } from './queue.ts';
import type { Rpc, RpcResult } from './supabase.ts';
import { Uploader, parseInserted, toPayload, type AttendanceEvent, type PhotoDeps } from './uploader.ts';
import { waitFor } from './test-helpers.ts';

const NOW = Date.parse('2026-10-05T07:00:30.000Z');

function setup(responses: RpcResult[] = [], photos: PhotoDeps | null = null) {
  const queue = new ScanQueue(openDb(':memory:'));
  const calls: { fn: string; events: AttendanceEvent[] }[] = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, events: (args as { events: AttendanceEvent[] }).events });
    return responses.shift() ?? { status: 200, body: String((args as { events: unknown[] }).events.length) };
  };
  const logs: string[] = [];
  const up = new Uploader(queue, rpc, 'gate-01-pc', (l) => logs.push(l), photos);
  const add = (n: number, photo = false) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const eventId = randomUUID();
      ids.push(eventId);
      queue.enqueue({ eventId, cardUid: '0002008108', deviceId: 'gate-01-pc', scannedAt: new Date(NOW).toISOString(), clockSynced: true, photo });
    }
    return ids;
  };
  return { queue, calls, up, logs, add };
}

test('toPayload builds the record_attendance event, queued after 15 s', () => {
  const base = {
    id: 1, eventId: 'e1', cardUid: '0002008108', deviceId: 'gate-01-pc', clockSynced: false,
    photo: false, imagePath: null, photoFailures: 0,
  };
  const fresh = new Date(NOW - 14_000).toISOString();
  const [a, b] = toPayload(
    [{ ...base, scannedAt: fresh }, { ...base, id: 2, eventId: 'e2', scannedAt: new Date(NOW - 16_000).toISOString() }],
    NOW,
  );
  assert.deepEqual(a, {
    event_id: 'e1', card_uid: '0002008108', device_id: 'gate-01-pc', scanned_at: fresh,
    clock_synced: false, direction: 'in', queued: false,
  });
  assert.equal(b.queued, true);
});

test('parseInserted accepts only a bare non-negative integer', () => {
  assert.equal(parseInserted('3'), 3);
  assert.equal(parseInserted(' 12\n'), 12);
  for (const body of ['', '<html>', '"3"', '-1', '3.5', '{"n":3}']) assert.equal(parseInserted(body), null, body);
});

test('a delivered batch is acked and counted', async () => {
  const { queue, calls, up, add } = setup([{ status: 200, body: '2' }]);
  add(2);
  assert.equal(await up.step(NOW), 0);
  assert.equal(queue.depth(), 0);
  assert.equal(up.sent, 2);
  assert.equal(up.lastOk, true);
  assert.equal(calls[0].fn, 'record_attendance');
  assert.equal(calls[0].events.length, 2);
});

test('a shortfall in inserted rows is duplicates already delivered, not a failure', async () => {
  const { queue, up, add } = setup([{ status: 200, body: '1' }]);
  add(3);
  await up.step(NOW);
  assert.equal(queue.depth(), 0);
  assert.equal(up.duplicates, 2);
});

test('a failure keeps every scan and backs off', async () => {
  const { queue, up, add } = setup([{ status: 503, body: 'down' }, { status: 0, body: 'ECONNREFUSED' }]);
  add(2);
  assert.equal(await up.step(NOW), 2000);
  assert.equal(await up.step(NOW), 4000);
  assert.equal(queue.depth(), 2);
  assert.equal(up.failed, 2);
  assert.equal(up.lastOk, false);
});

test('REVIEW FOCUS: a 200 that is not a row count (captive portal) is a failure', async () => {
  const { queue, up, logs, add } = setup([{ status: 200, body: '<html>Log in to school Wi-Fi</html>' }]);
  add(1);
  assert.equal(await up.step(NOW), 2000);
  assert.equal(queue.depth(), 1);
  assert.equal(up.sent, 0);
  assert.ok(logs.some((l) => l.includes('captive portal')), logs.join('\n'));
});

test('a failure logs the hint for a known server error', async () => {
  const { up, logs, add } = setup([
    { status: 403, body: '{"code":"42501","message":"unregistered or inactive gate device: gate-01-pc"}' },
  ]);
  add(1);
  await up.step(NOW);
  assert.ok(logs.some((l) => l.includes('not in pta.gate_devices')), logs.join('\n'));
});

test('net off and an empty queue send nothing', async () => {
  const { calls, up, add } = setup();
  assert.equal(await up.step(NOW), 250);
  up.netOn = false;
  add(1);
  assert.equal(await up.step(NOW), 500);
  assert.equal(calls.length, 0);
});

test('batches are capped at 50', async () => {
  const { queue, calls, up, add } = setup();
  add(120);
  await up.step(NOW);
  assert.equal(calls[0].events.length, 50);
  assert.equal(queue.depth(), 70);
});

test('run() drains the queue until stopped', async () => {
  const { queue, up, add } = setup();
  add(120);
  const running = up.run();
  await waitFor(() => queue.depth() === 0);
  up.stop();
  await running;
});

// A fake gate-capture: answers from `answers` in turn (default: stored), and a
// capture store holding a JPEG for every event id unless told otherwise.
function photoFake(answers: RpcResult[] = [], missing = new Set<string>()) {
  const uploaded: string[] = [];
  const removed: string[] = [];
  const deps: PhotoDeps = {
    upload: async (eventId) => {
      uploaded.push(eventId);
      return answers.shift() ?? { status: 200, body: JSON.stringify({ path: `s1/gate-01-pc/${eventId}.jpg` }) };
    },
    store: {
      read: (eventId) => (missing.has(eventId) ? null : Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
      remove: (eventId) => void removed.push(eventId),
    },
  };
  return { deps, uploaded, removed };
}

test('a photo is uploaded before its scan, which then carries image_path', async () => {
  const p = photoFake();
  const { queue, calls, up, add } = setup([], p.deps);
  const [id] = add(1, true);
  add(1, false);
  assert.equal(await up.step(NOW), 0);
  assert.deepEqual(p.uploaded, [id]);
  assert.equal(calls[0].events[0].image_path, `s1/gate-01-pc/${id}.jpg`);
  assert.equal('image_path' in calls[0].events[1], false);
  assert.equal(queue.depth(), 0);
  assert.deepEqual(p.removed, [id], 'the local capture is deleted once delivered');
  assert.equal(up.photosSent, 1);
});

test('REVIEW FOCUS: offline, neither the photo nor the scan is lost or sent without it', async () => {
  const p = photoFake([{ status: 0, body: 'ENOTFOUND' }]);
  const { queue, calls, up, add } = setup([], p.deps);
  add(1, true);
  assert.equal(await up.step(NOW), 2000);
  assert.equal(calls.length, 0);
  assert.equal(queue.take(1)[0].photoFailures, 0, 'being offline is not the photo failing');
  await up.step(NOW);
  assert.match(calls[0].events[0].image_path ?? '', /\.jpg$/);
});

test('a server error is retried, then the scan goes without its photo', async () => {
  const p = photoFake([500, 502, 503].map((status) => ({ status, body: 'boom' })));
  const { queue, calls, up, add, logs } = setup([], p.deps);
  add(1, true);
  await up.step(NOW);
  await up.step(NOW);
  assert.equal(calls.length, 0);
  await up.step(NOW);
  assert.equal(calls.length, 1);
  assert.equal('image_path' in calls[0].events[0], false);
  assert.equal(queue.depth(), 0);
  assert.equal(up.photosSkipped, 1);
  assert.ok(logs.some((l) => l.includes('without its photo')), logs.join('\n'));
});

test('a 404 (function not deployed) sends the scan at once, without the photo', async () => {
  const p = photoFake([{ status: 404, body: 'not found' }]);
  const { calls, up, add, logs } = setup([], p.deps);
  add(1, true);
  assert.equal(await up.step(NOW), 0);
  assert.equal(calls.length, 1);
  assert.ok(logs.some((l) => l.includes('functions deploy gate-capture')), logs.join('\n'));
});

test('scans stay in order: a retried photo holds back the scans behind it', async () => {
  const p = photoFake([{ status: 200, body: '{"path":"s1/g/a.jpg"}' }, { status: 503, body: '' }]);
  const { calls, up, add } = setup([], p.deps);
  const ids = [...add(1, true), ...add(1, true), ...add(1, false)];
  await up.step(NOW);
  assert.deepEqual(calls[0].events.map((e) => e.event_id), [ids[0]]);
  await up.step(NOW);
  assert.deepEqual(calls[1].events.map((e) => e.event_id), [ids[1], ids[2]]);
});

test('a capture missing from disk does not hold the scan', async () => {
  const missing = new Set<string>();
  const p = photoFake([], missing);
  const { calls, up, add } = setup([], p.deps);
  const [id] = add(1, true);
  missing.add(id);
  await up.step(NOW);
  assert.equal(p.uploaded.length, 0);
  assert.equal(calls[0].events.length, 1);
});
