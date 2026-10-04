import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { handleControl, type ControlApi, type ControlResult } from '../control.ts';
import { PAGE_HTML } from './page.ts';
import type { SseHub } from './sse.ts';

const MAX_BODY = 10_000;

// The kiosk's logos and backdrop. Beside this file in src/, beside gate.mjs in
// a release (scripts/build.mjs copies them), so the same relative URL finds both.
const ASSETS = new URL('./assets/', import.meta.url);
const ASSET_TYPES: Record<string, string> = {
  'deped-logo.png': 'image/png',
  'school-logo.png': 'image/png',
  'school-bg.svg': 'image/svg+xml',
};
function loadAssets(): Map<string, { type: string; body: Buffer }> {
  return new Map(Object.entries(ASSET_TYPES).map(([name, type]) =>
    [`/assets/${name}`, { type, body: readFileSync(new URL(name, ASSETS)) }]));
}

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
  const assets = loadAssets();
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(page);
        return;
      }
      const asset = req.method === 'GET' ? assets.get(url.pathname) : undefined;
      if (asset) {
        res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-cache' });
        res.end(asset.body);
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
