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

test('the kiosk logos are served as PNGs', async () => {
  const { base, close } = await start();
  try {
    for (const name of ['deped-logo.png', 'school-logo.png']) {
      const res = await fetch(`${base}/assets/${name}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    }
    assert.equal((await fetch(`${base}/assets/../server.ts`)).status, 404);
  } finally {
    await close();
  }
});
