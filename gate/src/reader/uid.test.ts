import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUid } from './uid.ts';

test('ten digits pass through unchanged, leading zeros kept', () => {
  assert.equal(normalizeUid('0002008108'), '0002008108');
});

test('whitespace and a carriage return from the keystroke stream are trimmed', () => {
  assert.equal(normalizeUid(' 0002008108\r'), '0002008108');
});

test('short, long and non-digit input is a misread', () => {
  for (const raw of ['', '000200810', '00020081080', '000200810A', '00020 08108', '1EA42C']) {
    assert.equal(normalizeUid(raw), null, JSON.stringify(raw));
  }
});
