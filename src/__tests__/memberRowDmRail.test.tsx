// @vitest-environment jsdom
/**
 * Regression test for the bug fixed by `chatRailStore.ts` / `chatRailContext.tsx`:
 * `useChatRail()` called directly in a PAGE's own component body (as opposed
 * to inside the JSX the page hands to `CommunityLayout` as `children`)
 * always resolved to `null`, because `CommunityLayout`'s old Context
 * Provider was a DESCENDANT of the page in the fiber tree, never an
 * ancestor. `/topics/{topicId}/members/page.tsx` is exactly this shape: it
 * calls `useChatRail()` at its own top level, then renders `<CommunityLayout>`
 * itself. The member row's "DM" button silently fell back to a full-page
 * `router.push('/dm/{id}')` navigation instead of landing in the rail.
 *
 * This test mounts the REAL `MembersPage` + REAL `CommunityLayout` (only
 * `Header`/`LeftSidebar`/`RightSidebar`/`ChatRail`/`useMediaQuery` are
 * stubbed — they are unrelated surfaces with their own test coverage) and
 * asserts the DM action now opens the rail instead of navigating, mounting
 * the rail exactly once.
 *
 * Edge-case matrix rows covered here:
 *   contract     — clicking a member row's DM button opens the rail (does
 *                  NOT call router.push) once the rail becomes reachable
 *   mount-unique — the rail mounts exactly once for the whole flow
 *   fallback     — a page that renders NO CommunityLayout still falls back
 *                  to router.push (useChatRail() genuinely has nothing to
 *                  resolve there) — pinned separately by userCard.test.tsx's
 *                  non-`mountWithRail` cases, not duplicated here
 */
import { CHAT_ON_WEB } from '@/lib/chatOnWeb';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const paramsMock = vi.hoisted(() => ({ topicId: 't1' }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/topics/t1/members',
  useRouter: () => routerMock,
  useParams: () => paramsMock,
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => true,
  DESKTOP_CHAT_QUERY: '(min-width: 1024px)',
  // BottomTabBar (mounted unconditionally by CommunityLayout) imports this
  // named export; a mock factory that omits it throws on import, not just
  // on use, because vitest validates against the real module's exports.
  MOBILE_QUERY: '(max-width: 767px)',
}));

vi.mock('@/components/Header', () => ({
  default: () => React.createElement('div', { 'data-testid': 'header' }),
}));
vi.mock('@/components/LeftSidebar', () => ({
  default: () => React.createElement('div', { 'data-testid': 'left-sidebar' }),
}));
vi.mock('@/components/RightSidebar', () => ({
  default: () => React.createElement('div', { 'data-testid': 'right-sidebar' }),
}));

const railMountCount = vi.hoisted(() => ({ current: 0 }));
vi.mock('@/components/ChatRail', () => ({
  default: () => {
    railMountCount.current += 1;
    return React.createElement('div', { 'data-testid': 'chat-rail' });
  },
}));

// Spies on the REAL `invalidateDmCandidates` (still calls through) so FIX9's
// "starting a DM invalidates the cache" contract is directly assertable here
// too — this page has its own call site, separate from ChatRail's/UserCard's.
vi.mock('@/lib/dmCandidatesCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dmCandidatesCache')>();
  return { ...actual, invalidateDmCandidates: vi.fn(actual.invalidateDmCandidates) };
});

import MembersPage from '@/app/topics/[topicId]/members/page';
import { TestProviders, flushQueries } from './harness/providers';
import { __resetChatRailStore } from '@/lib/chatRailStore';
import { invalidateDmCandidates } from '@/lib/dmCandidatesCache';

let container: HTMLDivElement;
let root: Root;

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function routeFetch() {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/session') return Promise.resolve(json({ userId: 'me' }));
    if (url === '/api/topics/t1') return Promise.resolve(json({ topic: { id: 't1', title: 'Zoning Law' } }));
    if (url === '/api/topics/t1/members') {
      return Promise.resolve(
        json({
          members: [
            { userId: 'me', nickname: 'me', role: 'owner' },
            { userId: 'u1', nickname: 'bob', role: 'member' },
          ],
          currentUserRole: 'owner',
        }),
      );
    }
    if (url === '/api/dm' && init?.method === 'POST') {
      return Promise.resolve(json({ topicId: 'dm-topic-1' }, true, 201));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
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
  railMountCount.current = 0;
  routerMock.push.mockClear();
  routerMock.replace.mockClear();
  __resetChatRailStore();
  vi.mocked(invalidateDmCandidates).mockClear();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  __resetChatRailStore();
});

/*
 * SUSPENDED WITH CHAT, NOT DELETED.
 *
 * Every assertion below describes a chat surface the web no longer serves:
 * `CHAT_ON_WEB` is `false` (see `src/lib/chatOnWeb.ts` for why the room list,
 * the rail and these pages are gated), so the pages render `ChatNotOnWeb`
 * instead of a room and these cases would be asserting against a notice.
 *
 * Gated on the constant rather than commented out, so that the day chat comes
 * back to the web these run again as written — a commented-out suite is a
 * suite nobody notices is missing. `chatStaysOffForAnOldBrowser.test.tsx` is
 * the case that stays live meanwhile, and it fails if the flag is flipped.
 */
const CHAT_SUITES_RUN = CHAT_ON_WEB;

describe.skipIf(!CHAT_SUITES_RUN)('member-row DM opens the rail (FIX1 + FIX4 regression)', () => {
  it('CONTRACT + MOUNT-UNIQUE: clicking a member row DM button opens the rail exactly once and does not navigate', async () => {
    routeFetch();

    await act(async () => {
      root.render(
        <TestProviders initialLocale="en">
          <MembersPage />
        </TestProviders>,
      );
    });
    await flush();

    // Rail not open yet — the page just loaded, the member never opened chat.
    expect(container.querySelectorAll('[data-testid="chat-rail"]')).toHaveLength(0);

    const dmButtons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === 'DM');
    expect(dmButtons).toHaveLength(1); // only the OTHER member (bob), never "me"

    await act(async () => {
      dmButtons[0].click();
    });
    await flush();

    // The rail opened — this is the regression: before FIX1, useChatRail()
    // in MembersPage's own body always resolved to null and this branch
    // fell back to router.push('/dm/dm-topic-1') instead.
    expect(container.querySelectorAll('[data-testid="chat-rail"]')).toHaveLength(1);
    expect(railMountCount.current).toBe(1);
    expect(routerMock.push).not.toHaveBeenCalledWith('/dm/dm-topic-1');
    // FIX9: starting a DM invalidates the candidates cache immediately.
    expect(invalidateDmCandidates).toHaveBeenCalledTimes(1);
  });
});
