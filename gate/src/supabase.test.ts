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
