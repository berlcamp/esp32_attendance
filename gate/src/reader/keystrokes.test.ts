import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeystrokeAssembler, type Assembled } from './keystrokes.ts';

const card = (digits: string, prefix = 'KEY_', enter = 'KEY_ENTER') =>
  [...digits].map((d) => `${prefix}${d}`).concat(enter);

function type(a: KeystrokeAssembler, keys: string[], start = 0, step = 5): Assembled | null {
  let out: Assembled | null = null;
  keys.forEach((k, i) => {
    const r = a.feed(k, start + i * step);
    if (r) out = r;
  });
  return out;
}

test('ten digits then Enter is a uid, leading zeros kept', () => {
  assert.deepEqual(type(new KeystrokeAssembler(), card('0002008108')), { uid: '0002008108' });
});

test('keypad digits and keypad Enter work too', () => {
  assert.deepEqual(type(new KeystrokeAssembler(), card('0002008108', 'KEY_KP', 'KEY_KPENTER')), { uid: '0002008108' });
});

test('a short read is a misread, not a uid', () => {
  assert.deepEqual(type(new KeystrokeAssembler(), card('000200810')), { misread: '000200810' });
});

test('REVIEW FOCUS: half a card then a pause is discarded before the next card', () => {
  const a = new KeystrokeAssembler(500);
  type(a, ['KEY_0', 'KEY_0', 'KEY_0', 'KEY_2'], 0);
  assert.deepEqual(type(a, card('0002008108'), 2000), { uid: '0002008108' });
});

test('keys that are not digits or Enter are ignored', () => {
  const keys = card('0002008108');
  keys.splice(3, 0, 'KEY_LEFTSHIFT');
  assert.deepEqual(type(new KeystrokeAssembler(), keys), { uid: '0002008108' });
});

test('a lone Enter produces nothing', () => {
  assert.equal(new KeystrokeAssembler().feed('KEY_ENTER', 0), null);
});
