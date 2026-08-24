/**
 * The app's provider stack, for tests — the web counterpart of
 * `packages/mobile/src/__tests__/harness/screen.tsx`.
 *
 * Every render test used to wrap its subject in `<I18nProvider>` and nothing
 * else, which was the whole stack at the time. It is not any more: the web now
 * reads through TanStack Query, on the keys the mini-app already uses, and a
 * component that calls a query hook without a provider throws "No QueryClient
 * set" rather than rendering. Wrapping is not a test detail — it is what the
 * real tree does.
 *
 * A FRESH CLIENT PER RENDER, unless one is passed. Query's cache is per-client,
 * so a shared one would let a suite's answer leak into the next test — the same
 * class of bug that made twenty-nine tests render "Sign in to participate" when
 * a page-lifetime cache spanned files. Retries are off so a failed fetch fails
 * the assertion rather than the timeout, and `gcTime` is left alone so a test
 * can inspect what a component wrote.
 */
import React, { useState, act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/lib/i18n/I18nProvider';

export function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export function TestProviders({
  children,
  initialLocale = 'en',
  queryClient,
}: {
  children: ReactNode;
  initialLocale?: 'en' | 'ko';
  /** Pass one to seed the cache, or to assert on what the subject wrote. */
  queryClient?: QueryClient;
}) {
  const [client] = useState(() => queryClient ?? makeTestQueryClient());
  return (
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={initialLocale}>{children}</I18nProvider>
    </QueryClientProvider>
  );
}

/**
 * Let React AND the query layer settle.
 *
 * `await Promise.resolve()` is not enough any more. TanStack Query hands its
 * results back through `notifyManager`, which schedules on a real
 * `setTimeout(0)` — so a microtask-only drain leaves every query result
 * undelivered and every assertion reading "not yet". The mini-app harness
 * learned this first and says the same thing in its own `settle`.
 */
export async function flushQueries(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
