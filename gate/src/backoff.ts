// Port of lib/core/Backoff.h. Offline is a normal state for a school gate, so
// the ceiling matters more than the growth: retry forever at a calm interval.
export class Backoff {
  #base: number;
  #max: number;
  #cur: number;
  #failures = 0;

  constructor(baseMs = 1000, maxMs = 60_000) {
    this.#base = baseMs;
    this.#max = maxMs;
    this.#cur = baseMs;
  }

  get delayMs(): number {
    return this.#cur;
  }

  get failures(): number {
    return this.#failures;
  }

  onFailure(): void {
    this.#failures++;
    this.#cur = Math.min(this.#cur * 2, this.#max);
  }

  onSuccess(): void {
    this.#cur = this.#base;
    this.#failures = 0;
  }
}
