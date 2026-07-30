/**
 * Client-side helpers for the "새 대화" (new conversation) picker, backed by
 * `GET /api/dm/candidates` (src/app/api/dm/candidates/route.ts). The server
 * already owns de-duplication, self-exclusion, wildcard escaping
 * (`normaliseSearchQuery`) and the 200-char clip — this module does not
 * duplicate that logic, it only builds a well-formed request path.
 *
 * Framework-free so the encoding edge cases (blank query, wildcards, UTF-8,
 * oversized paste) are unit-tested without spinning up React Native.
 */

import type { PeerBadge } from './peerProfile';

/** One entry of `GET /api/dm/candidates`. */
export interface DmCandidate {
  userId: string;
  nickname: string;
  profileImage: string | null;
  badges: PeerBadge[];
  sharedTopics: Array<{ id: string; title: string }>;
}

// Mirrors the server's own clip (src/lib/dmCandidates.ts /
// normaliseSearchQuery) so a malformed client build never ships a request
// that depends solely on the server to bound an absurdly long paste.
const MAX_QUERY_LENGTH = 200;

/**
 * Build the request path for the candidates list.
 *
 * A blank or whitespace-only draft omits `q` entirely (never sends
 * `q=` / `q=%20`, which the server would otherwise have to special-case as
 * "no filter" itself). Non-blank text is clipped to `MAX_QUERY_LENGTH`
 * code points — `Array.from` rather than `.slice` so the clip cannot land
 * inside a surrogate pair and split an emoji — then URL-encoded as-is; the
 * server does its own wildcard escaping, so this function must NOT alter
 * `%`, `_` or `\` beyond what `encodeURIComponent` does for transport.
 */
export function buildDmCandidatesPath(rawQuery: string): string {
  const trimmed = rawQuery.trim();
  if (!trimmed) return '/api/dm/candidates';
  const codePoints = Array.from(trimmed);
  const clipped =
    codePoints.length > MAX_QUERY_LENGTH
      ? codePoints.slice(0, MAX_QUERY_LENGTH).join('')
      : trimmed;
  return `/api/dm/candidates?q=${encodeURIComponent(clipped)}`;
}
