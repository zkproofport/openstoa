'use client';

/**
 * Access to the single app-wide chat rail (`ChatRail.tsx`, owned by
 * `CommunityLayout.tsx`) from anywhere inside it — a member row's DM action,
 * `UserCard`'s "DM" button — without threading `openRail` as a prop through
 * every intermediate component between `CommunityLayout` and the button that
 * needs it.
 *
 * `CommunityLayout` is the one place that constructs a real `ChatRailApi`
 * (see the `<ChatRailContext.Provider>` in `CommunityLayout.tsx`) and passes
 * its own `openRail`, which already owns the idempotent-open / nonce-based
 * re-trigger contract documented there — this module does not reimplement
 * any of that, it only makes the one existing mechanism reachable.
 */
import { createContext, useContext } from 'react';
import type { RailRoom } from './chatRail';

export interface ChatRailApi {
  /** Open (or ensure-open) the rail and jump it to `room` — `null` = the
   *  room list. See `CommunityLayout.tsx`'s `openRail` for the full contract. */
  openRail: (room: RailRoom | null) => void;
}

export const ChatRailContext = createContext<ChatRailApi | null>(null);

/**
 * Returns `null` outside `CommunityLayout` — the standalone `/chat`,
 * `/dm` bare-shell pages (which intentionally never render a rail, see
 * `BareChatShell.tsx`), or a test that mounts a component without a
 * provider. Every caller MUST have a sensible fallback for the `null` case
 * rather than assuming the rail is always reachable.
 */
export function useChatRail(): ChatRailApi | null {
  return useContext(ChatRailContext);
}
