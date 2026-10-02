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
  // Listen now: if the child dies early, its exit must not be missed.
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
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
    child.kill('SIGTERM');
    const code = await exited;
    fake.closeAllConnections();
    await new Promise((r) => fake.close(r));
    assert.equal(code, 0);
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
