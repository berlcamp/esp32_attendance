import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bumpMeta, getMeta, openDb, setMeta, tx } from './db.ts';
import { tmpPath } from './test-helpers.ts';

test('a new database gets every table and the current schema version', () => {
  const db = openDb(':memory:');
  const tables = (db.prepare("select name from sqlite_master where type = 'table'").all() as unknown as { name: string }[])
    .map((r) => r.name);
  for (const t of ['scans', 'roster', 'cards', 'meta']) assert.ok(tables.includes(t), t);
  assert.equal(getMeta(db, 'schema_version'), '1');
});

test('a file database runs in WAL mode with synchronous=FULL', () => {
  const db = openDb(tmpPath('gate.db'));
  assert.equal((db.prepare('pragma journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  assert.equal((db.prepare('pragma synchronous').get() as { synchronous: number }).synchronous, 2);
});

test('reopening keeps data and does not re-run migrations', () => {
  const path = tmpPath('gate.db');
  const a = openDb(path);
  setMeta(a, 'k', 'v');
  a.close();
  const b = openDb(path);
  assert.equal(getMeta(b, 'k'), 'v');
  assert.equal(getMeta(b, 'schema_version'), '1');
});

test('a database written by a newer gate version is refused, not misread', () => {
  const path = tmpPath('gate.db');
  const a = openDb(path);
  setMeta(a, 'schema_version', '99');
  a.close();
  assert.throws(() => openDb(path), /schema version 99/);
});

test('bumpMeta counts up from zero', () => {
  const db = openDb(':memory:');
  assert.equal(bumpMeta(db, 'dropped'), 1);
  assert.equal(bumpMeta(db, 'dropped', 2), 3);
});

test('tx rolls everything back when the body throws', () => {
  const db = openDb(':memory:');
  assert.throws(() => tx(db, () => { setMeta(db, 'k', 'v'); throw new Error('boom'); }), /boom/);
  assert.equal(getMeta(db, 'k'), null);
});
