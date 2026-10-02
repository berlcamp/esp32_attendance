import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { RosterMirror, RosterSync, type Snapshot } from './roster.ts';
import type { RpcResult } from './supabase.ts';

const TOKEN = 'gt_' + 'b'.repeat(64);
const NOW = Date.parse('2026-10-05T07:00:00.000Z');
const SNAP: Snapshot = {
  school_id: 'school-1',
  device_id: 'gate-01-pc',
  generated_at: '2026-10-05T07:00:00Z',
  students: [
    { student_id: 'st1', full_name: 'Dela Cruz, Juan', student_no: '2026-0001', grade_level: 'Grade 7', section_name: 'Rizal' },
    { student_id: 'st2', full_name: 'Santos, Maria', student_no: null, grade_level: null, section_name: null },
  ],
  cards: [{ card_uid: '0002008108', student_id: 'st1' }],
};
const EMPTY: Snapshot = { ...SNAP, students: [], cards: [] };

function setup(responses: RpcResult[] = []) {
  const mirror = new RosterMirror(openDb(':memory:'));
  const calls: { fn: string; args: unknown }[] = [];
  const logs: string[] = [];
  const sync = new RosterSync(
    mirror,
    async (fn, args) => {
      calls.push({ fn, args });
      return responses.shift() ?? { status: 200, body: JSON.stringify(SNAP) };
    },
    'gate-01-pc',
    TOKEN,
    (l) => logs.push(l),
  );
  return { mirror, sync, calls, logs };
}

test('lookup resolves a card to its student; unknown and zero-stripped uids do not', () => {
  const { mirror } = setup();
  mirror.replace(SNAP, '2026-10-05T07:00:00.000Z');
  assert.deepEqual(mirror.lookup('0002008108'), SNAP.students[0]);
  assert.equal(mirror.lookup('0000000001'), null);
  assert.equal(mirror.lookup('2008108'), null);
  assert.equal(mirror.studentCount(), 2);
});

test('replace is wholesale: a card missing from the new snapshot stops resolving', () => {
  const { mirror } = setup();
  mirror.replace(SNAP, '2026-10-05T07:00:00.000Z');
  mirror.replace({ ...SNAP, cards: [] }, '2026-10-05T07:05:00.000Z');
  assert.equal(mirror.lookup('0002008108'), null);
  assert.equal(mirror.syncedAt(), '2026-10-05T07:05:00.000Z');
});

test('sync calls gate_roster_snapshot with the device id and token', async () => {
  const { mirror, sync, calls } = setup();
  assert.equal(await sync.sync(NOW), 'ok');
  assert.deepEqual(calls, [{ fn: 'gate_roster_snapshot', args: { p_device_id: 'gate-01-pc', p_token: TOKEN } }]);
  assert.equal(mirror.syncedAt(), new Date(NOW).toISOString());
  assert.equal(mirror.studentCount(), 2);
});

test('a failed sync keeps the last good mirror', async () => {
  const { mirror, sync, logs } = setup([{ status: 200, body: JSON.stringify(SNAP) }, { status: 0, body: 'ENOTFOUND' }]);
  await sync.sync(NOW);
  assert.equal(await sync.sync(NOW + 300_000), 'failed');
  assert.equal(mirror.lookup('0002008108')?.full_name, 'Dela Cruz, Juan');
  assert.equal(mirror.syncedAt(), new Date(NOW).toISOString());
  assert.ok(logs.some((l) => l.includes('keeping the last good mirror')));
});

test('an unreadable snapshot keeps the last good mirror', async () => {
  const { mirror, sync } = setup([
    { status: 200, body: JSON.stringify(SNAP) },
    { status: 200, body: 'not json' },
    { status: 200, body: '{}' },
  ]);
  await sync.sync(NOW);
  assert.equal(await sync.sync(NOW + 1), 'failed');
  assert.equal(await sync.sync(NOW + 2), 'failed');
  assert.equal(mirror.studentCount(), 2);
});

test('a wrong token logs how to fix it', async () => {
  const { sync, logs } = setup([{ status: 403, body: '{"code":"42501","message":"invalid gate device credentials"}' }]);
  assert.equal(await sync.sync(NOW), 'failed');
  assert.ok(logs.some((l) => l.includes("issue_gate_device_token('gate-01-pc')")), logs.join('\n'));
});

test('REVIEW FOCUS: an empty snapshot never blanks a populated mirror', async () => {
  const { mirror, sync, logs } = setup([
    { status: 200, body: JSON.stringify(SNAP) },
    { status: 200, body: JSON.stringify(EMPTY) },
  ]);
  await sync.sync(NOW);
  assert.equal(await sync.sync(NOW + 300_000), 'refused-empty');
  assert.equal(mirror.lookup('0002008108')?.full_name, 'Dela Cruz, Juan');
  assert.ok(logs.some((l) => l.includes('active school year')));
});

test('REVIEW C1: a student listed twice (two enrolments) is stored once, not a crash', async () => {
  const twice = { ...SNAP, students: [...SNAP.students, { ...SNAP.students[0], section_name: 'Bonifacio' }] };
  const { mirror, sync } = setup([{ status: 200, body: JSON.stringify(twice) }]);
  assert.equal(await sync.sync(NOW), 'ok');
  assert.equal(mirror.studentCount(), 2);
  assert.equal(mirror.lookup('0002008108')?.full_name, 'Dela Cruz, Juan');
});

test('REVIEW C1: rows without an id or a name are skipped, not a crash', async () => {
  const bad = {
    ...SNAP,
    students: [...SNAP.students, { student_id: null, full_name: 'X' }, { student_id: 'st9', full_name: null }],
    cards: [...SNAP.cards, { card_uid: '0000000009', student_id: null }],
  };
  const { mirror, sync } = setup([{ status: 200, body: JSON.stringify(bad) }]);
  assert.equal(await sync.sync(NOW), 'ok');
  assert.equal(mirror.studentCount(), 2);
  assert.equal(mirror.lookup('0000000009'), null);
});

test('REVIEW C1: a storage failure (disk full) keeps the last good mirror and never rejects', async () => {
  class FullDiskMirror extends RosterMirror {
    override replace(): void {
      throw new Error('database or disk is full');
    }
  }
  const mirror = new FullDiskMirror(openDb(':memory:'));
  const logs: string[] = [];
  const sync = new RosterSync(mirror, async () => ({ status: 200, body: JSON.stringify(SNAP) }), 'gate-01-pc', TOKEN, (l) => logs.push(l));
  assert.equal(await sync.sync(NOW), 'failed');
  assert.ok(logs.some((l) => l.includes('database or disk is full') && l.includes('keeping the last good mirror')), logs.join('\n'));
});

test('an empty snapshot is accepted when there was nothing to lose', async () => {
  const { sync } = setup([{ status: 200, body: JSON.stringify(EMPTY) }]);
  assert.equal(await sync.sync(NOW), 'ok');
});

test('unknown-card resyncs happen at most once a minute', async () => {
  const { sync, calls } = setup();
  assert.equal(sync.requestResync(NOW), true);
  await sync.sync(NOW); // joins the in-flight request
  assert.equal(sync.requestResync(NOW + 30_000), false);
  assert.equal(sync.requestResync(NOW + 61_000), true);
  await sync.sync(NOW + 61_000);
  assert.equal(calls.length, 2);
});

test('concurrent syncs share one request', async () => {
  const { sync, calls } = setup();
  const a = sync.sync(NOW);
  const b = sync.sync(NOW);
  assert.equal(a, b);
  await a;
  assert.equal(calls.length, 1);
});

test('stale when never synced, or synced more than an hour ago', async () => {
  const { sync } = setup();
  assert.equal(sync.isStale(NOW), true);
  await sync.sync(NOW);
  assert.equal(sync.isStale(NOW + 59 * 60_000), false);
  assert.equal(sync.isStale(NOW + 61 * 60_000), true);
});
