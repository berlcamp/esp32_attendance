import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JpegSplitter } from './jpeg.ts';

const frame = (fill: number, n = 6) => Buffer.from([0xff, 0xd8, ...Array<number>(n).fill(fill), 0xff, 0xd9]);

test('whole frames in one chunk come out one by one', () => {
  const s = new JpegSplitter();
  const out = s.push(Buffer.concat([frame(1), frame(2)]));
  assert.deepEqual(out, [frame(1), frame(2)]);
});

test('a frame split across chunks, even mid-marker, is reassembled', () => {
  const s = new JpegSplitter();
  const bytes = Buffer.concat([frame(3), frame(4)]);
  const out: Buffer[] = [];
  for (let i = 0; i < bytes.length; i++) out.push(...s.push(bytes.subarray(i, i + 1)));
  assert.deepEqual(out, [frame(3), frame(4)]);
});

test('garbage before a frame is skipped', () => {
  const s = new JpegSplitter();
  assert.deepEqual(s.push(Buffer.concat([Buffer.from([1, 2, 3, 0xff]), frame(5)])), [frame(5)]);
});

test('a frame that never ends does not grow the buffer forever', () => {
  const s = new JpegSplitter();
  s.push(Buffer.from([0xff, 0xd8]));
  s.push(Buffer.alloc(5 * 1024 * 1024, 7));
  assert.deepEqual(s.push(frame(6)), [frame(6)]);
});
