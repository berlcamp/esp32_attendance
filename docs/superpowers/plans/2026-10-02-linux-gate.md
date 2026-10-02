# Linux Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ESP32 gate with a Node service on an Ubuntu mini PC that reads a USB RFID reader, shows the student on a kiosk monitor within a second, and queues every scan durably to `pta.record_attendance()`.

**Architecture:** One Node process (`gate-scanner.service`) owns the reader, a SQLite queue and roster mirror, an uploader loop, and a localhost HTTP server that serves the kiosk page over SSE plus a JSON control API. A second unit (`gate-display.service`) runs `cage` + Chrome pointed at that page. On a scan the screen is updated from the local mirror *before* the scan is queued, so the monitor behaves the same online and offline.

**Tech Stack:** TypeScript run directly by Node 22 (type stripping) on the Mac, bundled by esbuild into one `gate.mjs` for the mini PC; `node:sqlite`, `node:http`, `node:test`, global `fetch`; `evtest` for the exclusive evdev grab; systemd, `cage`, Google Chrome.

**Spec:** `docs/superpowers/specs/2026-09-19-linux-gate-migration-design.md`

## Global Constraints

- All new code lives in `gate/`. Do not modify `src/`, `lib/`, `include/`, `platformio.ini` (ESP32 firmware stays as the rollback) or `web/`.
- Node `>=22.18` on the Mac (runs `.ts` directly); Node 22 LTS (`>=22.13`, for unflagged `node:sqlite`) on the mini PC.
- **Zero runtime dependencies.** Dev dependencies only: `esbuild`, `typescript`, `@types/node`, installed with `-E` (exact versions) and `package-lock.json` committed.
- TypeScript must be erasable syntax only (Node strips types, it does not compile): no `enum`, no `namespace`, no constructor parameter properties. Use `#private` fields. Relative imports carry the `.ts` extension. `import type` for type-only imports.
- **Card UID:** exactly ten decimal digits, kept as a string, leading zeros preserved (`0002008108`). Never `Number()` a UID.
- **Synthetic burst UIDs:** `B` + 7 digits (`B0000001`), matching the server's `^B[0-9]{7}$` filter that keeps them off `/enroll`.
- Constants copied from the spec/firmware: batch `50`; backoff `1000` → `60000` ms doubling; `LATE_AFTER_S = 15` sets `queued=true`; card cooldown `10000` ms; queue cap `100000` unsent rows (newest refused, `dropped` counted); roster resync every `5` min; unknown-card resync at most once per `60` s; roster stale after `1` h; sent rows pruned after `7` days.
- SQLite at `/var/lib/gate/gate.db`, `journal_mode=WAL`, `synchronous=FULL`.
- Supabase: POST `${SUPABASE_URL}/rest/v1/rpc/<fn>` with headers `apikey`, `Authorization: Bearer <anon>`, `Content-Type: application/json`, `Content-Profile: pta`. Never the `service_role` key. Never `supabase db push`.
- `record_attendance` body: `{"events":[{event_id, card_uid, device_id, scanned_at, clock_synced, direction:"in", queued}]}`; it returns the number of rows newly inserted.
- `gate_roster_snapshot` body: `{"p_device_id": DEVICE_ID, "p_token": GATE_TOKEN}`; returns `{school_id, device_id, generated_at, students:[{student_id, full_name, student_no, grade_level, section_name}], cards:[{card_uid, student_id}]}` (all text or null).
- The HTTP server binds `127.0.0.1:8080` only. The control API is unauthenticated; never bind it to `0.0.0.0`.
- Screen first, queue second, on every scan.

## Review Focus

1. **A captive portal or proxy answers `record_attendance` with `200` and an HTML body** (school Wi-Fi login page). Expected: treated as a failure, nothing acked, scans stay queued. Test in Task 3.
2. **NTP steps the wall clock backwards between two swipes.** Expected: the 10 s cooldown is measured on a monotonic clock, so the second swipe is judged on real elapsed time. Test in Task 6.
3. **The snapshot comes back with zero students** (school-year rollover, no active year). Expected: a populated mirror is never replaced by an empty one; the screen keeps working and the log says why. Test in Task 4.
4. **SQLite throws during a swipe** (disk full, I/O error). Expected: the student still appears on screen, the process does not crash, the failure is logged and counted. Test in Task 6.
5. **Half a card's digits arrive, then a pause, then a full card** (a skimmed swipe). Expected: the stale partial digits are discarded and only the full card is read. Test in Task 5.

---

## File Structure

```
gate/
  package.json, package-lock.json, tsconfig.json, .gitignore, README.md
  scripts/build.mjs            esbuild bundle -> dist/gate.mjs, copies deploy/, writes dist/VERSION
  src/
    log.ts                     Log type
    test-helpers.ts            waitFor(), tmpPath() for tests
    config.ts                  env -> Config, every problem reported at once
    db.ts                      openDb (pragmas, migrations), tx, meta helpers
    queue.ts                   ScanQueue: enqueue/take/ack/depth/prune/dropped
    backoff.ts                 Backoff (port of lib/core/Backoff.h)
    supabase.ts                createRpc, explainFailure hints
    uploader.ts                toPayload, parseInserted, Uploader loop
    roster.ts                  RosterMirror (SQLite), RosterSync (RPC, staleness, resync limit)
    cooldown.ts                Cooldown on monotonic ms
    clock.ts                   createClockProbe (timedatectl on Linux)
    scanner.ts                 Scanner: cooldown -> lookup -> show -> enqueue
    control.ts                 handleControl: JSON control routes
    reader/
      uid.ts                   normalizeUid
      reader.ts                TagReader base: enable, inject, injectBurst, online
      keystrokes.ts            KeystrokeAssembler (evdev key names -> uid)
      evdev.ts                 EvdevReader (spawns `stdbuf -oL evtest --grab`), parseEvtestLine
      keyboard.ts              KeyboardReader (stdin lines; Mac development)
      simulated.ts             SimulatedReader (one fake card per 10 s)
      index.ts                 createReader(config, log)
    display/
      page.ts                  PAGE_HTML (kiosk page, text only)
      sse.ts                   GateState, GateEvent, formatSse, SseHub
      server.ts                createGateServer: /, /events, /control/*
    main.ts                    wiring, timers, signals
    *.test.ts                  node:test suites beside each module
  deploy/
    gate-scanner.service, gate-display.service, cage.pam, gate.env.example
    setup-minipc.sh            one-time provisioning (run as root on the mini PC)
    deploy.sh, rollback.sh     run on the Mac
```

---

### Task 1: Scaffold `gate/`, configuration and card-UID validation

**Files:**
- Create: `gate/package.json`, `gate/tsconfig.json`, `gate/.gitignore`, `gate/src/log.ts`, `gate/src/test-helpers.ts`
- Create: `gate/src/config.ts`, `gate/src/reader/uid.ts`
- Test: `gate/src/config.test.ts`, `gate/src/reader/uid.test.ts`

**Interfaces:**
- Produces: `type Log = (line: string) => void`; `waitFor(cond: () => boolean, ms?: number): Promise<void>`; `tmpPath(name: string): string`; `type ReaderKind = 'evdev' | 'keyboard' | 'simulated'`; `interface Config { supabaseUrl; anonKey; deviceId; gateToken; reader: ReaderKind; readerDevice: string | null; dbPath; httpHost; httpPort: number }`; `loadConfig(env: Record<string, string | undefined>): Config` (throws one `Error` listing every problem); `normalizeUid(raw: string): string | null`.

- [ ] **Step 1: Create the package skeleton**

`gate/package.json`:

```json
{
  "name": "gate",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.18" },
  "scripts": {
    "test": "node --disable-warning=ExperimentalWarning --test --test-reporter=spec \"src/**/*.test.ts\"",
    "typecheck": "tsc --noEmit",
    "dev": "node --disable-warning=ExperimentalWarning --env-file-if-exists=.env.local src/main.ts",
    "build": "node scripts/build.mjs"
  }
}
```

`gate/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`gate/.gitignore`:

```
node_modules/
dist/
.env.local
*.db
*.db-wal
*.db-shm
```

`gate/src/log.ts`:

```ts
// Every module logs through this so tests can capture lines. In production it
// is console.log, and journald adds the timestamps.
export type Log = (line: string) => void;
```

`gate/src/test-helpers.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`waitFor timed out after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function tmpPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'gate-')), name);
}
```

Then install the dev dependencies (exact versions, lockfile committed):

```bash
cd gate && npm install -D -E esbuild typescript @types/node@22
```

- [ ] **Step 2: Write the failing tests**

`gate/src/reader/uid.test.ts`:

```ts
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
```

`gate/src/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.ts';

const VALID = {
  SUPABASE_URL: 'https://example.supabase.co/',
  SUPABASE_ANON_KEY: 'anon-key',
  DEVICE_ID: 'gate-01-pc',
  GATE_TOKEN: 'gt_' + 'a'.repeat(64),
  READER: 'evdev',
  READER_DEVICE: '/dev/input/by-id/usb-reader-event-kbd',
};

test('a complete environment loads, with defaults filled in', () => {
  const c = loadConfig(VALID);
  assert.equal(c.supabaseUrl, 'https://example.supabase.co');
  assert.equal(c.reader, 'evdev');
  assert.equal(c.readerDevice, '/dev/input/by-id/usb-reader-event-kbd');
  assert.equal(c.dbPath, '/var/lib/gate/gate.db');
  assert.equal(c.httpHost, '127.0.0.1');
  assert.equal(c.httpPort, 8080);
});

test('every missing key is reported at once, not one per restart', () => {
  assert.throws(() => loadConfig({}), (err: Error) => {
    for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'DEVICE_ID', 'GATE_TOKEN', 'READER_DEVICE']) {
      assert.match(err.message, new RegExp(key));
    }
    return true;
  });
});

test('READER_DEVICE is only required for the evdev reader', () => {
  const { READER_DEVICE: _unused, ...rest } = VALID;
  assert.equal(loadConfig({ ...rest, READER: 'simulated' }).readerDevice, null);
  assert.throws(() => loadConfig(rest), /READER_DEVICE/);
});

test('a token that did not come from issue_gate_device_token is refused', () => {
  assert.throws(() => loadConfig({ ...VALID, GATE_TOKEN: 'secret' }), /GATE_TOKEN/);
});

test('device ids follow the pta.gate_devices format', () => {
  assert.throws(() => loadConfig({ ...VALID, DEVICE_ID: 'Gate 01' }), /DEVICE_ID/);
});

test('plain http is allowed only for a local test server', () => {
  assert.equal(loadConfig({ ...VALID, SUPABASE_URL: 'http://127.0.0.1:5555' }).supabaseUrl, 'http://127.0.0.1:5555');
  assert.throws(() => loadConfig({ ...VALID, SUPABASE_URL: 'http://example.supabase.co' }), /SUPABASE_URL/);
});

test('an unknown reader kind and a bad port are refused', () => {
  assert.throws(() => loadConfig({ ...VALID, READER: 'nfc' }), /READER must be/);
  assert.throws(() => loadConfig({ ...VALID, HTTP_PORT: 'abc' }), /HTTP_PORT/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd gate && npm test`
Expected: FAIL — `Cannot find module '.../config.ts'` and `'.../uid.ts'`.

- [ ] **Step 4: Implement**

`gate/src/reader/uid.ts`:

```ts
// The Sycreader USB reader types an EM4100 card as ten decimal digits then
// Enter (prerequisite test, 2026-10-02). That string IS the card's identity in
// pta.student_cards: leading zeros kept, never converted to a number. Anything
// else is a misread -- a skimmed swipe or a stray key -- and must never become
// attendance.
const TEN_DIGITS = /^\d{10}$/;

export function normalizeUid(raw: string): string | null {
  const s = raw.trim();
  return TEN_DIGITS.test(s) ? s : null;
}
```

`gate/src/config.ts`:

```ts
// Configuration comes from /etc/gate/gate.env via systemd's EnvironmentFile=,
// replacing include/secrets.h. Every problem is reported in one error so a
// misconfigured box needs one fix, not one restart per missing key.
export type ReaderKind = 'evdev' | 'keyboard' | 'simulated';

export interface Config {
  supabaseUrl: string;
  anonKey: string;
  deviceId: string;
  gateToken: string;
  reader: ReaderKind;
  readerDevice: string | null;
  dbPath: string;
  httpHost: string;
  httpPort: number;
}

const READERS: readonly string[] = ['evdev', 'keyboard', 'simulated'];
// Same check as pta.gate_devices.gate_devices_id_format.
const DEVICE_ID = /^[a-z0-9][a-z0-9._-]{1,62}$/;
// What pta.issue_gate_device_token() returns.
const GATE_TOKEN = /^gt_[0-9a-f]{64}$/;
// https for Supabase; plain http only for a test server on this machine.
const SUPABASE_URL = /^(https:\/\/.+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];
  const need = (key: string): string => {
    const value = env[key]?.trim() ?? '';
    if (!value) problems.push(`${key} is not set`);
    return value;
  };

  const supabaseUrl = need('SUPABASE_URL').replace(/\/+$/, '');
  const anonKey = need('SUPABASE_ANON_KEY');
  const deviceId = need('DEVICE_ID');
  const gateToken = need('GATE_TOKEN');

  if (supabaseUrl && !SUPABASE_URL.test(supabaseUrl)) {
    problems.push(`SUPABASE_URL must be https:// (got "${supabaseUrl}")`);
  }
  if (deviceId && !DEVICE_ID.test(deviceId)) {
    problems.push(`DEVICE_ID "${deviceId}" does not match ${DEVICE_ID}`);
  }
  if (gateToken && !GATE_TOKEN.test(gateToken)) {
    problems.push('GATE_TOKEN is not a gt_ token from pta.issue_gate_device_token()');
  }

  const reader = env.READER?.trim() || 'evdev';
  if (!READERS.includes(reader)) {
    problems.push(`READER must be evdev, keyboard or simulated (got "${reader}")`);
  }
  const readerDevice = env.READER_DEVICE?.trim() || null;
  if (reader === 'evdev' && !readerDevice) {
    problems.push('READER_DEVICE is required when READER=evdev');
  }

  const httpPort = Number(env.HTTP_PORT?.trim() || '8080');
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    problems.push(`HTTP_PORT "${env.HTTP_PORT}" is not a port number`);
  }

  if (problems.length > 0) {
    throw new Error(`gate configuration is invalid:\n  - ${problems.join('\n  - ')}`);
  }

  return {
    supabaseUrl,
    anonKey,
    deviceId,
    gateToken,
    reader: reader as ReaderKind,
    readerDevice,
    dbPath: env.DB_PATH?.trim() || '/var/lib/gate/gate.db',
    httpHost: env.HTTP_HOST?.trim() || '127.0.0.1',
    httpPort,
  };
}
```

- [ ] **Step 5: Run the tests and the type check**

Run: `cd gate && npm test && npm run typecheck`
Expected: all tests PASS; `tsc` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add gate/package.json gate/package-lock.json gate/tsconfig.json gate/.gitignore gate/src
git commit -m "Scaffold the Linux gate service with config and card-uid validation"
```

---

### Task 2: SQLite database and the durable scan queue

**Files:**
- Create: `gate/src/db.ts`, `gate/src/queue.ts`
- Test: `gate/src/db.test.ts`, `gate/src/queue.test.ts`

**Interfaces:**
- Consumes: `tmpPath` (Task 1).
- Produces: `openDb(path: string): DatabaseSync`; `tx<T>(db, fn: () => T): T`; `getMeta(db, key): string | null`; `setMeta(db, key, value: string): void`; `bumpMeta(db, key, by?: number): number`; `interface NewScan { eventId: string; cardUid: string; deviceId: string; scannedAt: string; clockSynced: boolean }`; `interface QueuedScan extends NewScan { id: number }`; `class ScanQueue { constructor(db, maxPending = 100_000); enqueue(s: NewScan): boolean; take(n: number): QueuedScan[]; ack(ids: number[], sentAt: string): void; depth(): number; prune(sentBefore: string): number; dropped(): number }`. Tables `roster(student_id, full_name, student_no, grade_level, section_name)` and `cards(card_uid, student_id)` are created here for Task 4.

- [ ] **Step 1: Write the failing tests**

`gate/src/db.test.ts`:

```ts
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
```

`gate/src/queue.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { ScanQueue, type NewScan } from './queue.ts';
import { tmpPath } from './test-helpers.ts';

const scan = (n: number, uid = '0002008108'): NewScan => ({
  eventId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  cardUid: uid,
  deviceId: 'gate-01-pc',
  scannedAt: `2026-10-05T07:00:${String(n % 60).padStart(2, '0')}.000Z`,
  clockSynced: true,
});

test('scans come back oldest first, uid still a string with its zeros', () => {
  const q = new ScanQueue(openDb(':memory:'));
  for (const n of [1, 2, 3]) assert.equal(q.enqueue(scan(n)), true);
  const taken = q.take(10);
  assert.deepEqual(taken.map((s) => s.eventId), [scan(1).eventId, scan(2).eventId, scan(3).eventId]);
  assert.equal(taken[0].cardUid, '0002008108');
  assert.equal(taken[0].clockSynced, true);
  assert.equal(taken[0].scannedAt, scan(1).scannedAt);
});

test('take returns at most n', () => {
  const q = new ScanQueue(openDb(':memory:'));
  for (const n of [1, 2, 3, 4, 5]) q.enqueue(scan(n));
  assert.equal(q.take(2).length, 2);
});

test('acked scans leave the queue, and acking twice is harmless', () => {
  const q = new ScanQueue(openDb(':memory:'));
  for (const n of [1, 2, 3]) q.enqueue(scan(n));
  const [a, b] = q.take(2);
  q.ack([a.id, b.id], '2026-10-05T07:01:00.000Z');
  q.ack([a.id, b.id], '2026-10-05T07:02:00.000Z');
  assert.equal(q.depth(), 1);
  assert.deepEqual(q.take(10).map((s) => s.eventId), [scan(3).eventId]);
});

test('a full queue refuses the NEWEST scan and counts it as dropped', () => {
  const q = new ScanQueue(openDb(':memory:'), 2);
  assert.deepEqual([1, 2, 3].map((n) => q.enqueue(scan(n))), [true, true, false]);
  assert.equal(q.depth(), 2);
  assert.equal(q.dropped(), 1);
  assert.deepEqual(q.take(10).map((s) => s.eventId), [scan(1).eventId, scan(2).eventId]);
});

test('a duplicate event_id is rejected by the database, never stored twice', () => {
  const q = new ScanQueue(openDb(':memory:'));
  q.enqueue(scan(1));
  assert.throws(() => q.enqueue(scan(1)), /UNIQUE/);
  assert.equal(q.depth(), 1);
});

test('pending scans survive a restart', () => {
  const path = tmpPath('gate.db');
  const db = openDb(path);
  new ScanQueue(db).enqueue(scan(1));
  db.close();
  assert.equal(new ScanQueue(openDb(path)).depth(), 1);
});

test('prune deletes only SENT rows older than the cutoff', () => {
  const q = new ScanQueue(openDb(':memory:'));
  for (const n of [1, 2, 3]) q.enqueue(scan(n));
  const [a, b] = q.take(2);
  q.ack([a.id], '2026-10-01T00:00:00.000Z');
  q.ack([b.id], '2026-10-09T00:00:00.000Z');
  assert.equal(q.prune('2026-10-05T00:00:00.000Z'), 1);
  assert.equal(q.depth(), 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd gate && npm test`
Expected: FAIL — cannot find `./db.ts` / `./queue.ts`.

- [ ] **Step 3: Implement**

`gate/src/db.ts`:

```ts
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
```

`gate/src/queue.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { bumpMeta, getMeta, tx } from './db.ts';

export interface NewScan {
  eventId: string;
  cardUid: string;
  deviceId: string;
  scannedAt: string;
  clockSynced: boolean;
}

export interface QueuedScan extends NewScan {
  id: number;
}

interface Row {
  id: number;
  event_id: string;
  card_uid: string;
  device_id: string;
  scanned_at: string;
  clock_synced: number;
}

const toScan = (r: Row): QueuedScan => ({
  id: r.id,
  eventId: r.event_id,
  cardUid: r.card_uid,
  deviceId: r.device_id,
  scannedAt: r.scanned_at,
  clockSynced: r.clock_synced === 1,
});

// The durable queue between the reader and the uploader. Same contract as the
// firmware's LittleFS log: a full queue keeps the OLDEST scans and refuses the
// newest, counting each refusal, so a wedged uploader cannot fill the disk.
export class ScanQueue {
  #db: DatabaseSync;
  #max: number;

  constructor(db: DatabaseSync, maxPending = 100_000) {
    this.#db = db;
    this.#max = maxPending;
  }

  enqueue(scan: NewScan): boolean {
    if (this.depth() >= this.#max) {
      bumpMeta(this.#db, 'dropped');
      return false;
    }
    this.#db
      .prepare('insert into scans (event_id, card_uid, device_id, scanned_at, clock_synced) values (?, ?, ?, ?, ?)')
      .run(scan.eventId, scan.cardUid, scan.deviceId, scan.scannedAt, scan.clockSynced ? 1 : 0);
    return true;
  }

  take(n: number): QueuedScan[] {
    const rows = this.#db
      .prepare(
        'select id, event_id, card_uid, device_id, scanned_at, clock_synced from scans where sent_at is null order by id limit ?',
      )
      .all(n) as unknown as Row[];
    return rows.map(toScan);
  }

  ack(ids: number[], sentAt: string): void {
    if (ids.length === 0) return;
    tx(this.#db, () => {
      const stmt = this.#db.prepare('update scans set sent_at = ? where id = ? and sent_at is null');
      for (const id of ids) stmt.run(sentAt, id);
    });
  }

  depth(): number {
    return (this.#db.prepare('select count(*) as n from scans where sent_at is null').get() as { n: number }).n;
  }

  prune(sentBefore: string): number {
    return Number(this.#db.prepare('delete from scans where sent_at is not null and sent_at < ?').run(sentBefore).changes);
  }

  dropped(): number {
    return Number(getMeta(this.#db, 'dropped') ?? '0');
  }
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `cd gate && npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add gate/src/db.ts gate/src/db.test.ts gate/src/queue.ts gate/src/queue.test.ts
git commit -m "Add the gate's SQLite database and durable scan queue"
```

---

### Task 3: Supabase RPC client and the uploader

**Files:**
- Create: `gate/src/backoff.ts`, `gate/src/supabase.ts`, `gate/src/uploader.ts`
- Test: `gate/src/backoff.test.ts`, `gate/src/supabase.test.ts`, `gate/src/uploader.test.ts`

**Interfaces:**
- Consumes: `ScanQueue`, `QueuedScan`, `openDb` (Task 2); `Log`, `waitFor` (Task 1).
- Produces: `class Backoff { constructor(baseMs = 1000, maxMs = 60_000); delayMs; failures; onFailure(); onSuccess() }`; `interface RpcResult { status: number; body: string }` (`status` 0 = network error or timeout); `type Rpc = (fn: string, args: unknown) => Promise<RpcResult>`; `createRpc(supabaseUrl, anonKey, timeoutMs = 15_000): Rpc`; `explainFailure(body: string, deviceId: string): string | null`; `UPLOAD_BATCH_SIZE = 50`; `LATE_AFTER_S = 15`; `interface AttendanceEvent`; `toPayload(scans: QueuedScan[], nowMs: number): AttendanceEvent[]`; `parseInserted(body: string): number | null`; `class Uploader { constructor(queue, rpc, deviceId, log, backoff?); netOn: boolean; sent; failed; duplicates: number; lastOk: boolean | null; step(nowMs?): Promise<number>; run(): Promise<void>; stop(): void }`.

- [ ] **Step 1: Write the failing tests**

`gate/src/backoff.test.ts`:

```ts
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
```

`gate/src/supabase.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRpc, explainFailure } from './supabase.ts';

type Handler = (req: IncomingMessage, body: string) => Promise<{ status: number; body: string }>;

async function withServer(handler: Handler, fn: (url: string) => Promise<void>): Promise<void> {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const r = await handler(req, body);
    res.writeHead(r.status);
    res.end(r.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test('posts JSON to /rest/v1/rpc/<fn> with the anon key and the pta profile', async () => {
  let seen: { url?: string; headers?: IncomingHttpHeaders; body?: string } = {};
  await withServer(
    async (req, body) => {
      seen = { url: req.url, headers: req.headers, body };
      return { status: 200, body: '3' };
    },
    async (url) => {
      const rpc = createRpc(url, 'anon-key');
      assert.deepEqual(await rpc('record_attendance', { events: [] }), { status: 200, body: '3' });
    },
  );
  assert.equal(seen.url, '/rest/v1/rpc/record_attendance');
  assert.equal(seen.headers?.apikey, 'anon-key');
  assert.equal(seen.headers?.authorization, 'Bearer anon-key');
  assert.equal(seen.headers?.['content-profile'], 'pta');
  assert.equal(seen.headers?.['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(seen.body ?? ''), { events: [] });
});

test('a refused connection is status 0, not an exception', async () => {
  const r = await createRpc('http://127.0.0.1:1', 'k')('record_attendance', {});
  assert.equal(r.status, 0);
});

test('a server that never answers times out as status 0', async () => {
  await withServer(
    () => new Promise(() => {}),
    async (url) => {
      const r = await createRpc(url, 'k', 50)('record_attendance', {});
      assert.equal(r.status, 0);
    },
  );
});

test('explainFailure turns known server errors into the fix', () => {
  assert.match(explainFailure('{"code":"PGRST106"}', 'gate-01-pc') ?? '', /Exposed schemas/);
  assert.match(explainFailure('{"code":"PGRST202"}', 'gate-01-pc') ?? '', /migration/);
  assert.match(
    explainFailure('{"code":"42501","message":"unregistered or inactive gate device: gate-01-pc"}', 'gate-01-pc') ?? '',
    /not in pta\.gate_devices/,
  );
  assert.match(
    explainFailure('{"code":"42501","message":"invalid gate device credentials"}', 'gate-01-pc') ?? '',
    /issue_gate_device_token\('gate-01-pc'\)/,
  );
  assert.match(explainFailure('{"code":"42501"}', 'gate-01-pc') ?? '', /EXECUTE/);
  assert.equal(explainFailure('something else', 'gate-01-pc'), null);
});
```

`gate/src/uploader.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDb } from './db.ts';
import { ScanQueue } from './queue.ts';
import type { Rpc, RpcResult } from './supabase.ts';
import { Uploader, parseInserted, toPayload, type AttendanceEvent } from './uploader.ts';
import { waitFor } from './test-helpers.ts';

const NOW = Date.parse('2026-10-05T07:00:30.000Z');

function setup(responses: RpcResult[] = []) {
  const queue = new ScanQueue(openDb(':memory:'));
  const calls: { fn: string; events: AttendanceEvent[] }[] = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, events: (args as { events: AttendanceEvent[] }).events });
    return responses.shift() ?? { status: 200, body: String((args as { events: unknown[] }).events.length) };
  };
  const logs: string[] = [];
  const up = new Uploader(queue, rpc, 'gate-01-pc', (l) => logs.push(l));
  const add = (n: number) => {
    for (let i = 0; i < n; i++) {
      queue.enqueue({ eventId: randomUUID(), cardUid: '0002008108', deviceId: 'gate-01-pc', scannedAt: new Date(NOW).toISOString(), clockSynced: true });
    }
  };
  return { queue, calls, up, logs, add };
}

test('toPayload builds the record_attendance event, queued after 15 s', () => {
  const base = { id: 1, eventId: 'e1', cardUid: '0002008108', deviceId: 'gate-01-pc', clockSynced: false };
  const fresh = new Date(NOW - 14_000).toISOString();
  const [a, b] = toPayload(
    [{ ...base, scannedAt: fresh }, { ...base, id: 2, eventId: 'e2', scannedAt: new Date(NOW - 16_000).toISOString() }],
    NOW,
  );
  assert.deepEqual(a, {
    event_id: 'e1', card_uid: '0002008108', device_id: 'gate-01-pc', scanned_at: fresh,
    clock_synced: false, direction: 'in', queued: false,
  });
  assert.equal(b.queued, true);
});

test('parseInserted accepts only a bare non-negative integer', () => {
  assert.equal(parseInserted('3'), 3);
  assert.equal(parseInserted(' 12\n'), 12);
  for (const body of ['', '<html>', '"3"', '-1', '3.5', '{"n":3}']) assert.equal(parseInserted(body), null, body);
});

test('a delivered batch is acked and counted', async () => {
  const { queue, calls, up, add } = setup([{ status: 200, body: '2' }]);
  add(2);
  assert.equal(await up.step(NOW), 0);
  assert.equal(queue.depth(), 0);
  assert.equal(up.sent, 2);
  assert.equal(up.lastOk, true);
  assert.equal(calls[0].fn, 'record_attendance');
  assert.equal(calls[0].events.length, 2);
});

test('a shortfall in inserted rows is duplicates already delivered, not a failure', async () => {
  const { queue, up, add } = setup([{ status: 200, body: '1' }]);
  add(3);
  await up.step(NOW);
  assert.equal(queue.depth(), 0);
  assert.equal(up.duplicates, 2);
});

test('a failure keeps every scan and backs off', async () => {
  const { queue, up, add } = setup([{ status: 503, body: 'down' }, { status: 0, body: 'ECONNREFUSED' }]);
  add(2);
  assert.equal(await up.step(NOW), 2000);
  assert.equal(await up.step(NOW), 4000);
  assert.equal(queue.depth(), 2);
  assert.equal(up.failed, 2);
  assert.equal(up.lastOk, false);
});

test('REVIEW FOCUS: a 200 that is not a row count (captive portal) is a failure', async () => {
  const { queue, up, logs, add } = setup([{ status: 200, body: '<html>Log in to school Wi-Fi</html>' }]);
  add(1);
  assert.equal(await up.step(NOW), 2000);
  assert.equal(queue.depth(), 1);
  assert.equal(up.sent, 0);
  assert.ok(logs.some((l) => l.includes('captive portal')), logs.join('\n'));
});

test('a failure logs the hint for a known server error', async () => {
  const { up, logs, add } = setup([
    { status: 403, body: '{"code":"42501","message":"unregistered or inactive gate device: gate-01-pc"}' },
  ]);
  add(1);
  await up.step(NOW);
  assert.ok(logs.some((l) => l.includes('not in pta.gate_devices')), logs.join('\n'));
});

test('net off and an empty queue send nothing', async () => {
  const { calls, up, add } = setup();
  assert.equal(await up.step(NOW), 250);
  up.netOn = false;
  add(1);
  assert.equal(await up.step(NOW), 500);
  assert.equal(calls.length, 0);
});

test('batches are capped at 50', async () => {
  const { queue, calls, up, add } = setup();
  add(120);
  await up.step(NOW);
  assert.equal(calls[0].events.length, 50);
  assert.equal(queue.depth(), 70);
});

test('run() drains the queue until stopped', async () => {
  const { queue, up, add } = setup();
  add(120);
  const running = up.run();
  await waitFor(() => queue.depth() === 0);
  up.stop();
  await running;
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd gate && npm test`
Expected: FAIL — cannot find `./backoff.ts`, `./supabase.ts`, `./uploader.ts`.

- [ ] **Step 3: Implement**

`gate/src/backoff.ts`:

```ts
// Port of lib/core/Backoff.h. Offline is a normal state for a school gate, so
// the ceiling matters more than the growth: retry forever at a calm interval.
export class Backoff {
  #base: number;
  #max: number;
  #cur: number;
  #failures = 0;

  constructor(baseMs = 1000, maxMs = 60_000) {
    this.#base = baseMs;
    this.#max = maxMs;
    this.#cur = baseMs;
  }

  get delayMs(): number {
    return this.#cur;
  }

  get failures(): number {
    return this.#failures;
  }

  onFailure(): void {
    this.#failures++;
    this.#cur = Math.min(this.#cur * 2, this.#max);
  }

  onSuccess(): void {
    this.#cur = this.#base;
    this.#failures = 0;
  }
}
```

`gate/src/supabase.ts`:

```ts
// The gate's whole server surface: two RPCs in the pta schema, called with the
// anon key. status 0 means the request never got an HTTP answer (refused,
// DNS, timeout) -- the uploader treats it like any other failure.
export interface RpcResult {
  status: number;
  body: string;
}

export type Rpc = (fn: string, args: unknown) => Promise<RpcResult>;

export function createRpc(supabaseUrl: string, anonKey: string, timeoutMs = 15_000): Rpc {
  return async (fn, args) => {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
          'Content-Type': 'application/json',
          // pta is invisible to PostgREST without this header AND without
          // being listed under Settings -> API -> Exposed schemas.
          'Content-Profile': 'pta',
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, body: await res.text() };
    } catch (err) {
      return { status: 0, body: err instanceof Error ? err.message : String(err) };
    }
  };
}

// Same hints the firmware printed, plus the device token. Order matters: the
// specific 42501 messages are checked before the generic one.
export function explainFailure(body: string, deviceId: string): string | null {
  if (body.includes('PGRST106')) {
    return "schema 'pta' is not exposed: Dashboard -> Settings -> API -> Exposed schemas -> add it";
  }
  if (body.includes('PGRST202')) {
    return 'function not found: apply the pta-collections migrations (0013, 0025) in the SQL Editor';
  }
  if (body.includes('unregistered or inactive gate device')) {
    return `device '${deviceId}' is not in pta.gate_devices, or is inactive; scans stay queued until it is`;
  }
  if (body.includes('invalid gate device credentials')) {
    return `GATE_TOKEN does not match device '${deviceId}': run select pta.issue_gate_device_token('${deviceId}') and update /etc/gate/gate.env`;
  }
  if (body.includes('42501')) {
    return 'anon lacks EXECUTE on the function: re-run the grants at the end of its migration';
  }
  return null;
}
```

`gate/src/uploader.ts`:

```ts
import { Backoff } from './backoff.ts';
import type { Log } from './log.ts';
import type { QueuedScan, ScanQueue } from './queue.ts';
import { explainFailure, type Rpc } from './supabase.ts';

export const UPLOAD_BATCH_SIZE = 50;
// A scan older than this when it is sent is flagged queued=true, so
// notify-guardian's message.ts tells the parent the message was delayed.
export const LATE_AFTER_S = 15;

export interface AttendanceEvent {
  event_id: string;
  card_uid: string;
  device_id: string;
  scanned_at: string;
  clock_synced: boolean;
  direction: 'in';
  queued: boolean;
}

export function toPayload(scans: QueuedScan[], nowMs: number): AttendanceEvent[] {
  return scans.map((s) => ({
    event_id: s.eventId,
    card_uid: s.cardUid,
    device_id: s.deviceId,
    scanned_at: s.scannedAt,
    clock_synced: s.clockSynced,
    direction: 'in',
    queued: (nowMs - Date.parse(s.scannedAt)) / 1000 > LATE_AFTER_S,
  }));
}

// record_attendance() returns how many rows were new. Anything that is not a
// bare integer -- an HTML login page from a captive portal, a proxy error with
// a 200 -- did NOT reach Postgres, and acking it would lose the batch.
export function parseInserted(body: string): number | null {
  const m = /^\s*(\d+)\s*$/.exec(body);
  return m ? Number(m[1]) : null;
}

export class Uploader {
  netOn = true;
  sent = 0;
  failed = 0;
  duplicates = 0;
  lastOk: boolean | null = null;

  #queue: ScanQueue;
  #rpc: Rpc;
  #deviceId: string;
  #log: Log;
  #backoff: Backoff;
  #stopped = false;
  #wake: (() => void) | null = null;

  constructor(queue: ScanQueue, rpc: Rpc, deviceId: string, log: Log, backoff = new Backoff(1000, 60_000)) {
    this.#queue = queue;
    this.#rpc = rpc;
    this.#deviceId = deviceId;
    this.#log = log;
    this.#backoff = backoff;
  }

  // One attempt. Returns how long to wait before the next one.
  async step(nowMs = Date.now()): Promise<number> {
    if (!this.netOn) return 500;
    const batch = this.#queue.take(UPLOAD_BATCH_SIZE);
    if (batch.length === 0) return 250;

    const res = await this.#rpc('record_attendance', { events: toPayload(batch, nowMs) });
    const is2xx = res.status >= 200 && res.status < 300;
    const inserted = is2xx ? parseInserted(res.body) : null;

    if (inserted !== null) {
      this.#queue.ack(batch.map((s) => s.id), new Date(nowMs).toISOString());
      const dup = Math.max(0, batch.length - inserted);
      this.sent += batch.length;
      this.duplicates += dup;
      this.lastOk = true;
      this.#backoff.onSuccess();
      this.#log(
        `[upload] ${batch.length} sent, ${inserted} inserted` +
          (dup ? `, ${dup} duplicate(s) ignored` : '') +
          `, ${this.#queue.depth()} still queued`,
      );
      return 0;
    }

    this.failed++;
    this.lastOk = false;
    this.#backoff.onFailure();
    const why = is2xx ? `http=${res.status} but the body is not a row count (captive portal?)` : `http=${res.status}`;
    this.#log(
      `[upload] FAILED ${why} attempt=${this.#backoff.failures} retry_in=${this.#backoff.delayMs}ms ` +
        res.body.slice(0, 200),
    );
    const hint = explainFailure(res.body, this.#deviceId);
    if (hint) this.#log(`[upload] hint: ${hint}`);
    return this.#backoff.delayMs;
  }

  async run(): Promise<void> {
    while (!this.#stopped) {
      let wait: number;
      try {
        wait = await this.step();
      } catch (err) {
        // A database error must not kill the loop; scans keep queueing.
        this.#log(`[upload] error: ${err instanceof Error ? err.message : String(err)}`);
        wait = 5000;
      }
      if (wait > 0 && !this.#stopped) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait);
          this.#wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.#wake = null;
      }
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#wake?.();
  }
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `cd gate && npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add gate/src/backoff.ts gate/src/backoff.test.ts gate/src/supabase.ts gate/src/supabase.test.ts gate/src/uploader.ts gate/src/uploader.test.ts
git commit -m "Upload queued scans to record_attendance with backoff"
```

---

### Task 4: Roster mirror and sync

**Files:**
- Create: `gate/src/roster.ts`
- Test: `gate/src/roster.test.ts`

**Interfaces:**
- Consumes: `openDb`, `tx`, `getMeta`, `setMeta` (Task 2); `Rpc`, `RpcResult`, `explainFailure` (Task 3); `Log`.
- Produces: `interface Student { student_id: string; full_name: string; student_no: string | null; grade_level: string | null; section_name: string | null }`; `interface Snapshot { school_id; device_id; generated_at: string; students: Student[]; cards: { card_uid: string; student_id: string }[] }`; `class RosterMirror { constructor(db); replace(snap: Snapshot, syncedAt: string): void; lookup(uid: string): Student | null; studentCount(): number; syncedAt(): string | null }`; `type SyncResult = 'ok' | 'failed' | 'refused-empty'`; `class RosterSync { constructor(mirror, rpc, deviceId, token, log); sync(nowMs?): Promise<SyncResult>; requestResync(nowMs?): boolean; isStale(nowMs?): boolean }`.

- [ ] **Step 1: Write the failing tests**

`gate/src/roster.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { RosterMirror, RosterSync, type Snapshot } from './roster.ts';
import type { RpcResult } from './supabase.ts';

const TOKEN = 'gt_' + 'b'.repeat(64);
const NOW = Date.parse('2026-10-05T07:00:00.000Z');
const SNAP: Snapshot = {
  school_id: 'school-1',
  device_id: 'gate-01-pc',
  generated_at: '2026-10-05T07:00:00Z',
  students: [
    { student_id: 'st1', full_name: 'Dela Cruz, Juan', student_no: '2026-0001', grade_level: 'Grade 7', section_name: 'Rizal' },
    { student_id: 'st2', full_name: 'Santos, Maria', student_no: null, grade_level: null, section_name: null },
  ],
  cards: [{ card_uid: '0002008108', student_id: 'st1' }],
};
const EMPTY: Snapshot = { ...SNAP, students: [], cards: [] };

function setup(responses: RpcResult[] = []) {
  const mirror = new RosterMirror(openDb(':memory:'));
  const calls: { fn: string; args: unknown }[] = [];
  const logs: string[] = [];
  const sync = new RosterSync(
    mirror,
    async (fn, args) => {
      calls.push({ fn, args });
      return responses.shift() ?? { status: 200, body: JSON.stringify(SNAP) };
    },
    'gate-01-pc',
    TOKEN,
    (l) => logs.push(l),
  );
  return { mirror, sync, calls, logs };
}

test('lookup resolves a card to its student; unknown and zero-stripped uids do not', () => {
  const { mirror } = setup();
  mirror.replace(SNAP, '2026-10-05T07:00:00.000Z');
  assert.deepEqual(mirror.lookup('0002008108'), SNAP.students[0]);
  assert.equal(mirror.lookup('0000000001'), null);
  assert.equal(mirror.lookup('2008108'), null);
  assert.equal(mirror.studentCount(), 2);
});

test('replace is wholesale: a card missing from the new snapshot stops resolving', () => {
  const { mirror } = setup();
  mirror.replace(SNAP, '2026-10-05T07:00:00.000Z');
  mirror.replace({ ...SNAP, cards: [] }, '2026-10-05T07:05:00.000Z');
  assert.equal(mirror.lookup('0002008108'), null);
  assert.equal(mirror.syncedAt(), '2026-10-05T07:05:00.000Z');
});

test('sync calls gate_roster_snapshot with the device id and token', async () => {
  const { mirror, sync, calls } = setup();
  assert.equal(await sync.sync(NOW), 'ok');
  assert.deepEqual(calls, [{ fn: 'gate_roster_snapshot', args: { p_device_id: 'gate-01-pc', p_token: TOKEN } }]);
  assert.equal(mirror.syncedAt(), new Date(NOW).toISOString());
  assert.equal(mirror.studentCount(), 2);
});

test('a failed sync keeps the last good mirror', async () => {
  const { mirror, sync, logs } = setup([{ status: 200, body: JSON.stringify(SNAP) }, { status: 0, body: 'ENOTFOUND' }]);
  await sync.sync(NOW);
  assert.equal(await sync.sync(NOW + 300_000), 'failed');
  assert.equal(mirror.lookup('0002008108')?.full_name, 'Dela Cruz, Juan');
  assert.equal(mirror.syncedAt(), new Date(NOW).toISOString());
  assert.ok(logs.some((l) => l.includes('keeping the last good mirror')));
});

test('an unreadable snapshot keeps the last good mirror', async () => {
  const { mirror, sync } = setup([
    { status: 200, body: JSON.stringify(SNAP) },
    { status: 200, body: 'not json' },
    { status: 200, body: '{}' },
  ]);
  await sync.sync(NOW);
  assert.equal(await sync.sync(NOW + 1), 'failed');
  assert.equal(await sync.sync(NOW + 2), 'failed');
  assert.equal(mirror.studentCount(), 2);
});

test('a wrong token logs how to fix it', async () => {
  const { sync, logs } = setup([{ status: 403, body: '{"code":"42501","message":"invalid gate device credentials"}' }]);
  assert.equal(await sync.sync(NOW), 'failed');
  assert.ok(logs.some((l) => l.includes("issue_gate_device_token('gate-01-pc')")), logs.join('\n'));
});

test('REVIEW FOCUS: an empty snapshot never blanks a populated mirror', async () => {
  const { mirror, sync, logs } = setup([
    { status: 200, body: JSON.stringify(SNAP) },
    { status: 200, body: JSON.stringify(EMPTY) },
  ]);
  await sync.sync(NOW);
  assert.equal(await sync.sync(NOW + 300_000), 'refused-empty');
  assert.equal(mirror.lookup('0002008108')?.full_name, 'Dela Cruz, Juan');
  assert.ok(logs.some((l) => l.includes('active school year')));
});

test('an empty snapshot is accepted when there was nothing to lose', async () => {
  const { sync } = setup([{ status: 200, body: JSON.stringify(EMPTY) }]);
  assert.equal(await sync.sync(NOW), 'ok');
});

test('unknown-card resyncs happen at most once a minute', async () => {
  const { sync, calls } = setup();
  assert.equal(sync.requestResync(NOW), true);
  await sync.sync(NOW); // joins the in-flight request
  assert.equal(sync.requestResync(NOW + 30_000), false);
  assert.equal(sync.requestResync(NOW + 61_000), true);
  await sync.sync(NOW + 61_000);
  assert.equal(calls.length, 2);
});

test('concurrent syncs share one request', async () => {
  const { sync, calls } = setup();
  const a = sync.sync(NOW);
  const b = sync.sync(NOW);
  assert.equal(a, b);
  await a;
  assert.equal(calls.length, 1);
});

test('stale when never synced, or synced more than an hour ago', async () => {
  const { sync } = setup();
  assert.equal(sync.isStale(NOW), true);
  await sync.sync(NOW);
  assert.equal(sync.isStale(NOW + 59 * 60_000), false);
  assert.equal(sync.isStale(NOW + 61 * 60_000), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd gate && npm test`
Expected: FAIL — cannot find `./roster.ts`.

- [ ] **Step 3: Implement**

`gate/src/roster.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { getMeta, setMeta, tx } from './db.ts';
import type { Log } from './log.ts';
import { explainFailure, type Rpc } from './supabase.ts';

export interface Student {
  student_id: string;
  full_name: string;
  student_no: string | null;
  grade_level: string | null;
  section_name: string | null;
}

export interface Snapshot {
  school_id: string;
  device_id: string;
  generated_at: string;
  students: Student[];
  cards: { card_uid: string; student_id: string }[];
}

export const RESYNC_MIN_GAP_MS = 60_000;
export const STALE_AFTER_MS = 3_600_000;

// The local copy of pta.gate_roster the screen reads from. It is ADVISORY: a
// card it does not know still queues and uploads, and attendance_resolved
// names the student server-side. It exists so the screen works offline.
export class RosterMirror {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // Wholesale, in one transaction: a few thousand rows, so diffing would be
  // complexity for nothing, and a reader never sees half a roster.
  replace(snap: Snapshot, syncedAt: string): void {
    tx(this.#db, () => {
      this.#db.exec('delete from cards; delete from roster;');
      const student = this.#db.prepare(
        'insert into roster (student_id, full_name, student_no, grade_level, section_name) values (?, ?, ?, ?, ?)',
      );
      for (const s of snap.students) {
        student.run(s.student_id, s.full_name, s.student_no ?? null, s.grade_level ?? null, s.section_name ?? null);
      }
      const card = this.#db.prepare('insert or replace into cards (card_uid, student_id) values (?, ?)');
      for (const c of snap.cards) card.run(c.card_uid, c.student_id);
      setMeta(this.#db, 'roster_synced_at', syncedAt);
    });
  }

  lookup(uid: string): Student | null {
    const row = this.#db
      .prepare(
        `select r.student_id, r.full_name, r.student_no, r.grade_level, r.section_name
           from cards c join roster r on r.student_id = c.student_id
          where c.card_uid = ?`,
      )
      .get(uid) as Student | undefined;
    return row ? { ...row } : null;
  }

  studentCount(): number {
    return (this.#db.prepare('select count(*) as n from roster').get() as { n: number }).n;
  }

  syncedAt(): string | null {
    return getMeta(this.#db, 'roster_synced_at');
  }
}

export type SyncResult = 'ok' | 'failed' | 'refused-empty';

export class RosterSync {
  #mirror: RosterMirror;
  #rpc: Rpc;
  #deviceId: string;
  #token: string;
  #log: Log;
  #lastAttemptMs = -Infinity;
  #inFlight: Promise<SyncResult> | null = null;

  constructor(mirror: RosterMirror, rpc: Rpc, deviceId: string, token: string, log: Log) {
    this.#mirror = mirror;
    this.#rpc = rpc;
    this.#deviceId = deviceId;
    this.#token = token;
    this.#log = log;
  }

  sync(nowMs = Date.now()): Promise<SyncResult> {
    if (this.#inFlight) return this.#inFlight;
    this.#lastAttemptMs = nowMs;
    this.#inFlight = this.#doSync(nowMs).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  // An unknown card might have been enrolled a minute ago, so ask again --
  // but not more than once a minute, or a burst of strangers hammers the RPC.
  requestResync(nowMs = Date.now()): boolean {
    if (nowMs - this.#lastAttemptMs < RESYNC_MIN_GAP_MS) return false;
    void this.sync(nowMs);
    return true;
  }

  isStale(nowMs = Date.now()): boolean {
    const at = this.#mirror.syncedAt();
    return at === null || nowMs - Date.parse(at) > STALE_AFTER_MS;
  }

  async #doSync(nowMs: number): Promise<SyncResult> {
    const res = await this.#rpc('gate_roster_snapshot', { p_device_id: this.#deviceId, p_token: this.#token });
    if (res.status < 200 || res.status >= 300) {
      this.#log(`[roster] sync FAILED http=${res.status} ${res.body.slice(0, 200)} -- keeping the last good mirror`);
      const hint = explainFailure(res.body, this.#deviceId);
      if (hint) this.#log(`[roster] hint: ${hint}`);
      return 'failed';
    }

    let snap: Snapshot;
    try {
      snap = JSON.parse(res.body) as Snapshot;
      if (!Array.isArray(snap?.students) || !Array.isArray(snap?.cards)) throw new Error('no students/cards arrays');
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.#log(`[roster] sync FAILED: unreadable snapshot (${why}) -- keeping the last good mirror`);
      return 'failed';
    }

    const have = this.#mirror.studentCount();
    if (snap.students.length === 0 && have > 0) {
      this.#log(
        `[roster] snapshot has NO students but the mirror has ${have}; refusing to blank the screen. ` +
          "Check the school's active school year in PTA Collections.",
      );
      return 'refused-empty';
    }

    this.#mirror.replace(snap, new Date(nowMs).toISOString());
    this.#log(`[roster] synced ${snap.students.length} students, ${snap.cards.length} cards`);
    return 'ok';
  }
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `cd gate && npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add gate/src/roster.ts gate/src/roster.test.ts
git commit -m "Mirror the school roster locally from gate_roster_snapshot"
```

---

### Task 5: Card readers

**Files:**
- Create: `gate/src/reader/reader.ts`, `gate/src/reader/keystrokes.ts`, `gate/src/reader/evdev.ts`, `gate/src/reader/keyboard.ts`, `gate/src/reader/simulated.ts`, `gate/src/reader/index.ts`
- Test: `gate/src/reader/reader.test.ts`, `gate/src/reader/keystrokes.test.ts`, `gate/src/reader/evdev.test.ts`, `gate/src/reader/keyboard.test.ts`, `gate/src/reader/simulated.test.ts`

**Interfaces:**
- Consumes: `normalizeUid`, `Config`, `Log`, `waitFor`, `tmpPath` (Task 1).
- Produces: `abstract class TagReader { start(): void; stop(): void; onCard(h: (uid: string) => void); onStatus(h: (online: boolean) => void); enabled: boolean (getter); setEnabled(on: boolean); online: boolean (getter); inject(uid: string); injectBurst(n: number); protected emit(uid); protected setOnline(on) }`; `KEYSTROKE_GAP_MS = 500`; `type Assembled = { uid: string } | { misread: string }`; `class KeystrokeAssembler { constructor(gapMs?); feed(key: string, nowMs: number): Assembled | null }`; `EVTEST_COMMAND`; `parseEvtestLine(line: string): string | null`; `class EvdevReader extends TagReader { constructor(device: string, log: Log, opts?: { command?: string[]; retryMs?: number; now?: () => number }) }`; `class KeyboardReader extends TagReader { constructor(log: Log, input?: NodeJS.ReadableStream) }`; `SIMULATED_ROSTER: readonly string[]`; `class SimulatedReader extends TagReader { constructor(intervalMs = 10_000) }`; `createReader(config: Config, log: Log): TagReader`.

**Why `evtest`:** Node cannot issue the `EVIOCGRAB` ioctl without a native module, and the design forbids native modules. `evtest --grab <device>` takes the exclusive grab and prints one line per key; its stdout is block-buffered into a pipe, so it runs under `stdbuf -oL` to make it line-buffered. When the reader is unplugged `evtest` exits, and the reader respawns it every 2 s — that is the hotplug recovery.

- [ ] **Step 1: Write the failing tests**

`gate/src/reader/reader.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TagReader } from './reader.ts';

class TestReader extends TagReader {
  start(): void {}
  stop(): void {}
  fire(uid: string): void { this.emit(uid); }
  goOnline(on: boolean): void { this.setOnline(on); }
}

test('a disabled reader drops hardware reads but still takes injected scans', () => {
  const r = new TestReader();
  const seen: string[] = [];
  r.onCard((uid) => seen.push(uid));
  r.setEnabled(false);
  r.fire('0002008108');
  r.inject('0000000001');
  assert.deepEqual(seen, ['0000000001']);
});

test("burst uids are B + 7 digits, unique, matching the server's synthetic filter", () => {
  const r = new TestReader();
  const seen: string[] = [];
  r.onCard((uid) => seen.push(uid));
  r.injectBurst(3);
  assert.deepEqual(seen, ['B0000001', 'B0000002', 'B0000003']);
  for (const uid of seen) assert.match(uid, /^B[0-9]{7}$/);
});

test('status handlers fire only when online actually changes', () => {
  const r = new TestReader();
  const seen: boolean[] = [];
  r.onStatus((on) => seen.push(on));
  r.goOnline(true);
  r.goOnline(true);
  r.goOnline(false);
  assert.deepEqual(seen, [true, false]);
  assert.equal(r.online, false);
});
```

`gate/src/reader/keystrokes.test.ts`:

```ts
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
```

`gate/src/reader/evdev.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { EvdevReader, parseEvtestLine } from './evdev.ts';
import { tmpPath, waitFor } from '../test-helpers.ts';

// Stands in for `stdbuf -oL evtest --grab <device>`: prints evtest's real
// output format for the keys in FAKE_KEYS, holds, then exits.
const FAKE = tmpPath('fake-evtest.mjs');
writeFileSync(
  FAKE,
  `const lines = ['Input driver version is 1.0.1', 'Input device name: "SYC ID&IC USB Reader"', 'Testing ... (interrupt to exit)'];
for (const k of (process.env.FAKE_KEYS ?? '').split(',').filter(Boolean)) {
  lines.push('Event: time 1700000000.000001, type 4 (EV_MSC), code 4 (MSC_SCAN), value 70027');
  lines.push('Event: time 1700000000.000002, type 1 (EV_KEY), code 11 (' + k + '), value 1');
  lines.push('Event: time 1700000000.000003, -------------- SYN_REPORT ------------');
  lines.push('Event: time 1700000000.000004, type 1 (EV_KEY), code 11 (' + k + '), value 0');
}
process.stdout.write(lines.join('\\n') + '\\n');
setTimeout(() => process.exit(0), Number(process.env.FAKE_HOLD_MS ?? 50));
`,
);
const CARD_KEYS = [...'0002008108'].map((d) => `KEY_${d}`).concat('KEY_ENTER').join(',');

test('parseEvtestLine returns key-down names only', () => {
  assert.equal(parseEvtestLine('Event: time 1700000000.000002, type 1 (EV_KEY), code 11 (KEY_0), value 1'), 'KEY_0');
  assert.equal(parseEvtestLine('Event: time 1700000000.000004, type 1 (EV_KEY), code 11 (KEY_0), value 0'), null);
  assert.equal(parseEvtestLine('Event: time 1700000000.000004, type 1 (EV_KEY), code 11 (KEY_0), value 2'), null);
  assert.equal(parseEvtestLine('Event: time 1700000000.000001, type 4 (EV_MSC), code 4 (MSC_SCAN), value 70027'), null);
  assert.equal(parseEvtestLine('Event: time 1700000000.000003, -------------- SYN_REPORT ------------'), null);
  assert.equal(parseEvtestLine('Testing ... (interrupt to exit)'), null);
});

test('reads a card from evtest output and reports online', async () => {
  process.env.FAKE_KEYS = CARD_KEYS;
  process.env.FAKE_HOLD_MS = '300';
  const r = new EvdevReader('/dev/input/fake', () => {}, { command: [process.execPath, FAKE], retryMs: 1000 });
  const uids: string[] = [];
  const statuses: boolean[] = [];
  r.onCard((u) => uids.push(u));
  r.onStatus((s) => statuses.push(s));
  r.start();
  await waitFor(() => uids.length === 1);
  r.stop();
  assert.deepEqual(uids, ['0002008108']);
  assert.equal(statuses[0], true);
});

test('goes offline when evtest exits (unplugged) and comes back by respawning', async () => {
  process.env.FAKE_KEYS = '';
  process.env.FAKE_HOLD_MS = '20';
  const logs: string[] = [];
  const r = new EvdevReader('/dev/input/fake', (l) => logs.push(l), { command: [process.execPath, FAKE], retryMs: 30 });
  const statuses: boolean[] = [];
  r.onStatus((s) => statuses.push(s));
  r.start();
  await waitFor(() => statuses.length >= 3);
  r.stop();
  assert.deepEqual(statuses.slice(0, 3), [true, false, true]);
  assert.ok(logs.some((l) => l.includes('OFFLINE')));
});

test('a missing evtest binary is offline and retried, never a crash', async () => {
  const logs: string[] = [];
  const r = new EvdevReader('/dev/input/fake', (l) => logs.push(l), { command: ['/nonexistent/evtest'], retryMs: 20 });
  r.start();
  await waitFor(() => logs.length >= 1);
  await new Promise((res) => setTimeout(res, 100));
  r.stop();
  assert.equal(r.online, false);
  // Logged once per distinct failure, not once per retry.
  assert.equal(logs.filter((l) => l.includes('OFFLINE')).length, 1);
});
```

`gate/src/reader/keyboard.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { KeyboardReader } from './keyboard.ts';
import { waitFor } from '../test-helpers.ts';

test('each typed line is a card, misreads are logged and dropped', async () => {
  const input = new PassThrough();
  const logs: string[] = [];
  const r = new KeyboardReader((l) => logs.push(l), input);
  const uids: string[] = [];
  r.onCard((u) => uids.push(u));
  r.start();
  assert.equal(r.online, true);
  input.write('0002008108\nabc\n\n0000000001\n');
  await waitFor(() => uids.length === 2);
  r.stop();
  assert.deepEqual(uids, ['0002008108', '0000000001']);
  assert.ok(logs.some((l) => l.includes('misread "abc"')));
});
```

`gate/src/reader/simulated.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd gate && npm test`
Expected: FAIL — cannot find the reader modules.

- [ ] **Step 3: Implement**

`gate/src/reader/reader.ts`:

```ts
// Port of src/TagReader.h. Everything downstream only ever sees a uid string,
// so the evdev, keyboard and simulated readers are interchangeable.
// inject() and injectBurst() live on the base, not the subclasses, so
// `scan <uid>` and `burst <n>` behave the same against real hardware -- they
// are how the upload path is tested without a card.
export type CardHandler = (uid: string) => void;
export type StatusHandler = (online: boolean) => void;

export abstract class TagReader {
  #enabled = true;
  #online = false;
  #burstSeq = 1;
  #onCard: CardHandler = () => {};
  #onStatus: StatusHandler = () => {};

  abstract start(): void;
  abstract stop(): void;

  onCard(handler: CardHandler): void {
    this.#onCard = handler;
  }

  onStatus(handler: StatusHandler): void {
    this.#onStatus = handler;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setEnabled(on: boolean): void {
    this.#enabled = on;
  }

  get online(): boolean {
    return this.#online;
  }

  // Injected scans bypass the enable switch, exactly as the firmware's did.
  inject(uid: string): void {
    this.#onCard(uid);
  }

  // Synthetic unique uids: reusing real ones would trip the cooldown. The
  // server keeps ^B[0-9]{7}$ off the enrolment queue.
  injectBurst(n: number): void {
    for (let i = 0; i < n; i++) this.#onCard(`B${String(this.#burstSeq++).padStart(7, '0')}`);
  }

  protected emit(uid: string): void {
    if (this.#enabled) this.#onCard(uid);
  }

  protected setOnline(online: boolean): void {
    if (online === this.#online) return;
    this.#online = online;
    this.#onStatus(online);
  }
}
```

`gate/src/reader/keystrokes.ts`:

```ts
import { normalizeUid } from './uid.ts';

const DIGITS: Record<string, string> = {};
for (let i = 0; i <= 9; i++) {
  DIGITS[`KEY_${i}`] = String(i);
  DIGITS[`KEY_KP${i}`] = String(i);
}
const ENTER = new Set(['KEY_ENTER', 'KEY_KPENTER']);

// The reader types a whole card in well under 100 ms. A gap this long between
// keys means the previous digits were a skimmed swipe, not the start of this
// card.
export const KEYSTROKE_GAP_MS = 500;

export type Assembled = { uid: string } | { misread: string };

export class KeystrokeAssembler {
  #buf = '';
  #lastAt = 0;
  #gapMs: number;

  constructor(gapMs = KEYSTROKE_GAP_MS) {
    this.#gapMs = gapMs;
  }

  feed(key: string, nowMs: number): Assembled | null {
    if (this.#buf && nowMs - this.#lastAt > this.#gapMs) this.#buf = '';
    this.#lastAt = nowMs;

    const digit = DIGITS[key];
    if (digit !== undefined) {
      if (this.#buf.length < 64) this.#buf += digit;
      return null;
    }
    if (ENTER.has(key)) {
      const raw = this.#buf;
      this.#buf = '';
      if (!raw) return null;
      const uid = normalizeUid(raw);
      return uid ? { uid } : { misread: raw };
    }
    return null;
  }
}
```

`gate/src/reader/evdev.ts`:

```ts
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Log } from '../log.ts';
import { KeystrokeAssembler } from './keystrokes.ts';
import { TagReader } from './reader.ts';

// evtest takes the EVIOCGRAB exclusive grab Node cannot take without a native
// module. stdbuf makes its piped stdout line-buffered; without it, key events
// would sit in a 4 KB buffer.
export const EVTEST_COMMAND: readonly string[] = ['stdbuf', '-oL', 'evtest', '--grab'];

const KEY_DOWN = /type 1 \(EV_KEY\), code \d+ \((KEY_[A-Z0-9_]+)\), value 1$/;

export function parseEvtestLine(line: string): string | null {
  const m = KEY_DOWN.exec(line.trim());
  return m ? m[1] : null;
}

export class EvdevReader extends TagReader {
  #device: string;
  #log: Log;
  #command: readonly string[];
  #retryMs: number;
  #now: () => number;
  #assembler = new KeystrokeAssembler();
  #kill: (() => void) | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;
  #lastFailure = '';

  constructor(device: string, log: Log, opts: { command?: string[]; retryMs?: number; now?: () => number } = {}) {
    super();
    this.#device = device;
    this.#log = log;
    this.#command = opts.command ?? EVTEST_COMMAND;
    this.#retryMs = opts.retryMs ?? 2000;
    this.#now = opts.now ?? (() => performance.now());
  }

  start(): void {
    this.#stopped = false;
    this.#spawn();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#kill?.();
    this.setOnline(false);
  }

  #spawn(): void {
    const [cmd, ...args] = this.#command;
    const child = spawn(cmd, [...args, this.#device], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.#kill = () => child.kill();
    let stderr = '';
    let ended = false;

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.startsWith('Testing ...')) {
        if (!this.online) this.#log(`[reader] ONLINE ${this.#device} (exclusive grab)`);
        this.#lastFailure = '';
        this.setOnline(true);
        return;
      }
      const key = parseEvtestLine(line);
      if (!key) return;
      const r = this.#assembler.feed(key, this.#now());
      if (r && 'uid' in r) this.emit(r.uid);
      else if (r) this.#log(`[reader] misread "${r.misread}" ignored (expected 10 digits)`);
    });

    const onEnd = (why: string) => {
      if (ended) return;
      ended = true;
      this.#kill = null;
      if (this.#stopped) return;
      // Log on the transition and when the reason changes, not every 2 s.
      if (this.online || why !== this.#lastFailure) {
        this.#log(`[reader] OFFLINE ${this.#device}: ${why} -- retrying every ${this.#retryMs / 1000}s`);
      }
      this.#lastFailure = why;
      this.setOnline(false);
      this.#timer = setTimeout(() => this.#spawn(), this.#retryMs);
    };
    child.on('error', (err) => onEnd(err.message));
    child.on('close', (code) => onEnd(stderr.trim().split('\n').pop() || `evtest exited (${code})`));
  }
}
```

`gate/src/reader/keyboard.ts`:

```ts
import { createInterface, type Interface } from 'node:readline';
import type { Log } from '../log.ts';
import { TagReader } from './reader.ts';
import { normalizeUid } from './uid.ts';

// For development on the Mac: the USB reader types into the terminal running
// `npm run dev`, one card per line. No grab -- that is Linux-only.
export class KeyboardReader extends TagReader {
  #log: Log;
  #input: NodeJS.ReadableStream;
  #rl: Interface | null = null;

  constructor(log: Log, input: NodeJS.ReadableStream = process.stdin) {
    super();
    this.#log = log;
    this.#input = input;
  }

  start(): void {
    this.#rl = createInterface({ input: this.#input });
    this.#rl.on('line', (line) => {
      const raw = line.trim();
      if (!raw) return;
      const uid = normalizeUid(raw);
      if (uid) this.emit(uid);
      else this.#log(`[reader] misread "${raw}" ignored (expected 10 digits)`);
    });
    this.setOnline(true);
  }

  stop(): void {
    this.#rl?.close();
    this.#rl = null;
    this.setOnline(false);
  }
}
```

`gate/src/reader/simulated.ts`:

```ts
import { TagReader } from './reader.ts';

// Deterministic fake cards, the last one never enrolled. Kept beside the real
// reader because it is the only way to exercise the whole path with no
// hardware.
export const SIMULATED_ROSTER: readonly string[] = [
  '9000000001', '9000000002', '9000000003', '9000000004', '9000000005',
  '9000000006', '9000000007', '9000000008', '9000000009', '9999999999',
];

export class SimulatedReader extends TagReader {
  #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #next = 0;

  constructor(intervalMs = 10_000) {
    super();
    this.#intervalMs = intervalMs;
  }

  start(): void {
    this.setOnline(true);
    this.#timer = setInterval(() => {
      this.emit(SIMULATED_ROSTER[this.#next]);
      this.#next = (this.#next + 1) % SIMULATED_ROSTER.length;
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.setOnline(false);
  }
}
```

`gate/src/reader/index.ts`:

```ts
import type { Config } from '../config.ts';
import type { Log } from '../log.ts';
import { EvdevReader } from './evdev.ts';
import { KeyboardReader } from './keyboard.ts';
import type { TagReader } from './reader.ts';
import { SimulatedReader } from './simulated.ts';

export function createReader(config: Config, log: Log): TagReader {
  switch (config.reader) {
    case 'evdev':
      return new EvdevReader(config.readerDevice ?? '', log);
    case 'keyboard':
      return new KeyboardReader(log);
    case 'simulated':
      return new SimulatedReader();
  }
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `cd gate && npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add gate/src/reader
git commit -m "Add evdev, keyboard and simulated card readers"
```

---

### Task 6: The scan flow — cooldown, clock and scanner

**Files:**
- Create: `gate/src/cooldown.ts`, `gate/src/clock.ts`, `gate/src/scanner.ts`
- Test: `gate/src/cooldown.test.ts`, `gate/src/clock.test.ts`, `gate/src/scanner.test.ts`

**Interfaces:**
- Consumes: `ScanQueue`, `NewScan` (Task 2); `RosterMirror`, `Student` (Task 4); `Log`.
- Produces: `CARD_COOLDOWN_MS = 10_000`; `class Cooldown { constructor(ms?); accept(uid: string, monoMs: number): boolean }`; `createClockProbe(platform?, run?, cacheMs?): (nowMs?: number) => boolean`; `interface ScanView { uid: string; at: string; student: Student | null }`; `interface ScannerDeps { deviceId; queue: Pick<ScanQueue, 'enqueue'>; mirror: Pick<RosterMirror, 'lookup'>; cooldown: Cooldown; clockSynced: () => boolean; show: (v: ScanView) => void; unknownCard: () => void; log: Log; now?: () => number; mono?: () => number; newId?: () => string }`; `type ScanOutcome = 'queued' | 'cooldown' | 'dropped'`; `class Scanner { constructor(deps); failures: number; handle(uid: string): ScanOutcome }`.

- [ ] **Step 1: Write the failing tests**

`gate/src/cooldown.test.ts`:

```ts
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
```

`gate/src/clock.test.ts`:

```ts
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
```

`gate/src/scanner.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cooldown } from './cooldown.ts';
import type { NewScan } from './queue.ts';
import type { Student } from './roster.ts';
import { Scanner, type ScanView, type ScannerDeps } from './scanner.ts';

const JUAN: Student = { student_id: 'st1', full_name: 'Dela Cruz, Juan', student_no: '2026-0001', grade_level: 'Grade 7', section_name: 'Rizal' };
const T0 = Date.parse('2026-10-05T07:00:00.000Z');

function setup(over: Partial<ScannerDeps> = {}) {
  const order: string[] = [];
  const queued: NewScan[] = [];
  const views: ScanView[] = [];
  const logs: string[] = [];
  const clock = { mono: 0, now: T0, unknown: 0, ids: 0 };
  const deps: ScannerDeps = {
    deviceId: 'gate-01-pc',
    queue: { enqueue: (s) => { order.push('enqueue'); queued.push(s); return true; } },
    mirror: { lookup: (uid) => (uid === '0002008108' ? JUAN : null) },
    cooldown: new Cooldown(10_000),
    clockSynced: () => true,
    show: (v) => { order.push('show'); views.push(v); },
    unknownCard: () => { clock.unknown++; },
    log: (l) => logs.push(l),
    now: () => clock.now,
    mono: () => clock.mono,
    newId: () => `id-${++clock.ids}`,
    ...over,
  };
  return { scanner: new Scanner(deps), order, queued, views, logs, clock };
}

test('a known card reaches the SCREEN before the queue', () => {
  const { scanner, order, queued, views, clock } = setup();
  assert.equal(scanner.handle('0002008108'), 'queued');
  assert.deepEqual(order, ['show', 'enqueue']);
  assert.deepEqual(views[0], { uid: '0002008108', at: '2026-10-05T07:00:00.000Z', student: JUAN });
  assert.deepEqual(queued[0], {
    eventId: 'id-1', cardUid: '0002008108', deviceId: 'gate-01-pc',
    scannedAt: '2026-10-05T07:00:00.000Z', clockSynced: true,
  });
  assert.equal(clock.unknown, 0);
});

test('an unknown card is shown as unknown, still queued, and asks for a resync', () => {
  const { scanner, queued, views, clock } = setup();
  assert.equal(scanner.handle('0000000001'), 'queued');
  assert.equal(views[0].student, null);
  assert.equal(queued.length, 1);
  assert.equal(clock.unknown, 1);
});

test('a double swipe is ignored: not shown, not queued', () => {
  const { scanner, queued, views, clock } = setup();
  scanner.handle('0002008108');
  clock.mono += 3_000;
  assert.equal(scanner.handle('0002008108'), 'cooldown');
  assert.equal(views.length, 1);
  assert.equal(queued.length, 1);
});

test('REVIEW FOCUS: the wall clock stepping back does not lock a card out', () => {
  const { scanner, queued, clock } = setup();
  scanner.handle('0002008108');
  clock.mono += 11_000;
  clock.now -= 3_600_000; // NTP correction
  assert.equal(scanner.handle('0002008108'), 'queued');
  assert.equal(queued.length, 2);
});

test('an unsynced clock is recorded, not refused', () => {
  const { scanner, queued } = setup({ clockSynced: () => false });
  scanner.handle('0002008108');
  assert.equal(queued[0].clockSynced, false);
});

test('REVIEW FOCUS: a failing database still shows the student and never throws', () => {
  const { scanner, views, logs } = setup({ queue: { enqueue: () => { throw new Error('disk I/O error'); } } });
  assert.equal(scanner.handle('0002008108'), 'dropped');
  assert.equal(views.length, 1);
  assert.equal(scanner.failures, 1);
  assert.ok(logs.some((l) => l.includes('disk I/O error')));
});

test('a full queue is reported as dropped, after the screen updated', () => {
  const { scanner, views } = setup({ queue: { enqueue: () => false } });
  assert.equal(scanner.handle('0002008108'), 'dropped');
  assert.equal(views.length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd gate && npm test`
Expected: FAIL — cannot find `./cooldown.ts`, `./clock.ts`, `./scanner.ts`.

- [ ] **Step 3: Implement**

`gate/src/cooldown.ts`:

```ts
export const CARD_COOLDOWN_MS = 10_000;

// Human double-swipe guard, per card, in memory. Measured on a MONOTONIC
// clock: an NTP step must not decide whether a child's second swipe counts.
// A rejected swipe does not reset the window (same as the firmware).
export class Cooldown {
  #ms: number;
  #last = new Map<string, number>();

  constructor(ms = CARD_COOLDOWN_MS) {
    this.#ms = ms;
  }

  accept(uid: string, monoMs: number): boolean {
    const prev = this.#last.get(uid);
    if (prev !== undefined && monoMs - prev < this.#ms) return false;
    this.#last.set(uid, monoMs);
    if (this.#last.size > 5000) {
      for (const [k, t] of this.#last) if (monoMs - t >= this.#ms) this.#last.delete(k);
    }
    return true;
  }
}
```

`gate/src/clock.ts`:

```ts
import { execFileSync } from 'node:child_process';

type Run = (cmd: string, args: string[]) => string;

const defaultRun: Run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000 });

// clock_synced on each scan. NTP makes it nearly always true on Ubuntu, but an
// unsynced clock is recorded as false rather than dropping the scan, so the
// parent-facing caveat survives. Off Linux (the Mac) it is assumed true.
export function createClockProbe(
  platform: string = process.platform,
  run: Run = defaultRun,
  cacheMs = 60_000,
): (nowMs?: number) => boolean {
  let cached: boolean | null = null;
  let at = -Infinity;
  return (nowMs = Date.now()) => {
    if (platform !== 'linux') return true;
    if (cached !== null && nowMs - at < cacheMs) return cached;
    try {
      cached = run('timedatectl', ['show', '-p', 'NTPSynchronized', '--value']).trim() === 'yes';
    } catch {
      cached = false;
    }
    at = nowMs;
    return cached;
  };
}
```

`gate/src/scanner.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Cooldown } from './cooldown.ts';
import type { Log } from './log.ts';
import type { ScanQueue } from './queue.ts';
import type { RosterMirror, Student } from './roster.ts';

export interface ScanView {
  uid: string;
  at: string;
  student: Student | null;
}

export interface ScannerDeps {
  deviceId: string;
  queue: Pick<ScanQueue, 'enqueue'>;
  mirror: Pick<RosterMirror, 'lookup'>;
  cooldown: Cooldown;
  clockSynced: () => boolean;
  show: (view: ScanView) => void;
  unknownCard: () => void;
  log: Log;
  now?: () => number;
  mono?: () => number;
  newId?: () => string;
}

export type ScanOutcome = 'queued' | 'cooldown' | 'dropped';

// keystrokes -> uid -> cooldown -> roster.lookup() -> SCREEN -> queue
// The screen updates first, from the local mirror, so a slow network or a
// failing disk can never make the monitor lag behind the turnstile.
export class Scanner {
  failures = 0;
  #d: Required<ScannerDeps>;

  constructor(deps: ScannerDeps) {
    this.#d = {
      now: () => Date.now(),
      mono: () => performance.now(),
      newId: () => randomUUID(),
      ...deps,
    } as Required<ScannerDeps>;
  }

  handle(uid: string): ScanOutcome {
    const d = this.#d;
    if (!d.cooldown.accept(uid, d.mono())) {
      d.log(`[scan] ${uid} ignored (cooldown)`);
      return 'cooldown';
    }

    const at = new Date(d.now()).toISOString();
    const student = d.mirror.lookup(uid);
    d.show({ uid, at, student });
    if (!student) d.unknownCard();

    let saved = false;
    try {
      saved = d.queue.enqueue({ eventId: d.newId(), cardUid: uid, deviceId: d.deviceId, scannedAt: at, clockSynced: d.clockSynced() });
    } catch (err) {
      this.failures++;
      d.log(`[scan] *** could not save ${uid}: ${err instanceof Error ? err.message : String(err)} ***`);
      return 'dropped';
    }
    if (!saved) {
      d.log(`[scan] *** QUEUE FULL -- DROPPED scan ${uid}. Oldest scans are kept; newest are refused. ***`);
      return 'dropped';
    }
    d.log(`[scan] ${uid} queued (${student ? student.full_name : 'unknown card'})`);
    return 'queued';
  }
}
```

The spread puts caller-supplied `now`/`mono`/`newId` over the defaults; if a caller passes `undefined` explicitly the default is lost, so callers omit them instead.

- [ ] **Step 4: Run the tests and the type check**

Run: `cd gate && npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add gate/src/cooldown.ts gate/src/cooldown.test.ts gate/src/clock.ts gate/src/clock.test.ts gate/src/scanner.ts gate/src/scanner.test.ts
git commit -m "Show each scan on screen before queueing it"
```

---

### Task 7: Kiosk page, SSE and the control API

**Files:**
- Create: `gate/src/display/page.ts`, `gate/src/display/sse.ts`, `gate/src/display/server.ts`, `gate/src/control.ts`
- Test: `gate/src/display/sse.test.ts`, `gate/src/control.test.ts`, `gate/src/display/server.test.ts`

**Interfaces:**
- Consumes: `Student` (Task 4); `QueuedScan` (Task 2).
- Produces: `PAGE_HTML: string` (contains `{{VERSION}}`); `interface GateState { version; readerOnline; readerEnabled; rosterSyncedAt: string | null; rosterStale; queueDepth: number; netOn; uploadOk: boolean | null }`; `type GateEvent = { type: 'scan'; uid; at; student: Student | null } | { type: 'state'; state: GateState }`; `formatSse(e: GateEvent): string`; `class SseHub { attach(res: ServerResponse); broadcast(e: GateEvent); clientCount: number }`; `interface ControlApi { status(): Record<string, unknown>; inject(uid); burst(n); setNet(on); setReader(on); queueDepth(): number; queueDump(n): QueuedScan[]; syncRoster(): Promise<string> }`; `handleControl(method, path, query: URLSearchParams, body: Record<string, unknown>, api): Promise<{ status: number; body: unknown }>`; `createGateServer(deps: { hub: SseHub; version: string; control: ControlApi }): Server`.

- [ ] **Step 1: Write the failing tests**

`gate/src/display/sse.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSse, type GateEvent } from './sse.ts';

test('an SSE frame is one data line and a blank line', () => {
  const e: GateEvent = { type: 'scan', uid: '0002008108', at: '2026-10-05T07:00:00.000Z', student: null };
  assert.equal(formatSse(e), `data: ${JSON.stringify(e)}\n\n`);
});

test('the scan payload carries exactly what the page renders', () => {
  const e: GateEvent = {
    type: 'scan', uid: '0002008108', at: '2026-10-05T07:00:00.000Z',
    student: { student_id: 'st1', full_name: 'Dela Cruz, Juan', student_no: '2026-0001', grade_level: 'Grade 7', section_name: 'Rizal' },
  };
  const parsed = JSON.parse(formatSse(e).slice('data: '.length));
  assert.deepEqual(Object.keys(parsed).sort(), ['at', 'student', 'type', 'uid']);
  assert.equal(parsed.uid, '0002008108');
});
```

`gate/src/control.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleControl, type ControlApi } from './control.ts';

function fakeApi() {
  const calls: string[] = [];
  const api: ControlApi = {
    status: () => ({ queueDepth: 0 }),
    inject: (uid) => calls.push(`inject ${uid}`),
    burst: (n) => calls.push(`burst ${n}`),
    setNet: (on) => calls.push(`net ${on}`),
    setReader: (on) => calls.push(`reader ${on}`),
    queueDepth: () => 7,
    queueDump: (n) => { calls.push(`dump ${n}`); return []; },
    syncRoster: async () => 'ok',
  };
  return { api, calls };
}
const q = (s = '') => new URLSearchParams(s);

test('status, scan, burst, net and reader do what they say', async () => {
  const { api, calls } = fakeApi();
  assert.deepEqual(await handleControl('GET', '/control/status', q(), {}, api), { status: 200, body: { queueDepth: 0 } });
  assert.equal((await handleControl('POST', '/control/scan', q(), { uid: ' 0002008108 ' }, api)).status, 200);
  assert.equal((await handleControl('POST', '/control/burst', q(), { n: 200 }, api)).status, 200);
  assert.equal((await handleControl('POST', '/control/net', q(), { on: false }, api)).status, 200);
  assert.equal((await handleControl('POST', '/control/reader', q(), { on: true }, api)).status, 200);
  assert.deepEqual(calls, ['inject 0002008108', 'burst 200', 'net false', 'reader true']);
});

test('queue reports depth and dumps at most 200 events', async () => {
  const { api, calls } = fakeApi();
  assert.deepEqual(await handleControl('GET', '/control/queue', q(), {}, api), { status: 200, body: { depth: 7, events: [] } });
  await handleControl('GET', '/control/queue', q('dump=5000'), {}, api);
  assert.deepEqual(calls, ['dump 20', 'dump 200']);
});

test('roster sync returns the result', async () => {
  const { api } = fakeApi();
  assert.deepEqual(await handleControl('POST', '/control/roster/sync', q(), {}, api), { status: 200, body: { result: 'ok' } });
});

test('bad bodies are 400 and nothing happens', async () => {
  const { api, calls } = fakeApi();
  for (const [path, body] of [
    ['/control/scan', {}], ['/control/burst', { n: 0 }], ['/control/burst', { n: 1001 }],
    ['/control/burst', { n: '5' }], ['/control/net', { on: 'off' }], ['/control/reader', {}],
  ] as const) {
    assert.equal((await handleControl('POST', path, q(), body, api)).status, 400, `${path} ${JSON.stringify(body)}`);
  }
  assert.deepEqual(calls, []);
});

test('an unknown route is 404 and lists the real ones', async () => {
  const { api } = fakeApi();
  const r = await handleControl('POST', '/control/reboot', q(), {}, api);
  assert.equal(r.status, 404);
  assert.match(JSON.stringify(r.body), /GET \/control\/status/);
});
```

`gate/src/display/server.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { ControlApi } from '../control.ts';
import { createGateServer } from './server.ts';
import { SseHub, type GateEvent, type GateState } from './sse.ts';

const STATE: GateState = {
  version: 'test123', readerOnline: true, readerEnabled: true, rosterSyncedAt: null,
  rosterStale: true, queueDepth: 0, netOn: true, uploadOk: null,
};
const api: ControlApi = {
  status: () => ({ ok: true }), inject: () => {}, burst: () => {}, setNet: () => {}, setReader: () => {},
  queueDepth: () => 0, queueDump: () => [], syncRoster: async () => 'ok',
};

async function start() {
  const hub = new SseHub();
  const server = createGateServer({ hub, version: 'test123', control: api });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  return { hub, base, close };
}

async function readEvents(url: string, count: number, afterFirst?: () => void): Promise<GateEvent[]> {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: GateEvent[] = [];
  let buf = '';
  let fired = false;
  while (out.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(i + 2);
      if (data) out.push(JSON.parse(data.slice('data: '.length)) as GateEvent);
    }
    if (!fired && out.length >= 1 && afterFirst) {
      fired = true;
      afterFirst();
    }
  }
  ac.abort();
  return out;
}

test('the page is served with its version baked in and never cached', async () => {
  const { base, close } = await start();
  try {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(html, /const BOOT_VERSION = "test123"/);
    assert.doesNotMatch(html, /\{\{VERSION\}\}/);
  } finally {
    await close();
  }
});

test('/events replays the last state to a new client, then streams scans', async () => {
  const { hub, base, close } = await start();
  try {
    hub.broadcast({ type: 'state', state: STATE });
    const events = await readEvents(`${base}/events`, 2, () =>
      hub.broadcast({ type: 'scan', uid: '0002008108', at: '2026-10-05T07:00:00.000Z', student: null }),
    );
    assert.deepEqual(events[0], { type: 'state', state: STATE });
    assert.equal(events[1].type, 'scan');
  } finally {
    await close();
  }
});

test('control routes answer JSON; malformed bodies are 400; unknown paths 404', async () => {
  const { base, close } = await start();
  try {
    assert.deepEqual(await (await fetch(`${base}/control/status`)).json(), { ok: true });
    assert.equal((await fetch(`${base}/control/burst`, { method: 'POST', body: '{nope' })).status, 400);
    assert.equal((await fetch(`${base}/control/burst`, { method: 'POST', body: '{"n":5}' })).status, 200);
    assert.equal((await fetch(`${base}/nothing`)).status, 404);
  } finally {
    await close();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd gate && npm test`
Expected: FAIL — cannot find `./sse.ts`, `./control.ts`, `./server.ts`.

- [ ] **Step 3: Implement**

`gate/src/display/sse.ts`:

```ts
import type { ServerResponse } from 'node:http';
import type { Student } from '../roster.ts';

export interface GateState {
  version: string;
  readerOnline: boolean;
  readerEnabled: boolean;
  rosterSyncedAt: string | null;
  rosterStale: boolean;
  queueDepth: number;
  netOn: boolean;
  uploadOk: boolean | null;
}

export type GateEvent =
  | { type: 'scan'; uid: string; at: string; student: Student | null }
  | { type: 'state'; state: GateState };

export function formatSse(event: GateEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// A reconnecting page (Chrome restarted by systemd) gets the last state and
// the last scan immediately, so the screen is never blank after a crash.
export class SseHub {
  #clients = new Set<ServerResponse>();
  #lastState: GateEvent | null = null;
  #lastScan: GateEvent | null = null;

  attach(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    if (this.#lastState) res.write(formatSse(this.#lastState));
    if (this.#lastScan) res.write(formatSse(this.#lastScan));
    this.#clients.add(res);
    res.on('close', () => this.#clients.delete(res));
  }

  broadcast(event: GateEvent): void {
    if (event.type === 'scan') this.#lastScan = event;
    else this.#lastState = event;
    const frame = formatSse(event);
    for (const client of this.#clients) client.write(frame);
  }

  get clientCount(): number {
    return this.#clients.size;
  }
}
```

`gate/src/control.ts`:

```ts
import type { QueuedScan } from './queue.ts';

// Replaces the firmware's serial console. Reached with curl over SSH:
//   ssh gate@minipc curl -s localhost:8080/control/status
//   ssh gate@minipc curl -s -X POST localhost:8080/control/burst -d '{"n":200}'
export interface ControlApi {
  status(): Record<string, unknown>;
  inject(uid: string): void;
  burst(n: number): void;
  setNet(on: boolean): void;
  setReader(on: boolean): void;
  queueDepth(): number;
  queueDump(n: number): QueuedScan[];
  syncRoster(): Promise<string>;
}

export interface ControlResult {
  status: number;
  body: unknown;
}

const ROUTES = [
  'GET  /control/status',
  'POST /control/scan        {"uid":"0002008108"}',
  'POST /control/burst       {"n":200}',
  'POST /control/net         {"on":false}',
  'POST /control/reader      {"on":false}   (persists across restarts)',
  'GET  /control/queue?dump=20',
  'POST /control/roster/sync',
];

const ok = (body: unknown): ControlResult => ({ status: 200, body });
const bad = (error: string): ControlResult => ({ status: 400, body: { error } });

export async function handleControl(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
  api: ControlApi,
): Promise<ControlResult> {
  switch (`${method} ${path}`) {
    case 'GET /control/status':
      return ok(api.status());
    case 'POST /control/scan': {
      const uid = typeof body.uid === 'string' ? body.uid.trim() : '';
      if (!uid) return bad('body must be {"uid": "<card uid>"}');
      api.inject(uid);
      return ok({ injected: uid });
    }
    case 'POST /control/burst': {
      const n = body.n;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1000) {
        return bad('body must be {"n": <1..1000>}');
      }
      api.burst(n);
      return ok({ injected: n });
    }
    case 'POST /control/net': {
      if (typeof body.on !== 'boolean') return bad('body must be {"on": true|false}');
      api.setNet(body.on);
      return ok({ net: body.on ? 'on' : 'off' });
    }
    case 'POST /control/reader': {
      if (typeof body.on !== 'boolean') return bad('body must be {"on": true|false}');
      api.setReader(body.on);
      return ok({ reader: body.on ? 'on' : 'off' });
    }
    case 'GET /control/queue': {
      const n = Math.min(Math.max(Number(query.get('dump') ?? '20') || 0, 0), 200);
      return ok({ depth: api.queueDepth(), events: api.queueDump(n) });
    }
    case 'POST /control/roster/sync':
      return ok({ result: await api.syncRoster() });
    default:
      return { status: 404, body: { error: `no such control: ${method} ${path}`, routes: ROUTES } };
  }
}
```

`gate/src/display/server.ts`:

```ts
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { handleControl, type ControlApi, type ControlResult } from '../control.ts';
import { PAGE_HTML } from './page.ts';
import type { SseHub } from './sse.ts';

const MAX_BODY = 10_000;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) return null;
  }
  if (!raw.trim()) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Bound to 127.0.0.1 by main.ts. The control routes are unauthenticated on
// purpose -- they are reached over SSH -- so this must never listen publicly.
export function createGateServer(deps: { hub: SseHub; version: string; control: ControlApi }): Server {
  const page = PAGE_HTML.replaceAll('{{VERSION}}', deps.version);
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(page);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        deps.hub.attach(res);
        return;
      }
      if (url.pathname.startsWith('/control/')) {
        const body = req.method === 'POST' ? await readJson(req) : {};
        const result: ControlResult =
          body === null
            ? { status: 400, body: { error: 'body must be a JSON object under 10 KB' } }
            : await handleControl(req.method ?? 'GET', url.pathname, url.searchParams, body, deps.control);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body, null, 2) + '\n');
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found\n');
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  });
}
```

`gate/src/display/page.ts`:

```ts
// The kiosk page. Text only: name, student number, grade, section, time,
// known/unknown (spec, Decisions). Rendered with textContent, never
// innerHTML, so a student's name cannot inject markup. It reloads itself when
// the service reports a different version, so a deploy reaches the monitor
// without anyone touching it.
export const PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Gate</title>
<style>
  :root { --bg: #0b0d10; --fg: #f4f6f8; --muted: #8a94a3; --ok: #2fb36b; --bad: #e05252; --panel: #1c2128; }
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; cursor: none; overflow: hidden; }
  #banners { position: fixed; top: 0; left: 0; right: 0; }
  .banner { padding: 1.2vh 3vw; font-size: 3.2vh; font-weight: 700; }
  .banner.bad { background: var(--bad); color: #fff; }
  .banner.quiet { background: var(--panel); color: var(--muted); font-weight: 500; font-size: 2.4vh; }
  main { height: 100%; display: flex; flex-direction: column; justify-content: center; padding: 0 6vw; }
  #status { font-size: 4vh; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  #status.known { color: var(--ok); }
  #status.unknown { color: var(--bad); }
  #name { font-size: 11vh; font-weight: 800; line-height: 1.05; margin: 2vh 0; overflow-wrap: anywhere; }
  #details { font-size: 4.5vh; }
  #meta { margin-top: 3vh; font-size: 3vh; color: var(--muted); font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<div id="banners"></div>
<main>
  <div id="status">Waiting for a card</div>
  <div id="name"></div>
  <div id="details"></div>
  <div id="meta"></div>
</main>
<script>
const BOOT_VERSION = "{{VERSION}}";
const $ = (id) => document.getElementById(id);
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
let state = null;
let connected = false;

function renderScan(e) {
  const s = e.student;
  $('status').className = s ? 'known' : 'unknown';
  $('status').textContent = s ? 'Welcome' : 'Unknown card';
  $('name').textContent = s ? s.full_name : e.uid;
  $('details').textContent = s
    ? [s.student_no, s.grade_level, s.section_name].filter(Boolean).join('  ·  ')
    : 'This card is not enrolled. Please see the office.';
  $('meta').textContent = clock(e.at);
}

function renderBanners() {
  const list = [];
  if (!connected) {
    list.push(['bad', 'Scanner service not responding']);
  } else if (state) {
    if (!state.readerOnline) list.push(['bad', 'READER OFFLINE — check the reader USB cable']);
    else if (!state.readerEnabled) list.push(['bad', 'Reader paused — cards are not being accepted']);
    if (state.rosterStale) {
      list.push(['quiet', state.rosterSyncedAt
        ? 'Student list last updated ' + new Date(state.rosterSyncedAt).toLocaleString()
        : 'Student list not downloaded yet']);
    }
    if (state.queueDepth > 0 && (state.uploadOk === false || !state.netOn)) {
      list.push(['quiet', 'Offline — ' + state.queueDepth + ' scan(s) saved, they will be sent when the internet is back']);
    }
  }
  $('banners').replaceChildren(...list.map(([cls, text]) => {
    const div = document.createElement('div');
    div.className = 'banner ' + cls;
    div.textContent = text;
    return div;
  }));
}

const events = new EventSource('/events');
events.onopen = () => { connected = true; renderBanners(); };
events.onerror = () => { connected = false; renderBanners(); };
events.onmessage = (m) => {
  const e = JSON.parse(m.data);
  if (e.type === 'scan') renderScan(e);
  if (e.type === 'state') {
    if (e.state.version !== BOOT_VERSION) { location.reload(); return; }
    state = e.state;
    renderBanners();
  }
};
renderBanners();
</script>
</body>
</html>
`;
```

- [ ] **Step 4: Run the tests and the type check**

Run: `cd gate && npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add gate/src/display gate/src/control.ts gate/src/control.test.ts
git commit -m "Serve the kiosk page over SSE and a localhost control API"
```

---

### Task 8: Wire the service, build the bundle, and test it end to end on the Mac

**Files:**
- Create: `gate/src/main.ts`, `gate/scripts/build.mjs`
- Test: `gate/src/main.test.ts` (spawns the real service against a fake Supabase)

**Interfaces:**
- Consumes: everything above.
- Produces: `src/main.ts` (entry point; exits `78` on bad config so systemd does not restart-loop); `npm run build` → `dist/gate.mjs`, `dist/deploy/`, `dist/VERSION`.

- [ ] **Step 1: Write the failing end-to-end test**

`gate/src/main.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpPath, waitFor } from './test-helpers.ts';

// Runs the real service (src/main.ts, or the bundle when GATE_ENTRY is set)
// with the keyboard reader on a pipe and a fake Supabase on localhost:
//   GATE_ENTRY=dist/gate.mjs node --test src/main.test.ts
const ENTRY = process.env.GATE_ENTRY ?? 'src/main.ts';
const TOKEN = 'gt_' + 'c'.repeat(64);
const SNAP = {
  school_id: 'school-1', device_id: 'gate-test', generated_at: '2026-10-05T07:00:00Z',
  students: [{ student_id: 'st1', full_name: 'Dela Cruz, Juan', student_no: '2026-0001', grade_level: 'Grade 7', section_name: 'Rizal' }],
  cards: [{ card_uid: '0002008108', student_id: 'st1' }],
};

async function freePort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

test('a typed card is shown, queued and delivered to record_attendance', async () => {
  const received: { fn: string; args: Record<string, unknown> }[] = [];
  const fake = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const fn = (req.url ?? '').replace('/rest/v1/rpc/', '');
    const args = JSON.parse(body || '{}') as Record<string, unknown>;
    received.push({ fn, args });
    if (fn === 'gate_roster_snapshot') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SNAP));
    } else if (fn === 'record_attendance') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(String((args.events as unknown[]).length));
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const supabaseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const port = await freePort();

  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY], {
    env: {
      ...process.env,
      SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: 'anon', DEVICE_ID: 'gate-test', GATE_TOKEN: TOKEN,
      READER: 'keyboard', DB_PATH: tmpPath('gate.db'), HTTP_PORT: String(port),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (b: Buffer) => { output += b.toString(); });
  child.stderr.on('data', (b: Buffer) => { output += b.toString(); });

  try {
    await waitFor(() => output.includes('[roster] synced 1 students'), 5000);
    assert.deepEqual(received[0], { fn: 'gate_roster_snapshot', args: { p_device_id: 'gate-test', p_token: TOKEN } });

    child.stdin.write('0002008108\n');
    await waitFor(() => received.some((r) => r.fn === 'record_attendance'), 5000);
    const events = received.find((r) => r.fn === 'record_attendance')!.args.events as Record<string, unknown>[];
    assert.equal(events.length, 1);
    assert.equal(events[0].card_uid, '0002008108');
    assert.equal(events[0].device_id, 'gate-test');
    assert.equal(events[0].queued, false);

    // The ack lands after the response; wait for it before reading counters.
    await waitFor(() => output.includes('[upload] 1 sent'), 5000);
    const status = (await (await fetch(`http://127.0.0.1:${port}/control/status`)).json()) as Record<string, unknown>;
    assert.equal(status.queueDepth, 0);
    assert.equal(status.sent, 1);
    assert.equal(status.rosterStudents, 1);
    assert.ok(output.includes('0002008108 queued (Dela Cruz, Juan)'), output);
  } catch (err) {
    console.error(output);
    throw err;
  } finally {
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    fake.closeAllConnections();
    await new Promise((r) => fake.close(r));
  }
});

test('a bad configuration exits 78 with every problem listed', async () => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY], {
    env: { PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (b: Buffer) => { output += b.toString(); });
  const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
  assert.equal(code, 78);
  assert.match(output, /SUPABASE_URL is not set/);
  assert.match(output, /GATE_TOKEN is not set/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gate && node --disable-warning=ExperimentalWarning --test src/main.test.ts`
Expected: FAIL — the child cannot find `src/main.ts`; `waitFor timed out`.

- [ ] **Step 3: Implement `src/main.ts`**

```ts
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createClockProbe } from './clock.ts';
import { loadConfig, type Config } from './config.ts';
import type { ControlApi } from './control.ts';
import { Cooldown } from './cooldown.ts';
import { getMeta, openDb, setMeta } from './db.ts';
import { createGateServer } from './display/server.ts';
import { SseHub, type GateState } from './display/sse.ts';
import type { Log } from './log.ts';
import { ScanQueue } from './queue.ts';
import { createReader } from './reader/index.ts';
import { RosterMirror, RosterSync } from './roster.ts';
import { Scanner } from './scanner.ts';
import { createRpc } from './supabase.ts';
import { Uploader } from './uploader.ts';

// Replaced at build time by scripts/build.mjs with the git revision.
declare const GATE_VERSION: string | undefined;
const VERSION = typeof GATE_VERSION === 'string' ? GATE_VERSION : 'dev';

const ROSTER_SYNC_EVERY_MS = 5 * 60_000;
const STATE_EVERY_MS = 2_000;
const STATUS_LOG_EVERY_MS = 60_000;
const PRUNE_EVERY_MS = 24 * 3_600_000;
const KEEP_SENT_MS = 7 * 24 * 3_600_000;
// sysexits EX_CONFIG. gate-scanner.service does not restart on it: a missing
// key will not fix itself, and a restart loop would bury the message.
const EX_CONFIG = 78;

const log: Log = (line) => console.log(line);

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(EX_CONFIG);
}

const db = openDb(config.dbPath);
const queue = new ScanQueue(db);
const mirror = new RosterMirror(db);
const rpc = createRpc(config.supabaseUrl, config.anonKey);
const roster = new RosterSync(mirror, rpc, config.deviceId, config.gateToken, log);
const uploader = new Uploader(queue, rpc, config.deviceId, log);
const reader = createReader(config, log);
reader.setEnabled(getMeta(db, 'reader_enabled') !== '0');
const hub = new SseHub();
const clockSynced = createClockProbe();

const state = (): GateState => ({
  version: VERSION,
  readerOnline: reader.online,
  readerEnabled: reader.enabled,
  rosterSyncedAt: mirror.syncedAt(),
  rosterStale: roster.isStale(),
  queueDepth: queue.depth(),
  netOn: uploader.netOn,
  uploadOk: uploader.lastOk,
});
const pushState = (): void => hub.broadcast({ type: 'state', state: state() });

const scanner = new Scanner({
  deviceId: config.deviceId,
  queue,
  mirror,
  cooldown: new Cooldown(),
  clockSynced: () => clockSynced(),
  show: (view) => hub.broadcast({ type: 'scan', ...view }),
  unknownCard: () => {
    roster.requestResync();
  },
  log,
});

reader.onCard((uid) => {
  scanner.handle(uid);
  pushState();
});
reader.onStatus(pushState);

function diskFreeMb(): number | null {
  try {
    const s = statfsSync(dirname(config.dbPath));
    return Math.round((s.bavail * s.bsize) / 1_048_576);
  } catch {
    return null;
  }
}

const control: ControlApi = {
  status: () => ({
    ...state(),
    deviceId: config.deviceId,
    reader: config.reader,
    clockSynced: clockSynced(),
    sent: uploader.sent,
    failed: uploader.failed,
    duplicates: uploader.duplicates,
    dropped: queue.dropped(),
    saveFailures: scanner.failures,
    rosterStudents: mirror.studentCount(),
    diskFreeMb: diskFreeMb(),
    uptimeS: Math.round(process.uptime()),
  }),
  inject: (uid) => reader.inject(uid),
  burst: (n) => reader.injectBurst(n),
  setNet: (on) => {
    uploader.netOn = on;
    log(on ? '[net] ON -- uploader will drain the queue' : '[net] OFF -- scans will queue locally');
    pushState();
  },
  setReader: (on) => {
    reader.setEnabled(on);
    setMeta(db, 'reader_enabled', on ? '1' : '0');
    log(on ? '[reader] RUNNING -- accepting cards' : '[reader] STOPPED -- no cards accepted (survives restart)');
    pushState();
  },
  queueDepth: () => queue.depth(),
  queueDump: (n) => queue.take(n),
  syncRoster: async () => {
    const result = await roster.sync();
    pushState();
    return result;
  },
};

function prune(): void {
  const n = queue.prune(new Date(Date.now() - KEEP_SENT_MS).toISOString());
  if (n > 0) log(`[queue] pruned ${n} sent scan(s) older than 7 days`);
}

const server = createGateServer({ hub, version: VERSION, control });
server.listen(config.httpPort, config.httpHost, () => {
  log(`[http] page and control on http://${config.httpHost}:${config.httpPort}`);
});

log(
  `[sys] gate ${VERSION} device=${config.deviceId} reader=${config.reader} ` +
    `db=${config.dbPath} pending=${queue.depth()} reader_enabled=${reader.enabled}`,
);
reader.start();
prune();
void roster.sync().then(pushState);
void uploader.run();

const timers = [
  setInterval(() => void roster.sync().then(pushState), ROSTER_SYNC_EVERY_MS),
  setInterval(pushState, STATE_EVERY_MS),
  setInterval(prune, PRUNE_EVERY_MS),
  setInterval(() => log(`[status] ${JSON.stringify(control.status())}`), STATUS_LOG_EVERY_MS),
];

function shutdown(signal: string): void {
  log(`[sys] ${signal} -- stopping`);
  for (const t of timers) clearInterval(t);
  reader.stop();
  uploader.stop();
  server.closeAllConnections();
  server.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

- [ ] **Step 4: Run the end-to-end test and the full suite**

Run: `cd gate && npm test && npm run typecheck`
Expected: all PASS, including both tests in `src/main.test.ts`.

- [ ] **Step 5: Add the build script and test the bundle**

`gate/scripts/build.mjs`:

```js
// Bundles the service into ONE file for the mini PC: no node_modules, no
// native modules, nothing to compile on the target. Copies deploy/ beside it.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain', '--', '.') !== '';
const version = dirty ? `${sha}-dirty` : sha;

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/gate.mjs',
  external: ['node:sqlite'],
  define: { GATE_VERSION: JSON.stringify(version) },
  banner: { js: `// gate ${version}` },
});
cpSync('deploy', 'dist/deploy', { recursive: true });
writeFileSync('dist/VERSION', `${version}\n`);
console.log(`built dist/gate.mjs (${version})`);
```

`deploy/` does not exist until Task 9, so create an empty placeholder for now: `mkdir -p gate/deploy && touch gate/deploy/.gitkeep`.

Run:

```bash
cd gate && npm run build && GATE_ENTRY=dist/gate.mjs node --disable-warning=ExperimentalWarning --test src/main.test.ts
```

Expected: `built dist/gate.mjs (<sha>-dirty)`, then both end-to-end tests PASS against the bundle.

- [ ] **Step 6: Commit**

```bash
git add gate/src/main.ts gate/src/main.test.ts gate/scripts/build.mjs gate/deploy/.gitkeep
git commit -m "Wire the gate service together and bundle it with esbuild"
```

- [ ] **Step 7: Live test against the real Supabase project (human + agent)**

This writes rows to the shared production project, so the **user** creates the device and token; the agent runs the rest.

User, in the Supabase SQL Editor (the editor has no logged-in user, so the claim line makes `issue_gate_device_token()`'s admin check see you; replace both placeholders):

```sql
insert into pta.gate_devices (device_id, school_id, label)
values ('gate-dev-mac', '<school uuid>', 'Developer Mac -- not a real gate');

select set_config('request.jwt.claims',
  json_build_object('sub', '<your auth.users id>', 'role', 'authenticated')::text, true);
select pta.issue_gate_device_token('gate-dev-mac');
```

Copy the returned `gt_...` token into `gate/.env.local` (git-ignored):

```
SUPABASE_URL=https://lvcbmopdstvupjpytjbb.supabase.co
SUPABASE_ANON_KEY=<anon key, same one include/secrets.h uses>
DEVICE_ID=gate-dev-mac
GATE_TOKEN=gt_...
READER=keyboard
DB_PATH=./gate-dev.db
```

Agent, with `cd gate && npm run dev` running in one terminal:

1. Log shows `[roster] synced <N> students, <M> cards` with N matching `select count(*) from pta.gate_roster where school_id = '<school uuid>'`.
2. `open -na "Google Chrome" --args --kiosk --user-data-dir=/tmp/gate-kiosk http://127.0.0.1:8080` — page shows "Waiting for a card", no red banner.
3. Catch-up test: `curl -s -X POST localhost:8080/control/net -d '{"on":false}'`, `curl -s -X POST localhost:8080/control/burst -d '{"n":200}'`, confirm `curl -s localhost:8080/control/queue` reports `"depth": 200` and the page shows the offline banner; then `curl -s -X POST localhost:8080/control/net -d '{"on":true}'` and watch `[upload]` lines drain to 0.
4. Exactly once: `select count(*), count(distinct event_id) from pta.attendance where device_id = 'gate-dev-mac' and card_uid ~ '^B[0-9]{7}$' and received_at > now() - interval '15 minutes';` → `200 | 200`.
5. Crash durability: `net off`, `burst 50`, `kill -9` the dev process, restart `npm run dev`, `net on`; the 50 land (count rises to 250, distinct still equal).
6. Real reader: plug the USB reader into the Mac, focus the `npm run dev` terminal, swipe a new card. Screen shows UNKNOWN CARD; the card appears unassigned on `/enroll`. Enrol it to a test student, wait at least a minute, swipe again: the screen shows the student's name (unknown-card resync).

The user may delete the synthetic rows afterwards (`delete from pta.attendance where device_id = 'gate-dev-mac' and card_uid ~ '^B[0-9]{7}$';`) and deactivate `gate-dev-mac` when development ends.

---

### Task 9: Mini PC deployment, operator docs, and hardware acceptance

**Files:**
- Create: `gate/deploy/gate-scanner.service`, `gate/deploy/gate-display.service`, `gate/deploy/cage.pam`, `gate/deploy/gate.env.example`, `gate/deploy/setup-minipc.sh`, `gate/deploy/deploy.sh`, `gate/deploy/rollback.sh`, `gate/README.md`
- Delete: `gate/deploy/.gitkeep`
- Modify: `docs/superpowers/specs/2026-09-19-linux-gate-migration-design.md` (Status line)

**Interfaces:**
- Consumes: `dist/` layout from Task 8 (`gate.mjs`, `deploy/`, `VERSION`); `/control/*` routes from Task 7; exit code 78 from Task 8.
- Produces: `/opt/gate/releases/<version>/`, `/opt/gate/current` symlink, systemd units `gate-scanner` and `gate-display`.

- [ ] **Step 1: Write the systemd units, PAM file and env example**

`gate/deploy/gate-scanner.service`:

```ini
[Unit]
Description=Gate scanner (card reader, queue, uploader, kiosk page)
After=network-online.target
Wants=network-online.target

[Service]
User=gate
Group=gate
SupplementaryGroups=input
EnvironmentFile=/etc/gate/gate.env
Environment=DB_PATH=/var/lib/gate/gate.db
StateDirectory=gate
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning /opt/gate/current/gate.mjs
Restart=always
RestartSec=2
# 78 = bad configuration (EX_CONFIG). Restarting will not fix it.
RestartPreventExitStatus=78
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

`gate/deploy/gate-display.service` (shape from cage's "start on boot with systemd" wiki; **verify on the hardware**):

```ini
[Unit]
Description=Gate display (cage + Chrome kiosk)
After=gate-scanner.service systemd-user-sessions.service getty@tty1.service
Wants=gate-scanner.service
Conflicts=getty@tty1.service

[Service]
User=kiosk
PAMName=cage
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
StandardInput=tty-fail
StandardOutput=journal
StandardError=journal
UtmpIdentifier=tty1
UtmpMode=user
# Wait up to a minute for the page; if it is not there the page itself shows
# "Scanner service not responding" and reconnects, so start anyway.
ExecStartPre=-/usr/bin/timeout 60 /bin/sh -c 'until curl -sf -o /dev/null http://127.0.0.1:8080/; do sleep 1; done'
ExecStart=/usr/bin/cage -s -- /usr/bin/google-chrome --kiosk --ozone-platform=wayland --no-first-run --noerrdialogs --disable-infobars --disable-session-crashed-bubble --disable-features=Translate --password-store=basic --user-data-dir=/home/kiosk/.config/gate-chrome http://127.0.0.1:8080/
Restart=always
RestartSec=3

[Install]
WantedBy=graphical.target
```

`gate/deploy/cage.pam`:

```
auth     required pam_unix.so nullok
account  required pam_unix.so
session  required pam_unix.so
session  required pam_systemd.so
```

`gate/deploy/gate.env.example`:

```
# /etc/gate/gate.env -- root:root, mode 0600. Loaded by gate-scanner.service.
SUPABASE_URL=https://lvcbmopdstvupjpytjbb.supabase.co
SUPABASE_ANON_KEY=
DEVICE_ID=gate-01-pc
# From: select pta.issue_gate_device_token('gate-01-pc');  (shown once)
GATE_TOKEN=
READER=evdev
# The by-id path survives replugging; /dev/input/eventN does not.
READER_DEVICE=/dev/input/by-id/usb-Sycreader_RFID_Technology_Co.__Ltd_SYC_ID_IC_USB_Reader_08FF20140315-event-kbd
```

- [ ] **Step 2: Write the provisioning script**

`gate/deploy/setup-minipc.sh`:

```bash
#!/usr/bin/env bash
# One-time (and safely re-runnable) provisioning of the gate mini PC.
# Ubuntu Server 24.04, x86_64. From the Mac, after `npm run build`:
#   scp -r dist/deploy admin@minipc:/tmp/gate-deploy
#   ssh -t admin@minipc sudo bash /tmp/gate-deploy/setup-minipc.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"

timedatectl set-timezone Asia/Manila
timedatectl set-ntp true

apt-get update
apt-get install -y ca-certificates curl evtest cage rsync

# Node 22 LTS (node:sqlite unflagged from 22.13).
if ! node --version 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Google Chrome from its .deb. Ubuntu's Chromium is a snap, and snap
# confinement fights cage for the seat.
if ! command -v google-chrome >/dev/null; then
  curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y /tmp/chrome.deb
fi

# gate: runs the scanner, may read input devices. kiosk: runs the browser and
# deliberately may NOT -- the page never needs the reader.
id gate >/dev/null 2>&1 || useradd --create-home --shell /bin/bash gate
usermod -aG input gate
id kiosk >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin kiosk
usermod -aG video,render kiosk

# Let the Mac deploy as gate@minipc with the admin's existing SSH key.
if [[ -n "${SUDO_USER:-}" && -f "/home/$SUDO_USER/.ssh/authorized_keys" ]]; then
  install -d -o gate -g gate -m 0700 /home/gate/.ssh
  install -o gate -g gate -m 0600 "/home/$SUDO_USER/.ssh/authorized_keys" /home/gate/.ssh/authorized_keys
fi

install -d -o gate -g gate /opt/gate /opt/gate/releases
install -d -m 0755 /etc/gate
if [[ ! -f /etc/gate/gate.env ]]; then
  install -m 0600 "$HERE/gate.env.example" /etc/gate/gate.env
  echo ">>> fill in /etc/gate/gate.env (anon key and GATE_TOKEN) before starting the gate"
fi

install -m 0644 "$HERE/cage.pam" /etc/pam.d/cage
cat > /etc/sudoers.d/gate <<'EOF'
gate ALL=(root) NOPASSWD: /usr/bin/systemctl restart gate-scanner, /usr/bin/systemctl restart gate-display
EOF
chmod 0440 /etc/sudoers.d/gate
visudo -cf /etc/sudoers.d/gate

install -m 0644 "$HERE/gate-scanner.service" "$HERE/gate-display.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable gate-scanner gate-display
systemctl set-default graphical.target

echo ">>> provisioning done. Remaining manual steps: BIOS 'restore on AC power loss',"
echo ">>> pin the display resolution, and the first ./deploy/deploy.sh from the Mac."
```

- [ ] **Step 3: Write the deploy and rollback scripts**

`gate/deploy/deploy.sh`:

```bash
#!/usr/bin/env bash
# Build on this Mac, ship to the mini PC, switch release, restart.
#   ./deploy/deploy.sh                   normal deploy (refused during arrival/dismissal)
#   FORCE=1 ./deploy/deploy.sh           deploy anyway
#   GATE_HOST=gate@10.0.0.5 ./deploy/deploy.sh
# While gate-scanner restarts (~1 s) the reader is not grabbed, so a card
# swiped in that second types into the kiosk browser instead of being
# recorded. That is why busy hours are refused.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${GATE_HOST:-gate@minipc}"
BUSY="${GATE_BUSY_HOURS:-0600-0830 1530-1800}"

now=$(ssh "$HOST" date +%H%M)
if [[ "${FORCE:-0}" != 1 ]]; then
  for window in $BUSY; do
    if (( 10#$now >= 10#${window%-*} && 10#$now < 10#${window#*-} )); then
      echo "refusing: it is $now at the gate, inside busy window $window (FORCE=1 to override)"
      exit 1
    fi
  done
fi

npm test
npm run build
version=$(cat dist/VERSION)
rsync -az --delete dist/ "$HOST:/opt/gate/releases/$version/"

ssh "$HOST" bash -s -- "$version" <<'EOF'
set -euo pipefail
v="$1"
prev=$(readlink /opt/gate/current || true)
switch() { ln -sfn "$1" /opt/gate/current.new && mv -T /opt/gate/current.new /opt/gate/current; }
switch "/opt/gate/releases/$v"
sudo systemctl restart gate-scanner
sleep 3
if ! systemctl is-active --quiet gate-scanner; then
  echo "gate-scanner did not start on $v:"
  journalctl -u gate-scanner -n 30 --no-pager || true
  if [[ -n "$prev" ]]; then
    switch "$prev"
    sudo systemctl restart gate-scanner
    echo "rolled back to $(basename "$prev")"
  fi
  exit 1
fi
cd /opt/gate/releases
# Keep the current release and the four newest others. grep finds nothing on
# the first deploy, which must not fail the script under pipefail.
{ ls -1t | grep -vx "$v" || true; } | tail -n +5 | xargs -r rm -rf --
echo "gate-scanner running $v"
EOF
```

`gate/deploy/rollback.sh`:

```bash
#!/usr/bin/env bash
# Point the gate back at the previous release and restart. Seconds, no
# rebuild. A release that refuses to open gate.db ("schema version") was
# rolled back past a schema change: deploy the newer release again instead.
set -euo pipefail
HOST="${GATE_HOST:-gate@minipc}"
ssh "$HOST" bash -s <<'EOF'
set -euo pipefail
cur=$(basename "$(readlink /opt/gate/current)")
prev=$(cd /opt/gate/releases && ls -1t | grep -vx "$cur" | head -n 1 || true)
[[ -n "$prev" ]] || { echo "no earlier release to roll back to"; exit 1; }
ln -sfn "/opt/gate/releases/$prev" /opt/gate/current.new && mv -T /opt/gate/current.new /opt/gate/current
sudo systemctl restart gate-scanner
echo "rolled back $cur -> $prev"
EOF
```

Then: `rm gate/deploy/.gitkeep && chmod +x gate/deploy/*.sh`.

- [ ] **Step 4: Verify the scripts and the build output**

Run:

```bash
cd gate && bash -n deploy/setup-minipc.sh deploy/deploy.sh deploy/rollback.sh \
  && npm run build && ls dist dist/deploy
```

Expected: no syntax errors; `dist/` contains `gate.mjs`, `VERSION`, `deploy/` with all seven deploy files. If `shellcheck` is installed (`brew install shellcheck`), `shellcheck deploy/*.sh` reports no errors.

- [ ] **Step 5: Write `gate/README.md`**

```markdown
# gate

The school-gate service for the Linux mini PC: reads the USB card reader,
shows the student on the kiosk monitor, and queues every scan to
`pta.record_attendance()`. Design: `docs/superpowers/specs/2026-09-19-linux-gate-migration-design.md`.

## Develop on the Mac

    npm install
    npm test
    cp deploy/gate.env.example .env.local   # then set READER=keyboard, DB_PATH=./gate-dev.db
    npm run dev                             # swipe cards into this terminal
    open -na "Google Chrome" --args --kiosk --user-data-dir=/tmp/gate-kiosk http://127.0.0.1:8080

## Control (replaces the ESP32 serial console)

    curl -s localhost:8080/control/status
    curl -s -X POST localhost:8080/control/scan   -d '{"uid":"0002008108"}'
    curl -s -X POST localhost:8080/control/burst  -d '{"n":200}'
    curl -s -X POST localhost:8080/control/net    -d '{"on":false}'
    curl -s -X POST localhost:8080/control/reader -d '{"on":false}'   # persists
    curl -s 'localhost:8080/control/queue?dump=20'
    curl -s -X POST localhost:8080/control/roster/sync

On the mini PC, prefix with `ssh gate@minipc`.

## Device token

The gate reads its school's roster with a per-device secret. In the Supabase
SQL Editor, as an admin of the school:

    select set_config('request.jwt.claims',
      json_build_object('sub', '<your auth.users id>', 'role', 'authenticated')::text, true);
    select pta.issue_gate_device_token('gate-01-pc');

Put the `gt_...` result in `/etc/gate/gate.env` as `GATE_TOKEN`. It is shown
once; running it again issues a new token and invalidates the old one, which
is also how a stolen mini PC is locked out.

## Mini PC

First time: `npm run build`, then follow the header of `deploy/setup-minipc.sh`.

Every update: commit, then `./deploy/deploy.sh` (refused 06:00-08:30 and
15:30-18:00 gate time unless `FORCE=1`). Undo: `./deploy/rollback.sh`.

Logs: `ssh gate@minipc journalctl -u gate-scanner -f`
```

- [ ] **Step 6: Mark the spec as planned**

In `docs/superpowers/specs/2026-09-19-linux-gate-migration-design.md`, change line 4:

```
**Status:** Approved, not yet implemented
```

to:

```
**Status:** Approved; implementation plan in `docs/superpowers/plans/2026-10-02-linux-gate.md`
```

- [ ] **Step 7: Commit**

```bash
git add gate/deploy gate/README.md docs/superpowers/specs/2026-09-19-linux-gate-migration-design.md
git commit -m "Add mini PC provisioning, deploy and rollback scripts"
```

- [ ] **Step 8: Hardware acceptance on the mini PC (human, with the agent reading logs)**

Cannot run on the Mac. Do these in order with the real reader and monitor, at a quiet hour:

1. **Provision:** run `setup-minipc.sh` as in its header; fill `/etc/gate/gate.env` for `gate-01-pc` (register the device and issue its token as in the README); set the BIOS to restore on AC power loss; pin the resolution (e.g. `video=HDMI-A-1:1920x1080@60` on the kernel command line — the connector name comes from `ls /sys/class/drm`).
2. **First deploy:** `FORCE=1 ./deploy/deploy.sh` from the Mac; `ssh gate@minipc journalctl -u gate-scanner -n 50` shows `[reader] ONLINE ... (exclusive grab)` and `[roster] synced`.
3. **Display:** `sudo reboot`; the monitor comes up straight into the kiosk page with no desktop, no cursor, no red banner.
4. **Exclusive grab (spec test 2):** on the console (`Ctrl+Alt+F2`, log in) focus the shell and swipe a card. **Nothing may be typed.** If digits appear, the grab failed: stop and fix before going further.
5. **Hotplug (spec test 1):** unplug the reader — within 2 s the screen shows READER OFFLINE; plug it back — the banner clears and a swipe works.
6. **Simulated first (cutover step 4):** `curl -s -X POST localhost:8080/control/burst -d '{"n":20}'` over SSH; 20 rows for `gate-01-pc` land in `pta.attendance`.
7. **Acceptance:** swipe an enrolled new card. The screen shows the student in under a second, the guardian's Telegram message arrives, and the row is in `pta.attendance`.
8. **Power cut:** `net off`, swipe 3 cards, pull the power, restore it. The box boots by itself, the 3 scans are still queued (`/control/queue`), and they land after `net on`.
```

---

## Self-Review Notes

- **Spec coverage:** modules `reader/` `queue/` `uploader/` `roster/` `display/` `control/` → Tasks 5, 2, 3, 4, 7, 7. Data model → Task 2 (the spec's `queued` column is computed at send time instead of stored, exactly as the firmware's `finalizeForUpload` did, so a scan's lateness is judged when it actually leaves). Roster mirror rules → Task 4. Failure table → Tasks 3 (internet), 5 (reader unplugged), 9 (crash/restart units, power), 4 (sync fails), 2+8 (disk cap, prune, free space in status), 3 (duplicates). Configuration → Tasks 1, 9. Deployment → Tasks 8, 9. Testing (Mac) → every task + Task 8 live; (mini PC) → Task 9 Step 8. Cutover steps 3-5 → Task 8 Step 7 and Task 9 Step 8; step 6 (ESP32 `reader off` for a week) is an operations step after this plan.
- **Deliberate additions beyond the spec:** release folders + automatic rollback on a failed start, busy-hours guard, page auto-reload on version change, schema-version guard, exit 78 on bad config, refusing an empty roster snapshot — each discussed with the user or listed in Review Focus.
