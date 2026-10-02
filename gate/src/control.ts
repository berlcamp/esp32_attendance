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
