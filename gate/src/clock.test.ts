import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClockProbe } from './clock.ts';

test('on Linux, synced means timedatectl says NTPSynchronized=yes', () => {
  let calls = 0;
  const probe = createClockProbe('linux', (cmd, args) => {
    calls++;
    assert.equal(cmd, 'timedatectl');
    assert.deepEqual(args, ['show', '-p', 'NTPSynchronized', '--value']);
    return 'yes\n';
  });
  assert.equal(probe(0), true);
  assert.equal(probe(30_000), true);
  assert.equal(calls, 1, 'cached for a minute');
});

test('an unsynced or failing timedatectl reports false, never throws', () => {
  assert.equal(createClockProbe('linux', () => 'no\n')(0), false);
  assert.equal(createClockProbe('linux', () => { throw new Error('not found'); })(0), false);
});

test('off Linux (the Mac) the clock is trusted', () => {
  assert.equal(createClockProbe('darwin', () => { throw new Error('must not run'); })(0), true);
});
