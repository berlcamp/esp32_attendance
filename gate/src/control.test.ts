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
  assert.match(JSON.stringify(r.body), /GET {2}\/control\/status/);
});
