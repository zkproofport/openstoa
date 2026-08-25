/**
 * How an unread count is WRITTEN on a conversation row — one rule, both clients.
 *
 * The defect this exists for: the same badge, on the same surface, disagreed
 * across the two clients. The mini-app's row rendered `> 99 ? '99+'`; the web's
 * rendered `> 999 ? '999+'`, so a room with 100 unread said "99+" on the phone
 * and "100" in the browser. Neither is unreasonable on its own — which is
 * exactly how two hand-written copies of one rule drift — but a person reading
 * the same conversation on both sees the product contradict itself.
 *
 * NOT the same as `capUnread` (`src/lib/chatUnread.ts`), which clamps the number
 * the SERVER puts on the wire at 999. That is a transport bound: a count larger
 * than any client could render is information nothing can use. This is the
 * DISPLAY bound, and it is tighter, because the constraint is different — the
 * pill sits inside a fixed-width row next to a timestamp, and a fourth glyph
 * pushes into the timestamp or shrinks the touch target.
 */

/**
 * Past this, the badge says "99+" rather than a figure.
 *
 * 99 and not 999. The owner's requirement names this number ("3개면 3, 99를
 * 넘으면 99+"), and it is also what the mini-app's fetch window already
 * implies: the list pulls 100 messages per room, so 100 is the point past
 * which a wider fetch could not change what is displayed anyway.
 */
export const UNREAD_BADGE_MAX = 99;

/**
 * The badge text, or `null` when there should be no badge at all.
 *
 * `null` rather than an empty string, so a caller cannot render an empty pill by
 * forgetting to check — an empty pill is a visible dot that means nothing, and
 * that is what a `NaN` count used to draw on the web.
 *
 * Zero, negative, fractional, `NaN` and non-numbers all mean "nothing to flag".
 * They are collapsed rather than distinguished because a row has one place to
 * put an answer and no way to say "the count is broken".
 */
export function formatUnreadBadge(value: unknown): string | null {
  /*
   * A NUMBER, not something number-shaped. `'5'` renders nothing rather than
   * "5", deliberately: a count arriving as a string means the response shape
   * changed, and coercing it would let that change ship invisibly while the
   * badge kept looking right. The web's copy of this rule already refused
   * strings and is what caught the coercion when the two were merged.
   */
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return null;
  const whole = Math.floor(value);
  return whole > UNREAD_BADGE_MAX ? `${UNREAD_BADGE_MAX}+` : String(whole);
}
