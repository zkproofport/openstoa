/**
 * Mount a whole SCREEN, with the providers the app gives it (T-1).
 *
 * `render()` next door mounts a component. A screen needs more: a query client,
 * an i18n instance, navigation, the host bridge, and the two sign-in providers —
 * and every one of those is a thing a test would otherwise re-derive, slightly
 * differently, until two screen tests disagree about what "mounted" means.
 *
 * The providers here are REAL (`@tanstack/react-query`, `react-i18next`,
 * `@react-navigation/native`), for the reason in `vitest.config.ts`: a screen
 * mounted against fakes tests the fakes. What is doubled is only what a test
 * must be able to STEER — the host bridge and the navigation object — because a
 * test's questions are "what did the screen ask the host to store" and "where
 * did it navigate", which need a spy rather than an implementation.
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NavigationContext, NavigationRouteContext } from '@react-navigation/native';
import { HostProvider } from '@openstoa/miniapp-bridge';
import { SignInSheetProvider } from '../../components/SignInSheet';
import { SignInLauncherProvider } from '../../auth/SignInLauncher';
import { render, type Rendered } from './render';

/** A KV store that keeps what it was given, so a test can read it back. */
export interface FakeStore {
  items: Map<string, string>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function fakeStore(seed: Record<string, string> = {}): FakeStore {
  const items = new Map(Object.entries(seed));
  return {
    items,
    async getItem(key) {
      return items.get(key) ?? null;
    },
    async setItem(key, value) {
      items.set(key, value);
    },
  };
}

export interface HostDouble {
  localStore: FakeStore;
  secureStore: FakeStore;
  /** Every error the screen surfaced through the host, in order. */
  errors: string[];
  api: Record<string, unknown>;
}

/**
 * A host bridge with every REQUIRED member of `HostApi` and nothing more.
 *
 * Built from the interface rather than from whatever a screen happened to call,
 * on purpose: a new required host method should break these tests loudly, which
 * is the signal that every screen now depends on something the host must
 * provide. The optional members are omitted for the same reason — a screen that
 * silently depends on one should have to say so.
 */
export function hostDouble(over: Record<string, unknown> = {}): HostDouble {
  const localStore = fakeStore();
  const secureStore = fakeStore();
  const errors: string[] = [];
  const api = {
    getEnvironment: () => ({
      isEmbedded: true,
      hostName: 'standalone',
      openstoaBaseUrl: 'https://openstoa.test',
    }),
    getOpenStoaToken: async () => 'test-token',
    setOpenStoaToken: async () => {},
    loginToOpenStoa: async () => ({ token: 'test-token', userId: 'me', needsNickname: false }),
    logoutFromOpenStoa: async () => {},
    generateProof: async () => ({ proof: '0x', publicInputs: [] as string[] }),
    exitToHost: () => {},
    showError: (code: string) => {
      errors.push(code);
    },
    getLanguage: () => 'en' as const,
    onLanguageChange: () => () => {},
    getTheme: () => 'light' as const,
    onThemeChange: () => () => {},
    getDeveloperMode: () => false,
    onDeveloperModeChange: () => () => {},
    localStore,
    secureStore,
    ...over,
  };
  return { localStore, secureStore, errors, api };
}

export interface NavDouble {
  navigate: ReturnType<typeof spy>;
  goBack: ReturnType<typeof spy>;
  setOptions: ReturnType<typeof spy>;
  addListener: () => () => void;
  isFocused: () => boolean;
}

/** A recording function — the harness stays free of a mocking library. */
function spy() {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args);
  };
  fn.calls = calls;
  return fn as ((...args: unknown[]) => void) & { calls: unknown[][] };
}

export function navDouble(): NavDouble {
  return {
    navigate: spy(),
    goBack: spy(),
    setOptions: spy(),
    addListener: () => () => {},
    isFocused: () => true,
  };
}

export interface ScreenHarness {
  rendered: Rendered;
  host: HostDouble;
  nav: NavDouble;
  /**
   * The client the screen rendered against.
   *
   * Returned so a test can assert what the screen READ from the cache and what
   * it wrote back — the difference between "the room fetched the topic" and
   * "the room reused the one the topic screen already had", which is invisible
   * from the outside.
   */
  queryClient: QueryClient;
}

export interface RenderScreenOptions {
  /** Route params the screen reads (`topicId`, `topicTitle`, `kind`). */
  params?: Record<string, unknown>;
  host?: HostDouble;
  nav?: NavDouble;
  /** Seed the cache before the screen mounts, to model arriving from another tab. */
  queryClient?: QueryClient;
}

/**
 * Render `element` inside the app's provider stack.
 *
 * Query retries are OFF: a retrying client turns one failed fetch into several
 * seconds of waiting and a test that fails by timeout rather than by assertion.
 */
export async function renderScreen(
  element: React.ReactElement,
  options: RenderScreenOptions = {},
): Promise<ScreenHarness> {
  const host = options.host ?? hostDouble();
  const nav = options.nav ?? navDouble();
  const route = {
    key: 'test-route',
    name: 'ChatRoom',
    params: { topicId: '11111111-2222-4333-8444-555555555555', kind: 'topic', ...options.params },
  };
  const client =
    options.queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });

  const rendered = await render(
    <HostProvider api={host.api as never}>
      <QueryClientProvider client={client}>
        <SignInLauncherProvider value={() => {}}>
          <SignInSheetProvider>
            <NavigationContext.Provider value={nav as never}>
              <NavigationRouteContext.Provider value={route as never}>
                {element}
              </NavigationRouteContext.Provider>
            </NavigationContext.Provider>
          </SignInSheetProvider>
        </SignInLauncherProvider>
      </QueryClientProvider>
    </HostProvider>,
  );

  return { rendered, host, nav, queryClient: client };
}

/** Where the screen keeps failed attachments for one topic. */
export function failedMediaKey(topicId: string): string {
  return `openstoa.failedMedia.${topicId}`;
}
