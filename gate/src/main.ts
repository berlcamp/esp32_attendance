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
