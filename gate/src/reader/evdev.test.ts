import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { EvdevReader, parseEvtestLine } from './evdev.ts';
import { tmpPath, waitFor } from '../test-helpers.ts';

// Stands in for `stdbuf -oL evtest --grab <device>`: prints evtest's real
// output format for the keys in FAKE_KEYS, holds, then exits.
const FAKE = tmpPath('fake-evtest.mjs');
writeFileSync(
  FAKE,
  `const lines = ['Input driver version is 1.0.1', 'Input device name: "SYC ID&IC USB Reader"', 'Testing ... (interrupt to exit)'];
for (const k of (process.env.FAKE_KEYS ?? '').split(',').filter(Boolean)) {
  lines.push('Event: time 1700000000.000001, type 4 (EV_MSC), code 4 (MSC_SCAN), value 70027');
  lines.push('Event: time 1700000000.000002, type 1 (EV_KEY), code 11 (' + k + '), value 1');
  lines.push('Event: time 1700000000.000003, -------------- SYN_REPORT ------------');
  lines.push('Event: time 1700000000.000004, type 1 (EV_KEY), code 11 (' + k + '), value 0');
}
process.stdout.write(lines.join('\\n') + '\\n');
setTimeout(() => process.exit(0), Number(process.env.FAKE_HOLD_MS ?? 50));
`,
);
const CARD_KEYS = [...'0002008108'].map((d) => `KEY_${d}`).concat('KEY_ENTER').join(',');

test('parseEvtestLine returns key-down names only', () => {
  assert.equal(parseEvtestLine('Event: time 1700000000.000002, type 1 (EV_KEY), code 11 (KEY_0), value 1'), 'KEY_0');
  assert.equal(parseEvtestLine('Event: time 1700000000.000004, type 1 (EV_KEY), code 11 (KEY_0), value 0'), null);
  assert.equal(parseEvtestLine('Event: time 1700000000.000004, type 1 (EV_KEY), code 11 (KEY_0), value 2'), null);
  assert.equal(parseEvtestLine('Event: time 1700000000.000001, type 4 (EV_MSC), code 4 (MSC_SCAN), value 70027'), null);
  assert.equal(parseEvtestLine('Event: time 1700000000.000003, -------------- SYN_REPORT ------------'), null);
  assert.equal(parseEvtestLine('Testing ... (interrupt to exit)'), null);
});

test('reads a card from evtest output and reports online', async () => {
  process.env.FAKE_KEYS = CARD_KEYS;
  process.env.FAKE_HOLD_MS = '300';
  const r = new EvdevReader('/dev/input/fake', () => {}, { command: [process.execPath, FAKE], retryMs: 1000 });
  const uids: string[] = [];
  const statuses: boolean[] = [];
  r.onCard((u) => uids.push(u));
  r.onStatus((s) => statuses.push(s));
  r.start();
  await waitFor(() => uids.length === 1);
  r.stop();
  assert.deepEqual(uids, ['0002008108']);
  assert.equal(statuses[0], true);
});

test('goes offline when evtest exits (unplugged) and comes back by respawning', async () => {
  process.env.FAKE_KEYS = '';
  process.env.FAKE_HOLD_MS = '20';
  const logs: string[] = [];
  const r = new EvdevReader('/dev/input/fake', (l) => logs.push(l), { command: [process.execPath, FAKE], retryMs: 30 });
  const statuses: boolean[] = [];
  r.onStatus((s) => statuses.push(s));
  r.start();
  await waitFor(() => statuses.length >= 3);
  r.stop();
  assert.deepEqual(statuses.slice(0, 3), [true, false, true]);
  assert.ok(logs.some((l) => l.includes('OFFLINE')));
});

test('a missing evtest binary is offline and retried, never a crash', async () => {
  const logs: string[] = [];
  const r = new EvdevReader('/dev/input/fake', (l) => logs.push(l), { command: ['/nonexistent/evtest'], retryMs: 20 });
  r.start();
  await waitFor(() => logs.length >= 1);
  await new Promise((res) => setTimeout(res, 100));
  r.stop();
  assert.equal(r.online, false);
  // Logged once per distinct failure, not once per retry.
  assert.equal(logs.filter((l) => l.includes('OFFLINE')).length, 1);
});
