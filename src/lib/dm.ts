/**
 * DM (1:1 direct chat) helpers (P-D).
 *
 * A DM is modeled as a hidden 2-member topic (`topics.kind='dm'`) so it reuses
 * the entire E2EE chat/MLS/TAK stack unchanged — the chat routes key purely off
 * `topicId + membership + requireAiCapability`, so a DM topic behaves exactly
 * like any other chat channel once its two members exist. The server runs NO
 * crypto here (C1/SI-1): MLS genesis is client-driven via the returned topicId,
 * identical to a normal topic. This module only owns the canonical-pair identity
 * that makes `POST /api/dm` idempotent.
 */

/**
 * Canonical, order-independent identity for a DM between two users. Sorting the
 * two nullifiers and joining with `|` guarantees `pair(a,b) === pair(b,a)`, so a
 * unique index on `topics.dm_pair` makes start-or-get idempotent regardless of
 * which participant initiates. Nullifiers are hex `userId`s and never contain a
 * `|`, so the separator is unambiguous.
 */
export function canonicalDmPair(a: string, b: string): string {
  return [a, b].sort().join('|');
}

/**
 * One row of `GET /api/dm`. SI-1: routing metadata ONLY — the peer's identity
 * and a last-activity timestamp. There is deliberately no message body, and no
 * decrypted preview, because the server never holds one.
 */
export interface DmChannel {
  topicId: string;
  peer: { userId: string; nickname: string; profileImage: string | null };
  lastActivityAt: string | null;
}

/**
 * Most-recently-active first; channels that never saw activity last. The route
 * already sorts this way — re-applying it in the client keeps the rendered
 * order correct even if a caller (or a future cache layer) hands the list over
 * unsorted. Pure and non-mutating so both sides can share it.
 */
export function sortDmChannels(dms: DmChannel[]): DmChannel[] {
  return [...dms].sort((a, b) => {
    const ta = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
    const tb = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
    return tb - ta;
  });
}
