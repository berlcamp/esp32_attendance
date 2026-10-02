import { normalizeUid } from './uid.ts';

const DIGITS: Record<string, string> = {};
for (let i = 0; i <= 9; i++) {
  DIGITS[`KEY_${i}`] = String(i);
  DIGITS[`KEY_KP${i}`] = String(i);
}
const ENTER = new Set(['KEY_ENTER', 'KEY_KPENTER']);

// The reader types a whole card in well under 100 ms. A gap this long between
// keys means the previous digits were a skimmed swipe, not the start of this
// card.
export const KEYSTROKE_GAP_MS = 500;

export type Assembled = { uid: string } | { misread: string };

export class KeystrokeAssembler {
  #buf = '';
  #lastAt = 0;
  #gapMs: number;

  constructor(gapMs = KEYSTROKE_GAP_MS) {
    this.#gapMs = gapMs;
  }

  feed(key: string, nowMs: number): Assembled | null {
    if (this.#buf && nowMs - this.#lastAt > this.#gapMs) this.#buf = '';
    this.#lastAt = nowMs;

    const digit = DIGITS[key];
    if (digit !== undefined) {
      if (this.#buf.length < 64) this.#buf += digit;
      return null;
    }
    if (ENTER.has(key)) {
      const raw = this.#buf;
      this.#buf = '';
      if (!raw) return null;
      const uid = normalizeUid(raw);
      return uid ? { uid } : { misread: raw };
    }
    return null;
  }
}
