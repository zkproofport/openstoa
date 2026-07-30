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
 *   contract     — never hands topicId to CommunityLayout (would double-mount
 *                  a live ChatPanel for the SAME topic — the very regression
 *                  this whole redesign must not reintroduce); ChatPanel is
 *                  mounted with hideHeader + framed + fullHeight
 *   empty        — a topic with memberCount 0/undefined still renders
 *   UTF-8        — Korean + emoji topic titles render in the header
 *   hostile      — a script-shaped title renders as text, never as an element
 *   ext-failure  — a 500 / thrown fetch shows an error with a way back
 */
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
const layoutProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const panelProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useParams: () => paramsMock.current,
}));

vi.mock('@/components/CommunityLayout', () => ({
  default: (props: Record<string, unknown>) => {
    layoutProps.current = props;
    return React.createElement('div', { 'data-testid': 'layout' }, props.children as React.ReactNode);
  },
}));

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

async function render() {
  await act(async () => {
    root.render(React.createElement(TopicChatPage));
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
  layoutProps.current = null;
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

describe('AUTHZ', () => {
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

describe('CONTRACT', () => {
  it('never hands topicId to CommunityLayout (would double-mount a live ChatPanel)', async () => {
    routeFetch([[`/api/topics/${TOPIC}`, () => json(topic())]]);
    await render();

    expect(layoutProps.current).not.toBeNull();
    expect(layoutProps.current!.topicId).toBeUndefined();
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

describe('content', () => {
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

describe('EXT-FAILURE', () => {
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
