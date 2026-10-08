import { DatabaseSync } from 'node:sqlite';

// Each entry upgrades the schema by one version, inside a transaction. Append
// new entries; never edit a shipped one -- a gate in the field has already
// applied it.
const MIGRATIONS: readonly string[] = [
  `create table scans (
     id           integer primary key autoincrement,
     event_id     text    not null unique,
     card_uid     text    not null,
     device_id    text    not null,
     scanned_at   text    not null,
     clock_synced integer not null,
     sent_at      text
   );
   create index scans_unsent_idx on scans (id) where sent_at is null;
   create table roster (
     student_id   text primary key,
     full_name    text not null,
     student_no   text,
     grade_level  text,
     section_name text
   );
   create table cards (
     card_uid   text primary key,
     student_id text not null
   );`,
  // The gate camera. photo: a capture was saved for this scan. image_path: its
  // object path once uploaded. photo_failures: uploads the server refused; at
  // the limit the scan is sent without its photo rather than held back.
  `alter table scans add column photo          integer not null default 0;
   alter table scans add column image_path     text;
   alter table scans add column photo_failures integer not null default 0;`,
];

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL + FULL: a committed scan survives a power cut at the gate.
  db.exec('pragma journal_mode = wal; pragma synchronous = full; pragma busy_timeout = 5000;');
  db.exec('create table if not exists meta (key text primary key, value text not null)');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const current = Number(getMeta(db, 'schema_version') ?? '0');
  if (current > MIGRATIONS.length) {
    // A rollback to an older release after a newer one upgraded the file.
    throw new Error(
      `gate.db is at schema version ${current} but this release knows ${MIGRATIONS.length}; ` +
        'deploy the newer release again rather than rolling back past a schema change',
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      setMeta(db, 'schema_version', String(v + 1));
    });
  }
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('begin immediate');
  try {
    const result = fn();
    db.exec('commit');
    return result;
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('select value from meta where key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
  ).run(key, value);
}

export function bumpMeta(db: DatabaseSync, key: string, by = 1): number {
  const next = Number(getMeta(db, key) ?? '0') + by;
  setMeta(db, key, String(next));
  return next;
}
