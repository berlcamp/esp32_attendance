import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TagReader } from './reader.ts';

class TestReader extends TagReader {
  start(): void {}
  stop(): void {}
  fire(uid: string): void { this.emit(uid); }
  goOnline(on: boolean): void { this.setOnline(on); }
}

test('a disabled reader drops hardware reads but still takes injected scans', () => {
  const r = new TestReader();
  const seen: string[] = [];
  r.onCard((uid) => seen.push(uid));
  r.setEnabled(false);
  r.fire('0002008108');
  r.inject('0000000001');
  assert.deepEqual(seen, ['0000000001']);
});

test("burst uids are B + 7 digits, unique, matching the server's synthetic filter", () => {
  const r = new TestReader();
  const seen: string[] = [];
  r.onCard((uid) => seen.push(uid));
  r.injectBurst(3);
  assert.deepEqual(seen, ['B0000001', 'B0000002', 'B0000003']);
  for (const uid of seen) assert.match(uid, /^B[0-9]{7}$/);
});

test('status handlers fire only when online actually changes', () => {
  const r = new TestReader();
  const seen: boolean[] = [];
  r.onStatus((on) => seen.push(on));
  r.goOnline(true);
  r.goOnline(true);
  r.goOnline(false);
  assert.deepEqual(seen, [true, false]);
  assert.equal(r.online, false);
});
