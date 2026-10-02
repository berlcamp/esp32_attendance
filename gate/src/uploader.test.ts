import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDb } from './db.ts';
import { ScanQueue } from './queue.ts';
import type { Rpc, RpcResult } from './supabase.ts';
import { Uploader, parseInserted, toPayload, type AttendanceEvent } from './uploader.ts';
import { waitFor } from './test-helpers.ts';

const NOW = Date.parse('2026-10-05T07:00:30.000Z');

function setup(responses: RpcResult[] = []) {
  const queue = new ScanQueue(openDb(':memory:'));
  const calls: { fn: string; events: AttendanceEvent[] }[] = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, events: (args as { events: AttendanceEvent[] }).events });
    return responses.shift() ?? { status: 200, body: String((args as { events: unknown[] }).events.length) };
  };
  const logs: string[] = [];
  const up = new Uploader(queue, rpc, 'gate-01-pc', (l) => logs.push(l));
  const add = (n: number) => {
    for (let i = 0; i < n; i++) {
      queue.enqueue({ eventId: randomUUID(), cardUid: '0002008108', deviceId: 'gate-01-pc', scannedAt: new Date(NOW).toISOString(), clockSynced: true });
    }
  };
  return { queue, calls, up, logs, add };
}

test('toPayload builds the record_attendance event, queued after 15 s', () => {
  const base = { id: 1, eventId: 'e1', cardUid: '0002008108', deviceId: 'gate-01-pc', clockSynced: false };
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
