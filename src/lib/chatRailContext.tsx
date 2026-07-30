'use client';

/**
 * Access to the single app-wide chat rail (`ChatRail.tsx`, owned by
 * `CommunityLayout.tsx`) from anywhere in the app — a member row's DM
 * action, `UserCard`'s "DM" button — without threading `openRail` as a prop
 * through every intermediate component.
 *
 * Backed by a module-level store (`chatRailStore.ts`), NOT React Context.
 * Every page in this app constructs its OWN `<CommunityLayout>` instance
 * inside its own page component (`return <CommunityLayout>...</CommunityLayout>`)
 * rather than consuming a shared Next.js `layout.tsx` — so `CommunityLayout`'s
 * internals are always a DESCENDANT of the page that renders it, never an
 * ancestor. A page component's own hook calls run as part of the page's own
 * render, before `CommunityLayout`'s subtree even exists, so a Context
 * Provider created inside `CommunityLayout` can never be seen by a `useChatRail()`
 * call made directly in the page body (as opposed to inside the JSX the page
 * passes down as `children`, which — because `CommunityLayout` places
 * `{children}` inside its own returned tree — DOES end up as a genuine
 * descendant in the fiber tree; that is why `UserCard` rendered inside a
 * page's `children` worked fine while the page's OWN `useChatRail()` call,
 * e.g. in `/topics/{id}/members`, always silently resolved to `null`).
 *
 * A module-level store has no such positional requirement: any component,
 * anywhere in the tree, sees the one `CommunityLayout` instance currently
 * mounted, regardless of whether it is that instance's ancestor or descendant.
 *
 * `CommunityLayout` remains the single owner of rail open/closed state and
 * the only publisher (see its `publishChatRailApi` effect) — this hook is a
 * read-only subscription and does not reimplement any of that.
 */
import { useSyncExternalStore } from 'react';
import { getChatRailApi, getServerChatRailApi, subscribeChatRailApi, type ChatRailApi } from './chatRailStore';

export type { ChatRailApi };

/**
 * Returns `null` whenever no `CommunityLayout` instance is currently
 * mounted — the standalone `/chat`, `/dm` bare-shell pages (which
 * intentionally never render one, see `BareChatShell.tsx`), or a test that
 * never published a rail API. Every caller MUST have a sensible fallback for
 * the `null` case rather than assuming the rail is always reachable.
 */
export function useChatRail(): ChatRailApi | null {
  return useSyncExternalStore(subscribeChatRailApi, getChatRailApi, getServerChatRailApi);
}
