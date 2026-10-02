import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Log } from '../log.ts';
import { KeystrokeAssembler } from './keystrokes.ts';
import { TagReader } from './reader.ts';

// evtest takes the EVIOCGRAB exclusive grab Node cannot take without a native
// module. stdbuf makes its piped stdout line-buffered; without it, key events
// would sit in a 4 KB buffer.
export const EVTEST_COMMAND: readonly string[] = ['stdbuf', '-oL', 'evtest', '--grab'];

const KEY_DOWN = /type 1 \(EV_KEY\), code \d+ \((KEY_[A-Z0-9_]+)\), value 1$/;

export function parseEvtestLine(line: string): string | null {
  const m = KEY_DOWN.exec(line.trim());
  return m ? m[1] : null;
}

export class EvdevReader extends TagReader {
  #device: string;
  #log: Log;
  #command: readonly string[];
  #retryMs: number;
  #now: () => number;
  #assembler = new KeystrokeAssembler();
  #kill: (() => void) | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;
  #lastFailure = '';

  constructor(device: string, log: Log, opts: { command?: string[]; retryMs?: number; now?: () => number } = {}) {
    super();
    this.#device = device;
    this.#log = log;
    this.#command = opts.command ?? EVTEST_COMMAND;
    this.#retryMs = opts.retryMs ?? 2000;
    this.#now = opts.now ?? (() => performance.now());
  }

  start(): void {
    this.#stopped = false;
    this.#spawn();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#kill?.();
    this.setOnline(false);
  }

  #spawn(): void {
    const [cmd, ...args] = this.#command;
    const child = spawn(cmd, [...args, this.#device], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.#kill = () => child.kill();
    let stderr = '';
    let ended = false;

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.startsWith('Testing ...')) {
        if (!this.online) this.#log(`[reader] ONLINE ${this.#device} (exclusive grab)`);
        this.#lastFailure = '';
        this.setOnline(true);
        return;
      }
      const key = parseEvtestLine(line);
      if (!key) return;
      const r = this.#assembler.feed(key, this.#now());
      if (r && 'uid' in r) this.emit(r.uid);
      else if (r) this.#log(`[reader] misread "${r.misread}" ignored (expected 10 digits)`);
    });

    const onEnd = (why: string) => {
      if (ended) return;
      ended = true;
      this.#kill = null;
      if (this.#stopped) return;
      // Log on the transition and when the reason changes, not every 2 s.
      if (this.online || why !== this.#lastFailure) {
        this.#log(`[reader] OFFLINE ${this.#device}: ${why} -- retrying every ${this.#retryMs / 1000}s`);
      }
      this.#lastFailure = why;
      this.setOnline(false);
      this.#timer = setTimeout(() => this.#spawn(), this.#retryMs);
    };
    child.on('error', (err) => onEnd(err.message));
    child.on('close', (code) => onEnd(stderr.trim().split('\n').pop() || `evtest exited (${code})`));
  }
}
