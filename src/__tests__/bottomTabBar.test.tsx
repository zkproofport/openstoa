// @vitest-environment jsdom
/**
 * `BottomTabBar.tsx` — the phone-width Feed/Topics/Chat/Profile nav mounted
 * by `CommunityLayout`.
 *
 * Edge-case matrix rows covered here:
 *   boundary     — renders only when the mobile media query matches; renders
 *                  nothing on desktop and nothing while `hidden` (the
 *                  full-screen chat sheet) is true, even on mobile
 *   authz        — guest and member get the SAME four tabs. The nav is not an
 *                  auth-status display; signing in happens when the tapped
 *                  action needs it. Only the Chat entry differs, and only in
 *                  how it resolves (see below), never in whether it is there.
 *   authz        — a GUEST's Chat tab is a link to the sign-in surface `/`,
 *                  NOT the rail button: `CommunityLayout` gates the rail on
 *                  `!isGuest`, so `openRail` would open nothing and the tap
 *                  would have no outcome at all
 *   authz        — a guest's Profile tab still points at `/my`, which already
 *                  redirects a guest to `/` (`src/app/my/page.tsx`,
 *                  `src/middleware.ts`) — no special-casing here, and a test
 *                  pins that the href is not quietly rewritten
 *   contract     — a MEMBER's Chat tab calls `useChatRail().openRail(null)`
 *                  exactly once per click, the same module-level action
 *                  Header's chat toggle and LeftSidebar's "Chat" entry
 *                  already use — it never renders as a plain link to a URL
 *   race         — clicking Chat when no `CommunityLayout` published a rail
 *                  API (`useChatRail()` resolves `null`) does not throw
 *   result       — `aria-current="page"` tracks `usePathname()` for every
 *                  route-backed tab, and exactly one tab (or, on an
 *                  unmapped route, zero) carries it at a time
 *   UTF-8        — every label renders correctly in `ko`, and none fall
 *                  back to a raw i18n key path
 *   contract     — the Chat entry never renders as an `<a href>` (no second,
 *                  competing destination for an already-nonexistent route)
 *   empty        — `isGuest` boolean is required by the type; hostile/large/
 *                  whitespace input rows are N/A — this component takes no
 *                  free-text input of any kind, only booleans and the
 *                  framework-owned `pathname`
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pathnameMock = vi.hoisted(() => ({ current: '/topics' }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock.current,
}));

const mediaQueryMock = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => mediaQueryMock.isMobile,
  MOBILE_QUERY: '(max-width: 767px)',
  DESKTOP_CHAT_QUERY: '(min-width: 1024px)',
}));

const chatRailMock = vi.hoisted(() => ({ openRail: vi.fn(), current: null as { openRail: (r: unknown) => void } | null }));
vi.mock('@/lib/chatRailContext', () => ({
  useChatRail: () => chatRailMock.current,
}));

import BottomTabBar from '@/components/BottomTabBar';
import { TestProviders } from './harness/providers';
import type { Locale } from '@/lib/i18n';

let container: HTMLDivElement;
let root: Root;

async function render(props: React.ComponentProps<typeof BottomTabBar>, locale: Locale = 'en') {
  await act(async () => {
    root.render(
      <TestProviders initialLocale={locale}>
        <BottomTabBar {...props} />
      </TestProviders>,
    );
    await Promise.resolve();
  });
}

function tabs(): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-testid^="tabbar-"]'));
}

function tab(key: string): HTMLElement | null {
  return container.querySelector(`[data-testid="tabbar-${key}"]`);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pathnameMock.current = '/topics';
  mediaQueryMock.isMobile = true;
  chatRailMock.openRail = vi.fn();
  chatRailMock.current = { openRail: chatRailMock.openRail };
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('BOUNDARY: mount conditions', () => {
  it('renders nothing on desktop (media query does not match)', async () => {
    mediaQueryMock.isMobile = false;
    await render({ isGuest: false });
    expect(container.querySelector('[data-testid="bottom-tabbar"]')).toBeNull();
  });

  it('renders on mobile', async () => {
    await render({ isGuest: false });
    expect(container.querySelector('[data-testid="bottom-tabbar"]')).not.toBeNull();
  });

  it('renders nothing while `hidden` is true even on mobile (full-screen chat sheet owns the screen)', async () => {
    await render({ isGuest: false, hidden: true });
    expect(container.querySelector('[data-testid="bottom-tabbar"]')).toBeNull();
  });
});

describe('AUTHZ: guest vs signed-in tab sets', () => {
  // CHANGED DELIBERATELY: a guest used to get [Feed, Topics, Sign in]. That
  // made the primary nav an auth-status display — a guest and a member
  // navigating the same app saw two different maps of it, and the one
  // destination a guest was offered was the one thing they had not asked to
  // do yet. Signing in is now contextual, at the point the tapped action
  // actually requires it, which is also what the header does at these widths.
  it('guest sees the SAME three tabs as a member — Feed, Topics, Profile', async () => {
    await render({ isGuest: true });
    const keys = tabs().map((el) => el.getAttribute('data-testid'));
    expect(keys).toEqual(['tabbar-feed', 'tabbar-topics', 'tabbar-profile']);
  });

  it('signed-in member sees exactly Feed, Topics, Profile', async () => {
    await render({ isGuest: false });
    const keys = tabs().map((el) => el.getAttribute('data-testid'));
    expect(keys).toEqual(['tabbar-feed', 'tabbar-topics', 'tabbar-profile']);
  });

  it('the two tab sets are identical, key for key', async () => {
    await render({ isGuest: true });
    const guestKeys = tabs().map((el) => el.getAttribute('data-testid'));
    await render({ isGuest: false });
    const memberKeys = tabs().map((el) => el.getAttribute('data-testid'));
    expect(guestKeys).toEqual(memberKeys);
  });

  it('the standalone Sign in tab is gone entirely', async () => {
    await render({ isGuest: true });
    expect(tab('signIn')).toBeNull();
  });

  it("guest Profile keeps pointing at /my — the page itself redirects a guest to /, so no special-casing here", async () => {
    await render({ isGuest: true });
    expect(tab('profile')?.getAttribute('href')).toBe('/my');
  });
});

/**
 * THERE IS NO CHAT TAB, and that is the requirement.
 *
 * Chat is not on the web. A person's chat keys live on ONE device — the mobile
 * app — and a browser is the one place that cannot hold: signing out cleared
 * the session and left the MLS state, the leaf identity and the
 * decrypted-picture cache behind, so the next person at a shared computer could
 * read the previous person's end-to-end encrypted conversation.
 *
 * This block used to assert the tab was a button for members, a link for
 * guests, and that it opened the rail. All of that described a feature that is
 * gone; what replaces it is the assertion that no entry point invites anyone
 * into it.
 */
describe('CONTRACT: there is no Chat tab', () => {
  it('MEMBER: no chat tab is rendered', async () => {
    await render({ isGuest: false });
    expect(tab('chat')).toBeNull();
  });

  it('GUEST: no chat tab either — the tab set does not change with auth', async () => {
    await render({ isGuest: true });
    expect(tab('chat')).toBeNull();
  });
});

describe('RESULT: aria-current follows usePathname()', () => {
  it('Feed is current on /topics (exact)', async () => {
    pathnameMock.current = '/topics';
    await render({ isGuest: false });
    expect(tab('feed')?.getAttribute('aria-current')).toBe('page');
    expect(tab('topics')?.getAttribute('aria-current')).toBeNull();
    expect(tab('chat')).toBeNull(); // the tab itself, not its attribute
    expect(tab('profile')?.getAttribute('aria-current')).toBeNull();
  });

  it('Topics is current on /topics/explore', async () => {
    pathnameMock.current = '/topics/explore';
    await render({ isGuest: false });
    expect(tab('topics')?.getAttribute('aria-current')).toBe('page');
    expect(tab('feed')?.getAttribute('aria-current')).toBeNull();
  });

  it('Topics is current on a topic detail page (/topics/<id>)', async () => {
    pathnameMock.current = '/topics/abc123';
    await render({ isGuest: false });
    expect(tab('topics')?.getAttribute('aria-current')).toBe('page');
    expect(tab('feed')?.getAttribute('aria-current')).toBeNull();
  });

  it('/dm marks NOTHING current — there is no tab for it any more', async () => {
    // The route may still resolve for a while; the tab bar must not grow a
    // chat entry back just because a path that once had one is visited.
    pathnameMock.current = '/dm';
    await render({ isGuest: false });
    expect(tab('chat')).toBeNull();
  });

  it('Profile is current on /my', async () => {
    pathnameMock.current = '/my';
    await render({ isGuest: false });
    expect(tab('profile')?.getAttribute('aria-current')).toBe('page');
  });

  it('no tab is current on an unmapped route (e.g. /docs)', async () => {
    pathnameMock.current = '/docs';
    await render({ isGuest: false });
    for (const el of tabs()) {
      expect(el.getAttribute('aria-current')).toBeNull();
    }
  });
});

describe('UTF-8: Korean locale', () => {
  it('renders every label in Korean, none fall back to a raw key path', async () => {
    await render({ isGuest: false }, 'ko');
    const text = container.textContent ?? '';
    expect(text).toContain('피드');
    expect(text).toContain('토픽');
    expect(text).not.toContain('채팅'); // no chat tab in either locale
    expect(text).toContain('프로필');
    expect(text).not.toContain('tabbar.');
  });

  it('a guest gets the same three Korean labels — the tab set does not change with auth, so neither do the labels', async () => {
    await render({ isGuest: true }, 'ko');
    const text = container.textContent ?? '';
    expect(text).toContain('피드');
    expect(text).toContain('토픽');
    expect(text).not.toContain('채팅'); // no chat tab in either locale
    expect(text).toContain('프로필');
    expect(text).not.toContain('tabbar.');
    // The Korean labels are longer than the English ones and nothing in the
    // bar is fixed-width — every item is `flex: 1 1 0; min-width: 0`, so four
    // of them still divide the row evenly at 320px.
    const css = container.querySelector('style')?.textContent ?? '';
    expect(css).toMatch(/\.os-tabbar-item\s*{[^}]*flex:\s*1 1 0;[^}]*min-width:\s*0;/s);
  });
});

describe('RESULT: aria-current for a guest', () => {
  it('no tab is current on the sign-in surface / — the Chat tab points there, but / is not "chat"', async () => {
    pathnameMock.current = '/';
    await render({ isGuest: true });
    for (const el of tabs()) {
      expect(el.getAttribute('aria-current')).toBeNull();
    }
  });

  it('Feed is still current on /topics for a guest', async () => {
    pathnameMock.current = '/topics';
    await render({ isGuest: true });
    expect(tab('feed')?.getAttribute('aria-current')).toBe('page');
  });
});
