/**
 * The order conversations appear in, for BOTH clients.
 *
 * Web listed topics in whatever order `/api/topics` returned — creation order —
 * while mobile sorted by the latest message. The same account showed two
 * different conversation lists depending on the device, and the web one put the
 * room you were just talking in wherever it happened to fall.
 *
 * Two copies exist — `src/lib/chatSort.ts` (web) and
 * `packages/mobile/src/lib/chatSort.ts` (mini-app) — and a test asserts they
 * stay BYTE-IDENTICAL, so keep this file dependency-free.
 */

/** Minimum a conversation must expose to be ordered. */
export interface SortableConversation {
  id: string;
  /** Fallback ordering key for a room nobody has spoken in yet. */
  createdAt: string;
}

/**
 * Newest first, where "newest" means the last thing that HAPPENED in a room:
 * its latest message, or — for a room nobody has spoken in — when it was
 * created. One axis, so a topic created seconds ago lands at the top where the
 * person who just created it expects to find it, while a room created last year
 * and never used sinks to the bottom on its own.
 *
 * An earlier version ranked every silent room below every spoken-in one. That
 * put a topic the user had just made underneath every old conversation, which
 * is exactly where nobody looks for it.
 *
 * Pure and total: unparseable or missing timestamps sort last rather than
 * throwing, because one bad row must not blank the list.
 */
export function sortConversationsByActivity<T extends SortableConversation>(
  conversations: readonly T[],
  lastActivityAt: (conversation: T) => string | null | undefined,
): T[] {
  const at = (value: string | null | undefined): number => {
    if (!value) return NaN;
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? NaN : ms;
  };
  /** Last thing that happened here: a message if there is one, else creation. */
  const rank = (c: T): number => {
    const last = at(lastActivityAt(c));
    if (!Number.isNaN(last)) return last;
    return at(c.createdAt);
  };
  return [...conversations].sort((a, b) => {
    const rankA = rank(a);
    const rankB = rank(b);
    // A row with no usable timestamp at all sorts last rather than anywhere.
    if (Number.isNaN(rankA) && Number.isNaN(rankB)) return 0;
    if (Number.isNaN(rankA)) return 1;
    if (Number.isNaN(rankB)) return -1;
    return rankB - rankA;
  });
}
