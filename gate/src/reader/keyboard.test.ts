import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { KeyboardReader } from './keyboard.ts';
import { waitFor } from '../test-helpers.ts';

test('each typed line is a card, misreads are logged and dropped', async () => {
  const input = new PassThrough();
  const logs: string[] = [];
  const r = new KeyboardReader((l) => logs.push(l), input);
  const uids: string[] = [];
  r.onCard((u) => uids.push(u));
  r.start();
  assert.equal(r.online, true);
  input.write('0002008108\nabc\n\n0000000001\n');
  await waitFor(() => uids.length === 2);
  r.stop();
  assert.deepEqual(uids, ['0002008108', '0000000001']);
  assert.ok(logs.some((l) => l.includes('misread "abc"')));
});
