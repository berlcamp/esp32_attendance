import { TagReader } from './reader.ts';

// Deterministic fake cards, the last one never enrolled. Kept beside the real
// reader because it is the only way to exercise the whole path with no
// hardware.
export const SIMULATED_ROSTER: readonly string[] = [
  '9000000001', '9000000002', '9000000003', '9000000004', '9000000005',
  '9000000006', '9000000007', '9000000008', '9000000009', '9999999999',
];

export class SimulatedReader extends TagReader {
  #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #next = 0;

  constructor(intervalMs = 10_000) {
    super();
    this.#intervalMs = intervalMs;
  }

  start(): void {
    this.setOnline(true);
    this.#timer = setInterval(() => {
      this.emit(SIMULATED_ROSTER[this.#next]);
      this.#next = (this.#next + 1) % SIMULATED_ROSTER.length;
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.setOnline(false);
  }
}
