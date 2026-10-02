// The Sycreader USB reader types an EM4100 card as ten decimal digits then
// Enter (prerequisite test, 2026-10-02). That string IS the card's identity in
// pta.student_cards: leading zeros kept, never converted to a number. Anything
// else is a misread -- a skimmed swipe or a stray key -- and must never become
// attendance.
const TEN_DIGITS = /^\d{10}$/;

export function normalizeUid(raw: string): string | null {
  const s = raw.trim();
  return TEN_DIGITS.test(s) ? s : null;
}
