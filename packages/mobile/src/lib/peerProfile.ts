/**
 * Peer profile card — pure helpers shared by TopicMembersScreen and
 * ChatRoomScreen (both open the same `PeerProfileCard` on an avatar/name
 * tap). Kept framework-free so the decision logic unit-tests under this
 * package's node-environment vitest config, which does not render RN
 * components (see `vitest.config.ts` — only pure-logic `.test.ts` files
 * under `src/__tests__` run; no screen/component here has render-level tests).
 */

/** Shape shared with the server's `Badge` (src/lib/verification-cache.ts) and
 * `GET /api/dm/candidates` / `GET /api/topics/{topicId}/members` responses. */
export interface PeerBadge {
  type: string;
  label: string;
  domain?: string | null;
}

/** Everything the profile card needs to render. `badges` and `isAI` are
 * optional because not every surface that opens the card knows them —
 * ChatRoomScreen's message rows carry no badge data (no per-message badge
 * endpoint exists), so the card simply omits the badge section there. */
export interface PeerProfileTarget {
  userId: string;
  nickname: string;
  profileImage?: string | null;
  badges?: PeerBadge[];
  isAI?: boolean;
}

/**
 * Whether the DM button should render on a peer's profile card.
 *
 * - Self: never. The entire "message yourself" case is nonsensical and
 *   `POST /api/dm` 400s on a self-DM anyway — hiding the button avoids a
 *   round trip that can only fail.
 * - Missing ids: never. An unauthenticated viewer (`viewerUserId` null,
 *   which should not happen since both call sites gate on auth already, but
 *   never trust the caller) or a target with no userId must not attempt a DM.
 * - AI members: never. DM opens a real 1:1 MLS room the AI does not read;
 *   offering the button would silently create a channel nobody answers.
 */
export function canDm(
  viewerUserId: string | null | undefined,
  target: Pick<PeerProfileTarget, 'userId' | 'isAI'>,
): boolean {
  if (!viewerUserId || !target.userId) return false;
  if (target.isAI) return false;
  return viewerUserId !== target.userId;
}

/**
 * Avatar-fallback initial shown when `profileImage` is absent.
 *
 * Uses `Array.from` (not `.slice`/`.charAt`, which index UTF-16 code units)
 * so a nickname starting with an emoji or any other astral-plane character
 * keeps its full surrogate pair instead of rendering a broken half-glyph.
 * Whitespace-only or empty nicknames fall back to '?' rather than an
 * empty avatar circle.
 */
export function initialFor(nickname: string): string {
  const trimmed = nickname.trim();
  if (!trimmed) return '?';
  const [first] = Array.from(trimmed);
  return (first ?? '?').toUpperCase();
}
