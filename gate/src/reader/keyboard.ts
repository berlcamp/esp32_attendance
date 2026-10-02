import { createInterface, type Interface } from 'node:readline';
import type { Log } from '../log.ts';
import { TagReader } from './reader.ts';
import { normalizeUid } from './uid.ts';

// For development on the Mac: the USB reader types into the terminal running
// `npm run dev`, one card per line. No grab -- that is Linux-only.
export class KeyboardReader extends TagReader {
  #log: Log;
  #input: NodeJS.ReadableStream;
  #rl: Interface | null = null;

  constructor(log: Log, input: NodeJS.ReadableStream = process.stdin) {
    super();
    this.#log = log;
    this.#input = input;
  }

  start(): void {
    this.#rl = createInterface({ input: this.#input });
    this.#rl.on('line', (line) => {
      const raw = line.trim();
      if (!raw) return;
      const uid = normalizeUid(raw);
      if (uid) this.emit(uid);
      else this.#log(`[reader] misread "${raw}" ignored (expected 10 digits)`);
    });
    this.setOnline(true);
  }

  stop(): void {
    this.#rl?.close();
    this.#rl = null;
    this.setOnline(false);
  }
}
