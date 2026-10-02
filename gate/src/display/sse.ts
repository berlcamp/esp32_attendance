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
