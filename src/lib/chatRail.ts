/**
 * Right-edge chat rail (web) — pure helpers shared by `ChatRail.tsx` and
 * `CommunityLayout.tsx`. Kept dependency-free (no React, no DOM APIs beyond
 * `window.localStorage`) so every rule here is unit-testable without mounting
 * a component.
 *
 * Replaces the old `openstoa:chat-mode` preference (docked/sidebar/modal).
 * The new model has exactly two axes:
 *   - open/closed (persisted — this file)
 *   - list view vs. a specific room (never persisted — always starts at the
 *     list on a fresh mount, same as the rest of this app's per-page state)
 */

/** Whether the rail is open. Absent = closed (first run / private mode). */
export const CHAT_RAIL_OPEN_KEY = 'openstoa:chat-rail-open';

export type RailKind = 'topic' | 'dm';

/** The room currently shown in the rail's room view. `null` = list view. */
export interface RailRoom {
  kind: RailKind;
  /** The chat's topicId — a DM is a hidden 2-member topic, so this is always
   *  a topic id regardless of `kind` (see `src/lib/dm.ts`). */
  topicId: string;
  title: string;
  profileImage?: string | null;
}

/**
 * Read the persisted open/closed preference. Missing key, a corrupted value,
 * or storage being unavailable (private browsing, disabled storage) all fall
 * back to closed — the required default — rather than throwing.
 */
export function readRailOpenPreference(): boolean {
  try {
    return window.localStorage.getItem(CHAT_RAIL_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist the open/closed choice. Best-effort — a write failure just means
 *  the next load falls back to closed again. */
export function writeRailOpenPreference(open: boolean): void {
  try {
    if (open) {
      window.localStorage.setItem(CHAT_RAIL_OPEN_KEY, '1');
    } else {
      window.localStorage.removeItem(CHAT_RAIL_OPEN_KEY);
    }
  } catch {
    // storage unavailable — the preference simply does not persist
  }
}

/**
 * The standalone full-page route for a room — the "open in new tab" target.
 * Topic chat and DM chat are the same underlying primitive (a topic id) but
 * live under different routes so each can carry its own peer/topic chrome.
 */
export function newTabHref(room: RailRoom): string {
  return room.kind === 'dm' ? `/dm/${room.topicId}` : `/chat/${room.topicId}`;
}

/**
 * True when `pathname` IS the standalone full page for `room`. The rail must
 * never mount a second `ChatPanel` for a room whose full page is already
 * live on screen — MLS consumes each message key on first decrypt, so two
 * live panels on the same topic permanently break decryption for one of them
 * (see `src/components/ChatPanel.tsx` and `mls-session-single-consumer.test.ts`).
 */
export function isSameRoomAsPath(pathname: string, room: RailRoom | null): boolean {
  if (!room) return false;
  return pathname === newTabHref(room);
}
