'use client';
/**
 * The web's TanStack Query client — the same data layer the mini-app has always
 * used, on the same major version and the same keys.
 *
 * WHY IT EXISTS NOW. The web had no query layer, so it grew the things a query
 * layer exists to prevent: seventeen call sites fetching `/api/auth/session`
 * independently, three different caches for that one value, and two components
 * fetching the same topic side by side on every entry. Two bespoke modules were
 * written to paper over that (`sessionCache`, `requestCache`) before anyone
 * checked what the sibling package already standardised on. They are gone; this
 * is what replaces them.
 *
 * ONE CLIENT PER BROWSER, and never one shared across server renders. In the
 * App Router this component runs on the server too, and a module-level client
 * there would be shared between REQUESTS — one visitor's cache answering
 * another's. `useState` gives each browser tab exactly one and each server
 * render its own throwaway.
 *
 * DEFAULTS, and why each is what it is:
 *   - `staleTime: 30_000` — the mini-app's own value. A read is served from
 *     cache for thirty seconds, which is what turns "two components want the
 *     topic" into one request without inventing a second sharing mechanism.
 *   - `retry: 1` — a failed read is usually a lost connection, not a broken
 *     endpoint, and three retries turn a visible error into fifteen seconds of
 *     spinner.
 *   - `refetchOnWindowFocus: false` — this app has a chat SSE stream and a
 *     poll; a focus refetch on top of both is a third source of the same data.
 */
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** Matches `packages/mobile`'s client, so the two behave the same. */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: 0 },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
