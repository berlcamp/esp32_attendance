import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpPath } from '../test-helpers.ts';
import { CaptureStore } from './captures.ts';

const JPEG = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]);

test('a capture is on disk for the uploader and in memory for the kiosk', () => {
  const store = new CaptureStore(tmpPath('captures'));
  const id = randomUUID();
  store.save(id, JPEG);
  assert.deepEqual(store.read(id), JPEG);
  assert.deepEqual(store.recent(id), JPEG);
  store.remove(id);
  assert.equal(store.read(id), null);
  assert.deepEqual(store.recent(id), JPEG, 'the kiosk keeps it after the upload');
});

test('only the last few taps are kept in memory', () => {
  const store = new CaptureStore(tmpPath('captures'));
  const ids = Array.from({ length: 10 }, () => randomUUID());
  for (const id of ids) store.save(id, JPEG);
  assert.equal(store.recent(ids[0]), null);
  assert.deepEqual(store.recent(ids[9]), JPEG);
});

test('a path is never built from anything but an event id', () => {
  const store = new CaptureStore(tmpPath('captures'));
  assert.throws(() => store.save('../../etc/passwd', JPEG), /not an event id/);
  assert.equal(store.read('../gate'), null);
});

test('prune removes captures older than the limit', () => {
  const dir = tmpPath('captures');
  const store = new CaptureStore(dir);
  const old = randomUUID();
  const fresh = randomUUID();
  store.save(old, JPEG);
  store.save(fresh, JPEG);
  const day = 24 * 3_600_000;
  utimesSync(join(dir, `${old}.jpg`), new Date(Date.now() - 8 * day), new Date(Date.now() - 8 * day));
  assert.equal(store.prune(7 * day), 1);
  assert.equal(store.read(old), null);
  assert.deepEqual(store.read(fresh), JPEG);
});
