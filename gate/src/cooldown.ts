export const CARD_COOLDOWN_MS = 10_000;

// Human double-swipe guard, per card, in memory. Measured on a MONOTONIC
// clock: an NTP step must not decide whether a child's second swipe counts.
// A rejected swipe does not reset the window (same as the firmware).
export class Cooldown {
  #ms: number;
  #last = new Map<string, number>();

  constructor(ms = CARD_COOLDOWN_MS) {
    this.#ms = ms;
  }

  accept(uid: string, monoMs: number): boolean {
    const prev = this.#last.get(uid);
    if (prev !== undefined && monoMs - prev < this.#ms) return false;
    this.#last.set(uid, monoMs);
    if (this.#last.size > 5000) {
      for (const [k, t] of this.#last) if (monoMs - t >= this.#ms) this.#last.delete(k);
    }
    return true;
  }
}
