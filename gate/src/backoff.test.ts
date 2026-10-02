import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Backoff } from './backoff.ts';

test('doubles from the base up to the ceiling, and resets on success', () => {
  const b = new Backoff(1000, 60_000);
  assert.equal(b.delayMs, 1000);
  const seen: number[] = [];
  for (let i = 0; i < 8; i++) {
    b.onFailure();
    seen.push(b.delayMs);
  }
  assert.deepEqual(seen, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(b.failures, 8);
  b.onSuccess();
  assert.equal(b.delayMs, 1000);
  assert.equal(b.failures, 0);
});
