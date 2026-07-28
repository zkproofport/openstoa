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
