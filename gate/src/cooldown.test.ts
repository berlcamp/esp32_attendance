import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cooldown } from './cooldown.ts';

test('a second swipe within 10 s is ignored; at 10 s it counts', () => {
  const c = new Cooldown(10_000);
  assert.equal(c.accept('0002008108', 0), true);
  assert.equal(c.accept('0002008108', 9_999), false);
  assert.equal(c.accept('0002008108', 10_000), true);
});

test('an ignored swipe does not extend the window', () => {
  const c = new Cooldown(10_000);
  c.accept('a', 0);
  assert.equal(c.accept('a', 6_000), false);
  assert.equal(c.accept('a', 10_000), true);
});

test('different cards never block each other', () => {
  const c = new Cooldown(10_000);
  assert.equal(c.accept('a', 0), true);
  assert.equal(c.accept('b', 1), true);
});
