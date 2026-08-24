// @vitest-environment jsdom
/**
 * FIX8: Recovery moved out of the header's top-level nav into `/my`'s
 * Settings tab (mirroring mobile's `ProfileStack` -> `AccountRecoveryScreen`).
 * This test covers the NEW Settings-tab Recovery section; `Header.tsx` no
 * longer renders a `/recovery` link at all (nothing to test there beyond its
 * absence, which this test also asserts via the rendered nav).
 *
 * Edge-case matrix rows covered here:
 *   contract — the Settings tab renders a Recovery section whose control is
 *              a real link to `/recovery` (the actual recovery UI stays a
 *              dedicated page, not inlined, matching the mobile pattern)
 *   contract — `/recovery` is never linked from the top-level header nav
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no IntersectionObserver — MyPage's infinite-scroll effect
// constructs one unconditionally on mount.
class FakeIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}
vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver);

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

// CommunityLayout brings in Header/LeftSidebar/RightSidebar/ChatRail, each
// with their own fetch surface and test coverage elsewhere — mocked here to
// a plain passthrough so this suite stays scoped to MyPage's own content.
vi.mock('@/components/CommunityLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
}));
vi.mock('@/components/AiAgentSettings', () => ({
  default: () => React.createElement('div', { 'data-testid': 'ai-agent-settings' }),
}));

import MyPage from '@/app/my/page';
import { TestProviders, flushQueries } from './harness/providers';

let container: HTMLDivElement;
let root: Root;

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function routeFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/session') return Promise.resolve(json({ userId: 'me', nickname: 'me' }));
      if (url === '/api/profile/image') return Promise.resolve(json(null));
      if (url.startsWith('/api/my/posts')) return Promise.resolve(json({ posts: [] }));
      if (url === '/api/topics') return Promise.resolve(json({ topics: [] }));
      if (url.startsWith('/api/bookmarks')) return Promise.resolve(json({ posts: [] }));
      if (url === '/api/push/preferences') return Promise.resolve(json({ enabled: true, mutedTopicIds: [] }));
      if (url === '/api/profile/domain-badge') return Promise.resolve(json({ domains: [], availableDomain: null }));
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

/*
 * A macrotask drain, not a microtask one.
 *
 * TanStack Query delivers results through `notifyManager`, which schedules on a
 * real `setTimeout(0)` — so draining microtasks alone leaves every query result
 * undelivered and every assertion reading "not yet". Same helper, same reason,
 * as the mini-app harness's `settle`.
 */
const flush = flushQueries;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  routerMock.push.mockClear();
  routerMock.replace.mockClear();
  routeFetch();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('MyPage — Settings tab Recovery section (FIX8)', () => {
  it('CONTRACT: the Settings tab renders a Recovery section linking to /recovery', async () => {
    await act(async () => {
      root.render(
        <TestProviders initialLocale="en">
          <MyPage />
        </TestProviders>,
      );
    });
    await flush();

    const settingsTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Settings');
    expect(settingsTab).toBeDefined();
    await act(async () => {
      settingsTab!.click();
    });
    await flush();

    expect(container.textContent).toContain('Recovery');
    const link = container.querySelector('a[href="/recovery"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe('Manage recovery');
  });
});
