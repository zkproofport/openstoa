// @vitest-environment jsdom
/**
 * `/chat` — the standalone unified conversation list (`src/app/chat/page.tsx`),
 * the list-level "open in new tab" target of the chat rail's list header. The
 * room-level equivalents (`/chat/{id}`, `/dm/{id}`) are covered by
 * `chatPage.test.tsx` and `dmPages.test.tsx`.
 *
 * `ChatRoomList` is NOT stubbed here: "the popped-out list is the same list
 * the rail shows" is the whole point of this route, so the rows it renders
 * are what these tests assert on. `ChatPanel` IS stubbed — but only so that a
 * panel mounting on this page would be *visible* as a count rather than as a
 * crypto side effect. The assertion below is that the count stays zero.
 *
 * Edge-case matrix rows covered here:
 *   authz        — an expired session (401) redirects to /; an `anon_`
 *                  nickname (403) gets the set-a-nickname remedy, not a dead
 *                  error string
 *   boundary     — 0 / 1 / many topics and DMs
 *   empty        — both tabs empty at once, each with its own copy
 *   UTF-8        — Korean + emoji topic title and DM nickname render intact
 *   large        — a 500-char title renders in full (clipped by CSS, not by
 *                  data loss)
 *   hostile      — a `<script>`-shaped title renders as text, never as markup
 *   ext-failure  — GET /api/topics or /api/dm 500 → error + a Retry that
 *                  actually refetches, never a silent empty list
 *   mount-unique — this page mounts NO ChatPanel (it is bare — no
 *                  CommunityLayout, therefore no second rail/panel for a room
 *                  already open elsewhere)
 *   contract     — a topic row navigates to /chat/{id}, a DM row to
 *                  /dm/{id} — the existing pop-out targets, not a third model
 *   integrity    — the DM list is ordered by lastActivityAt desc
 *   locale       — the page renders in ko as well as en
 *   SI-1         — only /api/topics and /api/dm are requested; no message
 *                  body or preview is fetched or rendered
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => '/chat',
  useSearchParams: () => new URLSearchParams(),
}));

// Stubbed to make "this page never mounts a chat panel" an assertable count.
const panelMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/ChatPanel', () => ({
  default: () => {
    panelMounts.count += 1;
    return React.createElement('div', { 'data-testid': 'chat-panel' });
  },
}));

import ChatListPage from '@/app/chat/page';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import type { Locale } from '@/lib/i18n';

let container: HTMLDivElement;
let root: Root;

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** Prefix-matched fetch router — first match wins, so list more specific
 *  prefixes first (`/api/dm/...` before `/api/dm`). */
function routeFetch(routes: Array<[string, (url: string) => Response]>) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    for (const [prefix, handler] of routes) {
      if (url.startsWith(prefix)) return Promise.resolve(handler(url));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function routes(topicsBody: unknown, dmsBody: unknown, opts: { topicsStatus?: number; dmsStatus?: number } = {}) {
  const { topicsStatus = 200, dmsStatus = 200 } = opts;
  return [
    ['/api/topics', () => json(topicsBody, topicsStatus < 400, topicsStatus)],
    ['/api/dm', () => json(dmsBody, dmsStatus < 400, dmsStatus)],
  ] as Array<[string, (url: string) => Response]>;
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(locale: Locale = 'en') {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale={locale}>
        <ChatListPage />
      </I18nProvider>,
    );
  });
  await flush();
}

function text(): string {
  return container.textContent ?? '';
}

function byTestId(id: string): HTMLElement[] {
  return Array.from(container.querySelectorAll(`[data-testid="${id}"]`));
}

function tabButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('[role="tab"]'));
}

/** Switch to the Direct tab. */
async function openDirectTab() {
  await act(async () => {
    tabButtons()[1].click();
  });
}

const TOPIC = { id: 't1', title: 'Zoning Law' };
const DM = { topicId: 'd1', peer: { userId: 'u1', nickname: 'bob', profileImage: null }, lastActivityAt: null };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  panelMounts.count = 0;
  routerMock.push.mockClear();
  routerMock.replace.mockClear();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('/chat — the two-tab list', () => {
  it('CONTRACT: renders BOTH tabs, Topics selected first', async () => {
    routeFetch(routes({ topics: [] }, { dms: [] }));
    await mount();

    const tabs = tabButtons();
    expect(tabs).toHaveLength(2);
    expect(tabs[0].textContent).toBe('Topics');
    expect(tabs[1].textContent).toBe('Direct');
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
  });

  it('EMPTY: both tabs empty at once — each shows its own copy, not a shared blank', async () => {
    routeFetch(routes({ topics: [] }, { dms: [] }));
    await mount();

    expect(text()).toContain("joined any chat topics yet");
    expect(container.querySelector('a[href="/topics/explore"]')).not.toBeNull();

    await openDirectTab();
    expect(text()).toContain('No direct messages yet');
  });

  it('BOUNDARY 1: one topic and one DM each render exactly one row', async () => {
    routeFetch(routes({ topics: [TOPIC] }, { dms: [DM] }));
    await mount();

    expect(byTestId('chat-rail-topic-row')).toHaveLength(1);
    expect(text()).toContain('Zoning Law');

    await openDirectTab();
    expect(byTestId('chat-rail-dm-row')).toHaveLength(1);
    expect(text()).toContain('bob');
  });

  it('BOUNDARY many: every row is rendered, both tabs', async () => {
    const topics = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, title: `Topic ${i}` }));
    const dms = Array.from({ length: 7 }, (_, i) => ({
      topicId: `d${i}`,
      peer: { userId: `u${i}`, nickname: `peer${i}`, profileImage: null },
      lastActivityAt: null,
    }));
    routeFetch(routes({ topics }, { dms }));
    await mount();

    expect(byTestId('chat-rail-topic-row')).toHaveLength(12);
    await openDirectTab();
    expect(byTestId('chat-rail-dm-row')).toHaveLength(7);
  });

  it('switching tabs does not refetch — both lists are loaded up front', async () => {
    const fetchMock = routeFetch(routes({ topics: [TOPIC] }, { dms: [DM] }));
    await mount();
    const callsAfterLoad = fetchMock.mock.calls.length;

    await openDirectTab();
    await act(async () => { tabButtons()[0].click(); });

    expect(fetchMock.mock.calls.length).toBe(callsAfterLoad);
  });
});

describe('/chat — opening a room', () => {
  it('CONTRACT: a topic row navigates THIS tab to /chat/{id}', async () => {
    routeFetch(routes({ topics: [TOPIC] }, { dms: [] }));
    await mount();

    await act(async () => { byTestId('chat-rail-topic-row')[0].click(); });

    expect(routerMock.push).toHaveBeenCalledWith('/chat/t1');
  });

  it('CONTRACT: a DM row navigates THIS tab to /dm/{id}', async () => {
    routeFetch(routes({ topics: [] }, { dms: [DM] }));
    await mount();
    await openDirectTab();

    await act(async () => { byTestId('chat-rail-dm-row')[0].click(); });

    expect(routerMock.push).toHaveBeenCalledWith('/dm/d1');
  });

  it('MOUNT-UNIQUE: the list page never mounts a ChatPanel of its own', async () => {
    // It renders `BareChatShell`, not `CommunityLayout` — so no ChatRail, no
    // panel. A room already open in another tab's rail can never be
    // double-mounted by merely opening this list.
    routeFetch(routes({ topics: [TOPIC] }, { dms: [DM] }));
    await mount();
    await openDirectTab();

    expect(byTestId('chat-panel')).toHaveLength(0);
    expect(panelMounts.count).toBe(0);
    expect(container.querySelector('[data-testid="chat-rail"]')).toBeNull();
  });
});

describe('/chat — authorization', () => {
  it('AUTHZ: an expired session (401) is sent to the login/landing page', async () => {
    routeFetch(routes({ error: 'Not authenticated' }, { error: 'Not authenticated' }, { topicsStatus: 401, dmsStatus: 401 }));
    await mount();

    expect(routerMock.replace).toHaveBeenCalledWith('/');
    // Never an empty shell: no tabs are rendered on the way out.
    expect(tabButtons()).toHaveLength(0);
  });

  it('AUTHZ: an `anon_` nickname (403 from /api/dm) gets the set-a-nickname remedy', async () => {
    routeFetch(routes({ topics: [] }, { error: 'Nickname required' }, { dmsStatus: 403 }));
    await mount();

    expect(text()).toContain('Set a nickname');
    const profileLink = container.querySelector('a[href="/profile?returnTo=%2Fchat"]');
    expect(profileLink).not.toBeNull();
    expect(tabButtons()).toHaveLength(0);
  });
});

describe('/chat — failure handling', () => {
  it('EXT-FAILURE: a 500 shows an error and a Retry that really refetches — never a silent empty list', async () => {
    let call = 0;
    routeFetch([
      ['/api/topics', () => {
        call += 1;
        return call === 1 ? json({ error: 'boom' }, false, 500) : json({ topics: [TOPIC] });
      }],
      ['/api/dm', () => json({ dms: [] })],
    ]);
    await mount();

    expect(text()).toContain('Failed to load your conversations');
    // The empty-state copy must NOT be what a failure looks like.
    expect(text()).not.toContain('joined any chat topics yet');

    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Retry')!;
    await act(async () => { retry.click(); });
    await flush();

    expect(byTestId('chat-rail-topic-row')).toHaveLength(1);
  });

  it('EXT-FAILURE: a rejected fetch (network down) lands on the same error state', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))));
    await mount();

    expect(text()).toContain('network down');
    expect(tabButtons()).toHaveLength(0);
  });

  it('a malformed payload (no `topics`/`dms` arrays) degrades to empty, not a crash', async () => {
    routeFetch(routes({}, { dms: null }));
    await mount();

    expect(text()).toContain("joined any chat topics yet");
    await openDirectTab();
    expect(text()).toContain('No direct messages yet');
  });
});

describe('/chat — content rendering', () => {
  it('UTF-8: a Korean + emoji topic title and DM nickname render intact', async () => {
    const title = '법률 상담 🏛️ zk';
    const nickname = '김철수 🚀';
    routeFetch(routes(
      { topics: [{ id: 't1', title }] },
      { dms: [{ topicId: 'd1', peer: { userId: 'u1', nickname, profileImage: null }, lastActivityAt: null }] },
    ));
    await mount();

    expect(text()).toContain(title);
    await openDirectTab();
    expect(text()).toContain(nickname);
  });

  it('LARGE: a 500-character title reaches the DOM in full (clipping is CSS, not data loss)', async () => {
    const title = 'x'.repeat(500);
    routeFetch(routes({ topics: [{ id: 't1', title }] }, { dms: [] }));
    await mount();

    expect(text()).toContain(title);
    expect(byTestId('chat-rail-topic-row')).toHaveLength(1);
  });

  it('HOSTILE: a script-shaped title renders as text, never as an element', async () => {
    const title = '<script>alert(1)</script>';
    routeFetch(routes({ topics: [{ id: 't1', title }] }, { dms: [] }));
    await mount();

    expect(container.querySelector('script')).toBeNull();
    expect(text()).toContain(title);
  });

  it('INTEGRITY: DMs are ordered most-recently-active first', async () => {
    routeFetch(routes({ topics: [] }, {
      dms: [
        { topicId: 'old', peer: { userId: 'u1', nickname: 'oldest', profileImage: null }, lastActivityAt: '2020-01-01T00:00:00.000Z' },
        { topicId: 'new', peer: { userId: 'u2', nickname: 'newest', profileImage: null }, lastActivityAt: '2030-01-01T00:00:00.000Z' },
        { topicId: 'mid', peer: { userId: 'u3', nickname: 'middle', profileImage: null }, lastActivityAt: '2025-01-01T00:00:00.000Z' },
      ],
    }));
    await mount();
    await openDirectTab();

    const names = byTestId('chat-rail-dm-row').map((row) => row.textContent ?? '');
    expect(names[0]).toContain('newest');
    expect(names[1]).toContain('middle');
    expect(names[2]).toContain('oldest');
  });

  it('SI-1: only routing metadata is fetched, and a used room shows a locked placeholder — never content', async () => {
    // `lastActivityAt` set = this room HAS messages, which is exactly the case
    // where a preview would be tempting. A server-sent `preview` field is fed
    // in below and must never reach the DOM: the server holds ciphertext, so
    // any plaintext preview would mean it had read the message.
    const fetchMock = routeFetch(routes({ topics: [TOPIC] }, {
      dms: [{
        topicId: 'd1',
        peer: { userId: 'u1', nickname: 'bob', profileImage: null },
        lastActivityAt: '2026-01-01T00:00:00.000Z',
        preview: 'my bank password is hunter2',
      }],
    }));
    await mount();
    await openDirectTab();

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u === '/api/topics' || u === '/api/dm')).toBe(true);
    expect(text()).toContain('Encrypted message');
    expect(text()).not.toContain('hunter2');
  });

  it('EMPTY: a DM that has never been used says so, instead of claiming an encrypted message', async () => {
    routeFetch(routes({ topics: [] }, { dms: [DM] }));
    await mount();
    await openDirectTab();

    expect(text()).toContain('No messages yet');
    expect(text()).not.toContain('Encrypted message');
  });

  it('LOCALE ko: the page and both tab labels render in Korean', async () => {
    routeFetch(routes({ topics: [TOPIC] }, { dms: [] }));
    await mount('ko');

    const tabs = tabButtons();
    expect(tabs[0].textContent).toBe('토픽');
    expect(tabs[1].textContent).toBe('다이렉트');
    expect(text()).toContain('종단 간 암호화된');
  });
});
