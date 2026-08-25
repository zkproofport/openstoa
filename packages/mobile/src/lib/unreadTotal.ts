/**
 * How many unread messages this account has, across every room — ONE number,
 * used by all three badges.
 *
 * WHAT WAS MISSING. There were no badges at all. The app icon carried none, so
 * a push that arrived while the app was closed left nothing behind once the
 * notification was swiped away; the host's OpenStoa tab carried none, so opening
 * the app told you nothing; and the mini-app's own Chat tab carried none, so
 * even inside OpenStoa the only way to find a waiting message was to open the
 * Chat tab and look. The room ROWS have shown a per-room count for a while,
 * which is what made the gap easy to miss — the number existed, it just never
 * travelled up.
 *
 * ONE FUNCTION FOR ALL THREE, because three badges that disagree are worse than
 * none: an icon saying 3 over a tab saying 1 is a bug the reader can see and
 * cannot explain. The three surfaces differ only in where they draw it.
 */

import { formatUnreadBadge } from './chatUnreadBadge';

/** The minimum a row needs to contribute to the total. */
export interface UnreadCountable {
  unreadCount?: number | null;
}

/**
 * Add up the rooms.
 *
 * Hostile to bad input on purpose: this feeds a number into a native badge API,
 * and `setBadgeCount(NaN)` is the kind of call that either throws deep in a
 * platform module or paints something absurd on the home screen. A row whose
 * count is missing, negative, fractional or not a number contributes ZERO
 * rather than poisoning the sum.
 */
export function unreadTotal(rooms: readonly UnreadCountable[] | null | undefined): number {
  if (!Array.isArray(rooms)) return 0;
  let total = 0;
  for (const room of rooms) {
    const n = room?.unreadCount;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) continue;
    total += Math.floor(n);
  }
  return total;
}

/**
 * The label a TAB badge shows, or `undefined` for no badge.
 *
 * `undefined` and not `0` or `''`: React Navigation renders a dot for an empty
 * string and a literal "0" for zero, and a badge that says nothing is worse
 * than no badge — it draws the eye to a tab with nothing behind it.
 *
 * Capped by the shared `formatUnreadBadge`, so a tab and a room row cannot
 * disagree about what 100 unread looks like.
 */
export function unreadTabBadge(
  rooms: readonly UnreadCountable[] | null | undefined,
): string | undefined {
  return formatUnreadBadge(unreadTotal(rooms)) ?? undefined;
}
