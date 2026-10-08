// Configuration comes from /etc/gate/gate.env via systemd's EnvironmentFile=,
// replacing include/secrets.h. Every problem is reported in one error so a
// misconfigured box needs one fix, not one restart per missing key.
import { dirname, join } from 'node:path';

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
  // The gate camera: a v4l2 device on the mini PC, an avfoundation name or
  // index on the Mac. null means no camera; taps are recorded without photos.
  cameraDevice: string | null;
  captureDir: string;
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

  const dbPath = env.DB_PATH?.trim() || '/var/lib/gate/gate.db';
  return {
    supabaseUrl,
    anonKey,
    deviceId,
    gateToken,
    reader: reader as ReaderKind,
    readerDevice,
    dbPath,
    httpHost: env.HTTP_HOST?.trim() || '127.0.0.1',
    httpPort,
    cameraDevice: env.CAMERA_DEVICE?.trim() || null,
    // Beside the database, so it is inside systemd's StateDirectory.
    captureDir: env.CAPTURE_DIR?.trim() || join(dirname(dbPath), 'captures'),
  };
}
