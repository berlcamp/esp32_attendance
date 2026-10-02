import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIMULATED_ROSTER, SimulatedReader } from './simulated.ts';
import { normalizeUid } from './uid.ts';
import { waitFor } from '../test-helpers.ts';

test('cycles through the fake roster on its interval', async () => {
  const r = new SimulatedReader(5);
  const uids: string[] = [];
  r.onCard((u) => uids.push(u));
  r.start();
  await waitFor(() => uids.length >= 3);
  r.stop();
  assert.deepEqual(uids.slice(0, 3), SIMULATED_ROSTER.slice(0, 3));
});

test('every simulated uid is a valid card uid', () => {
  for (const uid of SIMULATED_ROSTER) assert.equal(normalizeUid(uid), uid);
});
