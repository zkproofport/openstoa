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
 * Newest activity first. A room with no messages falls back to when it was
 * created, and sorts BELOW every room that has been spoken in — a brand-new
 * empty room jumping above a live conversation is the surprising outcome, not
 * the useful one.
 *
 * Pure and total: unparseable or missing timestamps are treated as "no
 * activity" rather than throwing, because one bad row must not blank the list.
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
  return [...conversations].sort((a, b) => {
    const lastA = at(lastActivityAt(a));
    const lastB = at(lastActivityAt(b));
    const hasA = !Number.isNaN(lastA);
    const hasB = !Number.isNaN(lastB);
    if (hasA && hasB) return lastB - lastA;
    // Spoken-in rooms always outrank silent ones, whatever their creation dates.
    if (hasA) return -1;
    if (hasB) return 1;
    const createdA = at(a.createdAt);
    const createdB = at(b.createdAt);
    if (Number.isNaN(createdA) && Number.isNaN(createdB)) return 0;
    if (Number.isNaN(createdA)) return 1;
    if (Number.isNaN(createdB)) return -1;
    return createdB - createdA;
  });
}
