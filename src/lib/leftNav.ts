/**
 * `LeftSidebar.tsx` support module — pure, dependency-free logic kept out of
 * the component so it is unit-testable without mounting React, same pattern
 * as `chatWidth.ts` / `chatRail.ts`.
 *
 * Two concerns:
 *   - collapsible-group open/closed persistence (`localStorage`, survives
 *     remounts across client-side navigation — `LeftSidebar` itself remounts
 *     on every page change, see `CommunityLayout.tsx`)
 *   - the two right-aligned figure treatments a nav row can carry: a plain
 *     count (`.n` in the design prototype — shown even at 0, distinct from
 *     "no count at all") and an unread badge (shown only when > 0, capped at
 *     "99+")
 */

export type LeftNavGroupId = 'browse' | 'conversations' | 'categories';

const GROUP_IDS: readonly LeftNavGroupId[] = ['browse', 'conversations', 'categories'];

export type LeftNavGroupState = Record<LeftNavGroupId, boolean>;

/** All groups start open — matches the pre-existing always-expanded layout,
 *  so a first-time visitor (or a wiped/unavailable localStorage) sees
 *  exactly what they saw before groups existed. */
export const DEFAULT_LEFT_NAV_GROUP_STATE: LeftNavGroupState = {
  browse: true,
  conversations: true,
  categories: true,
};

export const LEFT_NAV_GROUPS_KEY = 'openstoa:leftnav-groups';

/**
 * Read the persisted per-group open/closed state. A missing key, corrupted
 * JSON, a non-object payload, or storage being unavailable (private
 * browsing) all fall back to the all-open default rather than throwing.
 * Unknown keys in the stored object are ignored; missing known keys fall
 * back to their default (open) individually, so a payload that only ever
 * recorded one group's toggle does not blank out the other two.
 */
export function readLeftNavGroupState(): LeftNavGroupState {
  try {
    const raw = window.localStorage.getItem(LEFT_NAV_GROUPS_KEY);
    if (!raw) return { ...DEFAULT_LEFT_NAV_GROUP_STATE };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_LEFT_NAV_GROUP_STATE };
    const out = { ...DEFAULT_LEFT_NAV_GROUP_STATE };
    for (const id of GROUP_IDS) {
      const v = (parsed as Record<string, unknown>)[id];
      if (typeof v === 'boolean') out[id] = v;
    }
    return out;
  } catch {
    return { ...DEFAULT_LEFT_NAV_GROUP_STATE };
  }
}

/** Persist the full group state. Best-effort — a write failure just means
 *  the next load falls back to all-open again. */
export function writeLeftNavGroupState(state: LeftNavGroupState): void {
  try {
    window.localStorage.setItem(LEFT_NAV_GROUPS_KEY, JSON.stringify(state));
  } catch {
    // storage unavailable — the preference simply does not persist
  }
}

/**
 * The right-aligned monospace figure next to a nav row (e.g. "Explore
 * topics — 124"). `undefined` means the caller has no data for this row
 * (renders nothing); `0` is a real, distinct value (renders "0") — a fresh
 * community with zero topics is not the same signal as "count unknown".
 * Negative/NaN inputs (should not occur from a real count, but a defensive
 * floor all the same) render as "0" rather than a nonsensical negative figure.
 */
export function formatNavCount(n: number | undefined): string | null {
  if (n === undefined || Number.isNaN(n)) return null;
  return String(Math.max(0, Math.trunc(n)));
}

/**
 * The solid-brand unread badge. Unlike `formatNavCount`, 0 (and anything
 * `undefined`/invalid) renders as NO badge — an unread count of zero means
 * "nothing to flag", which is a different signal from "this row has no
 * count feature at all" handled by the caller simply never rendering the
 * badge slot. Caps the display at "99+" past 99 so the badge never grows
 * wide enough to threaten the row's touch target.
 */
export function formatNavBadgeCount(n: number | undefined): string | null {
  if (n === undefined || Number.isNaN(n) || n <= 0) return null;
  const clamped = Math.trunc(n);
  return clamped > 99 ? '99+' : String(clamped);
}
