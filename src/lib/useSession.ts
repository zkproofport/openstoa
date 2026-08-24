'use client';
/**
 * The signed-in account, read once per page by everything that needs it.
 *
 * WHAT THIS REPLACES. Seventeen call sites fetched `/api/auth/session`
 * themselves, and three of them cached it three different ways: `Header` in
 * `localStorage`, `UserCard` behind its own sixty-second TTL, and a short-lived
 * bespoke module that this now supersedes. The endpoint takes ~270ms on
 * staging, and `ChatPanel` will not draw a row until it answers — a bubble
 * whose side is unknown opens under someone else's name and then moves — so a
 * restored room sat blank waiting for a value the tab already had.
 *
 * The de-duplication is TanStack Query's, on the key the mini-app also uses
 * (`sessionKeys.current()` in `@openstoa/api-types`). Nothing here re-implements
 * it.
 *
 * WHY `localStorage` IS STILL INVOLVED. Query's cache is in memory, so a reload
 * starts cold and the first paint would be gated on the network again. The last
 * known answer seeds it; the query still runs and overwrites. The value is not
 * secret — the server hands it to this session on request, and the reader's own
 * name is already on screen — and it is cleared on sign-out.
 *
 * SEEDED AFTER MOUNT, NEVER DURING THE FIRST RENDER, and this is not a detail.
 * `Header` carries the scar: reading the stored session in a `useState`
 * initialiser made the server render the guest pill while the client's first
 * paint rendered the signed-in chip, so the two HTML trees diverged and React
 * #418 tore down and retried hydration in a postMessage loop. `initialData`
 * would do exactly the same thing. An effect runs after hydration has already
 * agreed, and costs one frame rather than a round trip.
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sessionKeys } from '@/lib/queryKeys';
import { apiFetch } from '@/lib/apiFetch';

export interface Session {
  userId?: string;
  nickname?: string;
  profileImage?: string | null;
  role?: string;
  totalRecorded?: number;
}

/** The key `Header` has always used; kept so a signed-in tab is not logged out by this change. */
export const SESSION_STORAGE_KEY = 'os-session';

/** The last answer this browser was given, or null. Synchronous by necessity. */
export function readStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredSession(session: Session | null): void {
  try {
    if (session) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* private mode: the round trip is the fallback */
  }
}

export async function fetchSession(): Promise<Session | null> {
  const r = await apiFetch('/api/auth/session');
  const data = r.ok ? ((await r.json()) as Session | null) : null;
  const session = data?.userId ? data : null;
  writeStoredSession(session);
  return session;
}

/**
 * `{ session, isPending }` — and `isPending` is false the moment a stored
 * answer exists, which is what lets a room paint on its first frame.
 */
export function useSession() {
  const queryClient = useQueryClient();

  /*
   * Seed from storage once hydration has settled — see the note above on why
   * this cannot be `initialData`. `setQueryData` only fills a MISS: if the
   * query has already answered, the server's word stands.
   */
  useEffect(() => {
    if (queryClient.getQueryData(sessionKeys.current()) !== undefined) return;
    const stored = readStoredSession();
    if (stored?.userId) queryClient.setQueryData(sessionKeys.current(), stored);
  }, [queryClient]);

  const { data, isPending, isFetched } = useQuery({
    queryKey: sessionKeys.current(),
    queryFn: fetchSession,
  });

  return {
    session: data ?? null,
    /**
     * Whether the answer is still unknown.
     *
     * A seeded value counts as known: it is what the reader was told last, the
     * query is verifying it, and holding the UI back for that verification is
     * the 270ms of blank screen this hook exists to remove.
     */
    isPending: isPending && data === undefined,
    /** True once the SERVER has answered, for callers that must not act on a hint. */
    isVerified: isFetched,
  };
}

/**
 * Forget the session everywhere.
 *
 * Both halves matter: the query cache is what the page is reading, and the
 * stored copy is what the NEXT page load would seed from.
 */
export function useClearSession() {
  const queryClient = useQueryClient();
  return () => {
    writeStoredSession(null);
    queryClient.setQueryData(sessionKeys.current(), null);
    queryClient.removeQueries({ queryKey: sessionKeys.current() });
  };
}
