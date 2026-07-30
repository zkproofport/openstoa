'use client';

/**
 * Module-level publish/subscribe store backing `useChatRail()`
 * (`chatRailContext.tsx`) — see that file for why this is a store and not
 * React Context.
 *
 * `CommunityLayout` is the sole owner of rail state and the sole publisher
 * (via `publishChatRailApi` in a `useEffect`, keyed on its own `openRail`
 * identity). Everything else in this module is read-only: any component,
 * anywhere in the tree — an ancestor of `CommunityLayout`, a descendant, or
 * a totally unrelated subtree — can ask "is a rail mounted right now, and if
 * so, how do I open it" without needing to be positioned relative to a
 * Provider.
 *
 * Single global instance is intentional: exactly one `CommunityLayout` (and
 * therefore at most one chat rail) is ever mounted for the whole app at a
 * time (see `CommunityLayout.tsx`'s own doc), so there is never more than
 * one publisher to arbitrate between.
 */
import type { RailRoom } from './chatRail';

export interface ChatRailApi {
  /** Open (or ensure-open) the rail and jump it to `room` — `null` = the
   *  room list. See `CommunityLayout.tsx`'s `openRail` for the full contract. */
  openRail: (room: RailRoom | null) => void;
}

let currentApi: ChatRailApi | null = null;
const listeners = new Set<() => void>();

/** Snapshot for `useSyncExternalStore` / direct reads outside React. */
export function getChatRailApi(): ChatRailApi | null {
  return currentApi;
}

/** Server snapshot — SSR never has a mounted rail. */
export function getServerChatRailApi(): null {
  return null;
}

/**
 * Publish the currently-mounted `CommunityLayout` instance's rail API, or
 * `null` when none is mounted. Every subscriber is notified synchronously.
 */
export function publishChatRailApi(api: ChatRailApi | null): void {
  if (currentApi === api) return;
  currentApi = api;
  listeners.forEach((l) => l());
}

export function subscribeChatRailApi(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget the published API and every subscriber. */
export function __resetChatRailStore(): void {
  currentApi = null;
  listeners.clear();
}
