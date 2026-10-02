import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cooldown } from './cooldown.ts';
import type { NewScan } from './queue.ts';
import type { Student } from './roster.ts';
import { Scanner, type ScanView, type ScannerDeps } from './scanner.ts';

const JUAN: Student = { student_id: 'st1', full_name: 'Dela Cruz, Juan', student_no: '2026-0001', grade_level: 'Grade 7', section_name: 'Rizal' };
const T0 = Date.parse('2026-10-05T07:00:00.000Z');

function setup(over: Partial<ScannerDeps> = {}) {
  const order: string[] = [];
  const queued: NewScan[] = [];
  const views: ScanView[] = [];
  const logs: string[] = [];
  const clock = { mono: 0, now: T0, unknown: 0, ids: 0 };
  const deps: ScannerDeps = {
    deviceId: 'gate-01-pc',
    queue: { enqueue: (s) => { order.push('enqueue'); queued.push(s); return true; } },
    mirror: { lookup: (uid) => (uid === '0002008108' ? JUAN : null) },
    cooldown: new Cooldown(10_000),
    clockSynced: () => true,
    show: (v) => { order.push('show'); views.push(v); },
    unknownCard: () => { clock.unknown++; },
    log: (l) => logs.push(l),
    now: () => clock.now,
    mono: () => clock.mono,
    newId: () => `id-${++clock.ids}`,
    ...over,
  };
  return { scanner: new Scanner(deps), order, queued, views, logs, clock };
}

test('a known card reaches the SCREEN before the queue', () => {
  const { scanner, order, queued, views, clock } = setup();
  assert.equal(scanner.handle('0002008108'), 'queued');
  assert.deepEqual(order, ['show', 'enqueue']);
  assert.deepEqual(views[0], { uid: '0002008108', at: '2026-10-05T07:00:00.000Z', student: JUAN });
  assert.deepEqual(queued[0], {
    eventId: 'id-1', cardUid: '0002008108', deviceId: 'gate-01-pc',
    scannedAt: '2026-10-05T07:00:00.000Z', clockSynced: true,
  });
  assert.equal(clock.unknown, 0);
});

test('an unknown card is shown as unknown, still queued, and asks for a resync', () => {
  const { scanner, queued, views, clock } = setup();
  assert.equal(scanner.handle('0000000001'), 'queued');
  assert.equal(views[0].student, null);
  assert.equal(queued.length, 1);
  assert.equal(clock.unknown, 1);
});

test('a double swipe is ignored: not shown, not queued', () => {
  const { scanner, queued, views, clock } = setup();
  scanner.handle('0002008108');
  clock.mono += 3_000;
  assert.equal(scanner.handle('0002008108'), 'cooldown');
  assert.equal(views.length, 1);
  assert.equal(queued.length, 1);
});

test('REVIEW FOCUS: the wall clock stepping back does not lock a card out', () => {
  const { scanner, queued, clock } = setup();
  scanner.handle('0002008108');
  clock.mono += 11_000;
  clock.now -= 3_600_000; // NTP correction
  assert.equal(scanner.handle('0002008108'), 'queued');
  assert.equal(queued.length, 2);
});

test('an unsynced clock is recorded, not refused', () => {
  const { scanner, queued } = setup({ clockSynced: () => false });
  scanner.handle('0002008108');
  assert.equal(queued[0].clockSynced, false);
});

test('REVIEW FOCUS: a failing database still shows the student and never throws', () => {
  const { scanner, views, logs } = setup({ queue: { enqueue: () => { throw new Error('disk I/O error'); } } });
  assert.equal(scanner.handle('0002008108'), 'dropped');
  assert.equal(views.length, 1);
  assert.equal(scanner.failures, 1);
  assert.ok(logs.some((l) => l.includes('disk I/O error')));
});

test('a full queue is reported as dropped, after the screen updated', () => {
  const { scanner, views } = setup({ queue: { enqueue: () => false } });
  assert.equal(scanner.handle('0002008108'), 'dropped');
  assert.equal(views.length, 1);
});
