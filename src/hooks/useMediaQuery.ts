'use client';

import { useSyncExternalStore } from 'react';

/**
 * The breakpoint at which the right sidebar (and with it the docked chat
 * column) is on screen. Must stay in sync with the `@media (max-width: 1023px)`
 * rules in CommunityLayout that hide `.layout-right-sidebar` and reveal
 * `.mobile-chat-sheet`.
 *
 * Chat panels are gated on this query rather than on CSS alone: `display: none`
 * hides a panel but still MOUNTS it, and two live ChatPanels open two SSE
 * streams and race to MLS-decrypt the same message. MLS deletes each per-message
 * key on first decrypt (forward secrecy), so the losing panel renders
 * '[unable to decrypt]'. Exactly one panel may be mounted at a time.
 */
export const DESKTOP_CHAT_QUERY = '(min-width: 1024px)';

/**
 * Live match state for a CSS media query.
 *
 * `useSyncExternalStore` is used so the server render and the hydration render
 * both read `serverValue` (no hydration mismatch), and the real match is
 * adopted on subscribe.
 */
export function useMediaQuery(query: string, serverValue = true): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onStoreChange);
      return () => mql.removeEventListener('change', onStoreChange);
    },
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}
