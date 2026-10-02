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
