// @vitest-environment jsdom
/**
 * `/chat/[topicId]` — the standalone full-page topic chat, the "open in new
 * tab" target for a topic room selected in `ChatRail.tsx`. Mirrors the
 * conventions in `dmPages.test.tsx` for the sibling `/dm/[topicId]` page.
 *
 * Edge-case matrix rows covered here:
 *   authz        — 401 redirects; 403 (temp `anon_` nickname) points at the
 *                  profile; a non-member still opens the page (ChatPanel
 *                  itself renders the "join to view" state — no page-level
 *                  gate duplicates that logic)
 *   contract     — the page is BARE: it never renders `CommunityLayout` (so
 *                  it never renders `ChatRail` either — nothing on this page
 *                  can double-mount a second `ChatPanel` for the same topic,
 *                  the very regression this whole redesign must not
 *                  reintroduce); no site chrome (Header/sidebars) is mounted;
 *                  no back-arrow (P-2 — BareChatShell's own Close replaces
 *                  it) but the per-topic mute toggle is still present;
 *                  ChatPanel is mounted with hideHeader + framed + fullHeight
 *   empty        — a topic with memberCount 0/undefined still renders
 *   UTF-8        — Korean + emoji topic titles render in the header
 *   hostile      — a script-shaped title renders as text, never as an element
 *   ext-failure  — a 500 / thrown fetch shows an error with a way back
 *
 * Also covers FIX3: the header's "· N members" count is now a real toggle
 * (not dead text) that overlays the shared `TopicMembersList.tsx` treatment
 * above `ChatPanel` — boundary 1/2/many members and a failed fetch.
 */
import { CHAT_ON_WEB } from '@/lib/chatOnWeb';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `vi.hoisted` callbacks are physically hoisted above every other top-level
// statement in this module (including a plain `const`), so the topicId
// literal is inlined here rather than referencing a later `TOPIC` const.
const TOPIC = '11111111-2222-4333-8444-555555555555';

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const paramsMock = vi.hoisted(() => ({
  current: { topicId: '11111111-2222-4333-8444-555555555555' } as Record<string, string>,
}));
const panelProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useParams: () => paramsMock.current,
}));

// This page is intentionally BARE (see `BareChatShell.tsx`) — no
// `CommunityLayout` / `Header` mock here on purpose; the CONTRACT block below
// asserts their absence directly (no `[data-testid="layout"]`, no header nav
// markers) rather than relying on an unmocked import to fail loudly.

vi.mock('@/components/ChatPanel', () => ({
  default: (props: Record<string, unknown>) => {
    panelProps.current = props;
    return React.createElement('div', { 'data-testid': 'chat-panel' });
  },
}));

vi.mock('@/components/TopicMuteToggle', () => ({
  default: () => React.createElement('div', { 'data-testid': 'mute-toggle' }),
}));

import TopicChatPage from '@/app/chat/[topicId]/page';
import { TestProviders } from './harness/providers';

let container: HTMLDivElement;
let root: Root;

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function routeFetch(routes: Array<[string, (init?: RequestInit) => Response]>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      for (const [prefix, handler] of routes) {
        if (url.startsWith(prefix)) return Promise.resolve(handler(init));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

// `BareChatShell` (rendered for real by this bare page) now reads copy
// through `useTranslation()` — see src/lib/i18n/I18nProvider.tsx. Every
// render needs the provider in the tree, same as the app root
// (src/app/layout.tsx).
async function render() {
  await act(async () => {
    root.render(
      <TestProviders initialLocale="en">
        <TopicChatPage />
      </TestProviders>,
    );
  });
  await act(async () => { await Promise.resolve(); });
}

function text(): string {
  return container.textContent ?? '';
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  routerMock.push.mockClear();
  routerMock.replace.mockClear();
  paramsMock.current = { topicId: TOPIC };
  panelProps.current = null;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

function topic(over: Partial<Record<string, unknown>> = {}) {
  return { topic: { id: TOPIC, title: 'Zoning Law', description: 'chat', memberCount: 4, isMember: true, ...over } };
}

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

describe.skipIf(!CHAT_SUITES_RUN)('AUTHZ', () => {
  it('401 redirects to the login page and mounts nothing', async () => {
    routeFetch([[`/api/topics/${TOPIC}`, () => json({ error: 'Not authenticated' }, false, 401)]]);
    await render();

    expect(routerMock.replace).toHaveBeenCalledWith('/');
    expect(panelProps.current).toBeNull();
  });

  it('403 (temp anon_ nickname) points at the profile, not a dead error', async () => {
    routeFetch([[`/api/topics/${TOPIC}`, () => json({ error: 'Nickname required' }, false, 403)]]);
    await render();

    expect(text()).toContain('Set a nickname');
    const link = container.querySelector('a[href^="/profile"]');
    expect(link).not.toBeNull();
    expect(panelProps.current).toBeNull();
  });

  it('a non-member still opens the page — ChatPanel (not this page) renders the join-to-view state', async () => {
    routeFetch([[`/api/topics/${TOPIC}`, () => json(topic({ isMember: false }))]]);
    await render();

    expect(panelProps.current).toMatchObject({ topicId: TOPIC, isMember: false });
  });
});

describe.skipIf(!CHAT_SUITES_RUN)('CONTRACT', () => {
  it('renders bare: no site chrome (Header nav / left or right sidebar) is mounted', async () => {
    routeFetch([[`/api/topics/${TOPIC}`, () => json(topic())]]);
    await render();

    // No CommunityLayout wrapper marker and no LeftSidebar-only affordances
    // (a real Header renders a search input; a real LeftSidebar renders a
    // "Search topics..." placeholder) ever leak onto this page.
    expect(container.querySelector('[data-testid="layout"]')).toBeNull();
    expect(container.querySelector('input[placeholder="Search topics..."]')).toBeNull();
  });

  it('no back-arrow — a Close affordance (from BareChatShell) and the per-topic mute control instead', async () => {
    // P-2: a popped-out tab has no meaningful "back". The old back-arrow Link
    // is gone; `BareChatShell` provides the one exit affordance (Close) plus
    // the width control, both above this page's own identity row.
    routeFetch([[`/api/topics/${TOPIC}`, () => json(topic())]]);
    await render();

    expect(container.querySelector('a[aria-label="Back to topic"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Close"]')).not.toBeNull();
    expect(container.querySelector('[role="group"][aria-label="Chat width"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mute-toggle"]')).not.toBeNull();
  });

  it('mounts the shared ChatPanel hidden-header, framed, full-height, as a member', async () => {
    routeFetch([[`/api/topics/${TOPIC}`, () => json(topic())]]);
    await render();

    expect(panelProps.current).toMatchObject({
      topicId: TOPIC,
      isGuest: false,
      isMember: true,
      fullHeight: true,
      framed: true,
      hideHeader: true,
    });
  });
});

describe.skipIf(!CHAT_SUITES_RUN)('content', () => {
  it('EMPTY: a topic with memberCount 0 still renders (no crash on the "0 members" pluralization)', async () => {
    routeFetch([[`/api/topics/${TOPIC}`, () => json(topic({ memberCount: 0 }))]]);
    await render();

    expect(text()).toContain('0 members');
  });

  it('UTF-8: a Korean + emoji topic title renders in the header', async () => {
    const title = '법률 상담 🏛️ zk';
    routeFetch([[`/api/topics/${TOPIC}`, () => json(topic({ title }))]]);
    await render();

    expect(text()).toContain(title);
  });

  it('HOSTILE: a script-shaped title renders as text, never as an element', async () => {
    const title = '<script>alert(1)</script>';
    routeFetch([[`/api/topics/${TOPIC}`, () => json(topic({ title }))]]);
    await render();

    expect(container.querySelector('script')).toBeNull();
    expect(text()).toContain(title);
  });
});

describe.skipIf(!CHAT_SUITES_RUN)('EXT-FAILURE', () => {
  it('a 500 shows an error with a way back, and mounts no panel', async () => {
    routeFetch([[`/api/topics/${TOPIC}`, () => json({ error: 'boom' }, false, 500)]]);
    await render();

    expect(text()).toContain('Topic not found');
    expect(panelProps.current).toBeNull();
  });

  it('a rejected fetch (network failure) shows an error rather than hanging', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))));
    await render();

    expect(text()).toContain('network down');
    expect(panelProps.current).toBeNull();
  });
});

describe.skipIf(!CHAT_SUITES_RUN)('members overlay (FIX3)', () => {
  async function flush(times = 6) {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  // NOT `button[aria-pressed]` — BareChatShell's own width-preset buttons
  // (Narrow/Wide/Full) also carry `aria-pressed` and render earlier in the
  // DOM, so that selector would grab the wrong control.
  function membersButton(): HTMLButtonElement {
    return container.querySelector('button[aria-label="Show members"], button[aria-label="Hide members"]') as HTMLButtonElement;
  }

  it('CONTRACT: the member count is a real button, not dead text', async () => {
    routeFetch([
      [`/api/topics/${TOPIC}`, () => json(topic())],
      ['/api/auth/session', () => json({ userId: 'me' })],
    ]);
    await render();

    const btn = membersButton();
    expect(btn).not.toBeNull();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('BOUNDARY 1: toggling opens the overlay with exactly one member row, over a still-mounted ChatPanel', async () => {
    // The members route MUST be listed before the general topic route below
    // — routeFetch matches by prefix, and `/api/topics/{id}/members` starts
    // with `/api/topics/{id}`, so the general route would otherwise win.
    routeFetch([
      [`/api/topics/${TOPIC}/members`, () => json({ members: [{ userId: 'u1', nickname: 'bob', role: 'member' }] })],
      [`/api/topics/${TOPIC}`, () => json(topic())],
      ['/api/auth/session', () => json({ userId: 'me' })],
    ]);
    await render();

    await act(async () => { membersButton().click(); });
    await flush();

    expect(container.querySelectorAll('[data-testid="rail-member-row"]')).toHaveLength(1);
    expect(text()).toContain('bob');
    expect(container.querySelectorAll('[data-testid="chat-panel"]')).toHaveLength(1);
    expect(membersButton().getAttribute('aria-pressed')).toBe('true');
  });

  it('BOUNDARY many: renders one row per member', async () => {
    routeFetch([
      [`/api/topics/${TOPIC}/members`, () => json({
        members: [
          { userId: 'me', nickname: 'me', role: 'owner' },
          { userId: 'u1', nickname: 'bob', role: 'admin' },
          { userId: 'u2', nickname: 'carol', role: 'member' },
        ],
      })],
      [`/api/topics/${TOPIC}`, () => json(topic())],
      ['/api/auth/session', () => json({ userId: 'me' })],
    ]);
    await render();

    await act(async () => { membersButton().click(); });
    await flush();

    expect(container.querySelectorAll('[data-testid="rail-member-row"]')).toHaveLength(3);
  });

  it('EXT-FAILURE: a failed member fetch shows a retry, not an empty list', async () => {
    routeFetch([
      [`/api/topics/${TOPIC}/members`, () => json({ error: 'boom' }, false, 500)],
      [`/api/topics/${TOPIC}`, () => json(topic())],
      ['/api/auth/session', () => json({ userId: 'me' })],
    ]);
    await render();

    await act(async () => { membersButton().click(); });
    await flush();

    expect(text()).toContain('Could not load the member list');
    expect(container.querySelectorAll('[data-testid="rail-member-row"]')).toHaveLength(0);
  });

  it('clicking again closes the overlay (toggle, not one-way)', async () => {
    routeFetch([
      [`/api/topics/${TOPIC}/members`, () => json({ members: [{ userId: 'u1', nickname: 'bob', role: 'member' }] })],
      [`/api/topics/${TOPIC}`, () => json(topic())],
      ['/api/auth/session', () => json({ userId: 'me' })],
    ]);
    await render();

    await act(async () => { membersButton().click(); });
    await flush();
    expect(container.querySelectorAll('[data-testid="rail-member-row"]')).toHaveLength(1);

    await act(async () => { membersButton().click(); });
    expect(container.querySelectorAll('[data-testid="rail-member-row"]')).toHaveLength(0);
  });
});
