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

/** `null` = the DM button SHOULD show. Otherwise, why it doesn't. */
export type DmUnavailableReason = 'self' | 'ai' | null;

/**
 * Decomposes `canDm`'s "no button" outcome into WHICH reason applies, so the
 * profile card can say something honest instead of rendering a blank area
 * where the button would be. Three honest end-states, not one blank box:
 * self, no badges, and not-DM-able are independent facts about a card and
 * can combine (e.g. your own card is `self` + usually also `noBadges`).
 *
 * Both call sites that open this card (`TopicMembersScreen`, a message
 * author tap in `ChatRoomScreen`) only ever do so for someone who already
 * shares the current topic with the viewer — unlike the web picker, there is
 * no "browse anyone site-wide" surface on mobile — so the only structural
 * reasons left (once both ids are actually known) are `self` and an AI
 * member (an AI teammate is never one you message; see `canDm`).
 *
 * An unresolved viewer or target (`!viewerUserId || !target.userId`)
 * deliberately returns `null` — a still-loading identity is not a real
 * answer to "why can't I message them" and would render a wrong/premature
 * note. `canDm` also answers `false` for that case, so no button AND no
 * note both show, same as the button-omitted case it decomposes.
 */
export function dmUnavailableReason(
  viewerUserId: string | null | undefined,
  target: Pick<PeerProfileTarget, 'userId' | 'isAI'>,
): DmUnavailableReason {
  if (!viewerUserId || !target.userId) return null;
  if (viewerUserId === target.userId) return 'self';
  if (target.isAI) return 'ai';
  return null;
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
