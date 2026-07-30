// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Web DM UI (P-O gap 2) — the DM list page, the conversation view, and the
 * "Message" action on a topic's member list.
 *
 * Edge-case matrix rows covered here (E2E rows live in
 * `src/__tests__/e2e/dm.test.ts`):
 *
 *   authz        — guest/expired session redirects; a DM you are not a member
 *                  of never mounts the chat panel; no self-DM button
 *   boundary     — 0 / 1 / many DM channels; a member list with 0 and 1 others
 *   empty        — a DM with no activity still opens (lastActivityAt = null)
 *   UTF-8        — Korean + emoji nicknames survive list and header rendering
 *   hostile      — a `<script>` nickname renders as text, never as an element
 *   large        — a very long nickname is clipped by CSS, not by data loss
 *   ext-failure  — GET /api/dm 500 → error + working Retry, not a blank page
 *   race         — a double-clicked Message button issues exactly ONE POST
 *   contract     — Message POSTs /api/dm with {userId} and navigates to the
 *                  returned topicId; the conversation view mounts the SHARED
 *                  ChatPanel (single E2EE path); the conversation view is a
 *                  BARE standalone page (see `BareChatShell.tsx`) — it never
 *                  renders `CommunityLayout` at all (would mount a second
 *                  `ChatRail`/`ChatPanel` for the same topic), unlike `/dm`
 *                  (the list) and the members page, which still do
 *   integrity    — the list is monotonically ordered by lastActivityAt desc
 *   SI-1         — these pages request only /api/auth/session and /api/dm; no
 *                  message body or preview is ever fetched or rendered here
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DM_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const DM_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const DM_C = 'cccccccc-3333-4333-8333-333333333333';
const TOPIC = 'dddddddd-4444-4444-8444-444444444444';

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const paramsMock = vi.hoisted(() => ({ current: {} as Record<string, string> }));
// Props the stubbed ChatPanel / CommunityLayout were last rendered with.
const panelProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const layoutProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useParams: () => paramsMock.current,
  usePathname: () => '/dm',
  useSearchParams: () => new URLSearchParams(),
}));

// CommunityLayout pulls the whole app shell (categories/tags/stats fetches and
// its own ChatPanel). Stub it, but keep the props so the "never pass topicId"
// regression guard can assert on them. Used by the /dm list page and the
// members page — NOT by the standalone /dm/[topicId] conversation view,
// which is deliberately bare (see `BareChatShell.tsx`) and never imports it.
vi.mock('@/components/CommunityLayout', () => ({
  default: (props: Record<string, unknown>) => {
    layoutProps.current = props;
    return React.createElement('div', { 'data-testid': 'layout' }, props.children as React.ReactNode);
  },
}));

// The real ChatPanel is the shared E2EE surface (MLS + SSE). Stubbing it keeps
// this a UI test AND makes "the DM view reuses ChatPanel" an assertable
// contract rather than a claim.
vi.mock('@/components/ChatPanel', () => ({
  default: (props: Record<string, unknown>) => {
    panelProps.current = props;
    return React.createElement('div', { 'data-testid': 'chat-panel' });
  },
}));

vi.mock('@/components/TopicMuteToggle', () => ({
  default: () => React.createElement('div', { 'data-testid': 'mute-toggle' }),
}));

import DmListPage from '@/app/dm/page';
import DmConversationPage from '@/app/dm/[topicId]/page';
import MembersPage from '@/app/topics/[topicId]/members/page';

// ── harness ──────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** Route fetches by URL prefix; an unmatched URL fails the test loudly. */
function routeFetch(routes: Array<[string, (init?: RequestInit) => Response]>) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    for (const [prefix, handler] of routes) {
      if (url.startsWith(prefix)) return Promise.resolve(handler(init));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

async function render(ui: React.ReactElement) {
  await act(async () => {
    root.render(ui);
  });
}

function rows(): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll('[data-testid="dm-row"]'));
}

function text(): string {
  return container.textContent ?? '';
}

function messageButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter((b) =>
    (b.getAttribute('aria-label') ?? '').startsWith('DM '),
  );
}

/** The members page's in-page DM-start error banner (replaces `alert()`). */
function dmErrorBanner(): string | null {
  return container.querySelector('[role="alert"]')?.textContent ?? null;
}

function channel(topicId: string, nickname: string, lastActivityAt: string | null) {
  return { topicId, peer: { userId: `u-${nickname}`, nickname, profileImage: null }, lastActivityAt };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  panelProps.current = null;
  layoutProps.current = null;
  paramsMock.current = {};
  window.alert = vi.fn();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

// ── DM list page ─────────────────────────────────────────────────────────────

describe('/dm — DM list', () => {
  it('AUTHZ: a session without a userId is sent back to the login page', async () => {
    routeFetch([
      ['/api/auth/session', () => json({})],
      ['/api/dm', () => json({ dms: [] })],
    ]);

    await render(<DmListPage />);

    expect(routerMock.replace).toHaveBeenCalledWith('/');
  });

  it('AUTHZ: a 401 from /api/dm redirects instead of rendering an empty list', async () => {
    routeFetch([
      ['/api/auth/session', () => json({ userId: 'me' })],
      ['/api/dm', () => json({ error: 'Not authenticated' }, false, 401)],
    ]);

    await render(<DmListPage />);

    expect(routerMock.replace).toHaveBeenCalledWith('/');
    expect(rows()).toHaveLength(0);
  });

  it('BOUNDARY 0: an empty list shows the empty state, not a blank page', async () => {
    routeFetch([
      ['/api/auth/session', () => json({ userId: 'me' })],
      ['/api/dm', () => json({ dms: [] })],
    ]);

    await render(<DmListPage />);

    expect(rows()).toHaveLength(0);
    expect(text()).toContain('No direct messages');
  });

  it('BOUNDARY 1: a single channel renders one row linking to its conversation', async () => {
    routeFetch([
      ['/api/auth/session', () => json({ userId: 'me' })],
      ['/api/dm', () => json({ dms: [channel(DM_A, 'bob', '2026-01-02T00:00:00Z')] })],
    ]);

    await render(<DmListPage />);

    expect(rows()).toHaveLength(1);
    expect(rows()[0].getAttribute('href')).toBe(`/dm/${DM_A}`);
    expect(rows()[0].textContent).toContain('bob');
  });

  it('INTEGRITY: rows are monotonic in lastActivityAt (desc), never-active last', async () => {
    routeFetch([
      ['/api/auth/session', () => json({ userId: 'me' })],
      // Deliberately shuffled + one channel that never saw activity.
      ['/api/dm', () => json({
        dms: [
          channel(DM_A, 'older', '2026-01-01T00:00:00Z'),
          channel(DM_C, 'never', null),
          channel(DM_B, 'newer', '2026-06-01T00:00:00Z'),
        ],
      })],
    ]);

    await render(<DmListPage />);

    expect(rows().map((r) => r.getAttribute('href'))).toEqual([
      `/dm/${DM_B}`,
      `/dm/${DM_A}`,
      `/dm/${DM_C}`,
    ]);
  });

  it('EMPTY: a channel with no activity still renders (and shows no timestamp)', async () => {
    routeFetch([
      ['/api/auth/session', () => json({ userId: 'me' })],
      ['/api/dm', () => json({ dms: [channel(DM_A, 'quiet', null)] })],
    ]);

    await render(<DmListPage />);

    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain('quiet');
  });

  it('UTF-8: Korean + emoji + mixed-script nicknames render intact', async () => {
    const nick = '김철수 🚀 zk';
    routeFetch([
      ['/api/auth/session', () => json({ userId: 'me' })],
      ['/api/dm', () => json({ dms: [channel(DM_A, nick, '2026-01-01T00:00:00Z')] })],
    ]);

    await render(<DmListPage />);

    expect(rows()[0].textContent).toContain(nick);
  });

  it('HOSTILE: a script-shaped nickname is rendered as text, never as an element', async () => {
    const nick = '<script>alert(1)</script>%_\\';
    routeFetch([
      ['/api/auth/session', () => json({ userId: 'me' })],
      ['/api/dm', () => json({ dms: [channel(DM_A, nick, null)] })],
    ]);

    await render(<DmListPage />);

    expect(container.querySelector('script')).toBeNull();
    expect(rows()[0].textContent).toContain(nick);
  });

  it('LARGE: a very long nickname is clipped by CSS, with the value intact in the DOM', async () => {
    const nick = 'n'.repeat(500);
    routeFetch([
      ['/api/auth/session', () => json({ userId: 'me' })],
      ['/api/dm', () => json({ dms: [channel(DM_A, nick, null)] })],
    ]);

    await render(<DmListPage />);

    const label = rows()[0].querySelector('span') as HTMLElement;
    expect(label.textContent).toBe(nick);
    expect(label.style.textOverflow).toBe('ellipsis');
    expect(label.style.whiteSpace).toBe('nowrap');
  });

  it('EXT-FAILURE: a 500 shows an error with a Retry that actually reloads', async () => {
    let attempt = 0;
    routeFetch([
      ['/api/auth/session', () => json({ userId: 'me' })],
      ['/api/dm', () => {
        attempt += 1;
        return attempt === 1
          ? json({ error: 'boom' }, false, 500)
          : json({ dms: [channel(DM_A, 'bob', null)] });
      }],
    ]);

    await render(<DmListPage />);
    expect(text()).toContain('Failed to load messages');

    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Retry');
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); });

    expect(rows()).toHaveLength(1);
  });

  it('AUTHZ: a 403 (temp anon_ nickname) points at the profile, not a dead error', async () => {
    routeFetch([
      ['/api/auth/session', () => json({ userId: 'me' })],
      ['/api/dm', () => json({ error: 'Nickname required.' }, false, 403)],
    ]);

    await render(<DmListPage />);

    expect(text()).toContain('Set a nickname');
    expect(container.querySelector('a[href="/profile?returnTo=%2Fdm"]')).not.toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it('SI-1: the page fetches only the session and the DM list — no message bodies', async () => {
    const fetchMock = routeFetch([
      ['/api/auth/session', () => json({ userId: 'me' })],
      ['/api/dm', () => json({ dms: [channel(DM_A, 'bob', '2026-01-01T00:00:00Z')] })],
    ]);

    await render(<DmListPage />);

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.every((u) => u === '/api/auth/session' || u === '/api/dm')).toBe(true);
    expect(urls.some((u) => u.includes('/chat'))).toBe(false);
  });
});

// ── DM conversation view ─────────────────────────────────────────────────────

describe('/dm/[topicId] — conversation', () => {
  beforeEach(() => {
    paramsMock.current = { topicId: DM_A };
  });

  it('CONTRACT: mounts the shared ChatPanel for the DM topic (one E2EE path)', async () => {
    routeFetch([['/api/dm', () => json({ dms: [channel(DM_A, 'bob', '2026-01-01T00:00:00Z')] })]]);

    await render(<DmConversationPage />);

    expect(container.querySelector('[data-testid="chat-panel"]')).not.toBeNull();
    expect(panelProps.current).toMatchObject({ topicId: DM_A, isGuest: false, isMember: true });
  });

  it('CONTRACT: bare page — never renders CommunityLayout at all (would open a 2nd live panel)', async () => {
    routeFetch([['/api/dm', () => json({ dms: [channel(DM_A, 'bob', '2026-01-01T00:00:00Z')] })]]);

    await render(<DmConversationPage />);

    // `layoutProps.current` was reset to null in `beforeEach`; if this page
    // rendered CommunityLayout (even without a topicId) the mock above would
    // have set it, since it stores the LAST props it was called with.
    expect(layoutProps.current).toBeNull();
    expect(container.querySelector('[data-testid="layout"]')).toBeNull();
  });

  it('CONTRACT: no back-arrow — a Close affordance (from BareChatShell) and the per-topic mute control instead', async () => {
    // P-2: a popped-out tab has no meaningful "back". The old back-arrow Link
    // is gone; `BareChatShell` provides the one exit affordance (Close) plus
    // the width control, both above this page's own identity row.
    routeFetch([['/api/dm', () => json({ dms: [channel(DM_A, 'bob', '2026-01-01T00:00:00Z')] })]]);

    await render(<DmConversationPage />);

    expect(container.querySelector('a[aria-label="Back to messages"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Close"]')).not.toBeNull();
    expect(container.querySelector('[role="group"][aria-label="Chat width"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mute-toggle"]')).not.toBeNull();
  });

  it('AUTHZ: a DM the caller is not a member of never mounts the panel', async () => {
    // The channel list is the caller's OWN memberships — a foreign/unknown
    // topicId simply is not in it.
    routeFetch([['/api/dm', () => json({ dms: [channel(DM_B, 'someone-else', null)] })]]);

    await render(<DmConversationPage />);

    expect(container.querySelector('[data-testid="chat-panel"]')).toBeNull();
    expect(text()).toContain('Conversation not found');
  });

  it('AUTHZ: an empty DM list also refuses to mount the panel', async () => {
    routeFetch([['/api/dm', () => json({ dms: [] })]]);

    await render(<DmConversationPage />);

    expect(container.querySelector('[data-testid="chat-panel"]')).toBeNull();
  });

  it('AUTHZ: 401 redirects to login and mounts nothing', async () => {
    routeFetch([['/api/dm', () => json({ error: 'Not authenticated' }, false, 401)]]);

    await render(<DmConversationPage />);

    expect(routerMock.replace).toHaveBeenCalledWith('/');
    expect(container.querySelector('[data-testid="chat-panel"]')).toBeNull();
  });

  it('AUTHZ: 403 (temp anon_ nickname) points at the profile and mounts nothing', async () => {
    routeFetch([['/api/dm', () => json({ error: 'Nickname required.' }, false, 403)]]);

    await render(<DmConversationPage />);

    expect(text()).toContain('Set a nickname');
    expect(container.querySelector('[data-testid="chat-panel"]')).toBeNull();
  });

  it('EMPTY: a conversation with zero activity still opens', async () => {
    routeFetch([['/api/dm', () => json({ dms: [channel(DM_A, 'bob', null)] })]]);

    await render(<DmConversationPage />);

    expect(container.querySelector('[data-testid="chat-panel"]')).not.toBeNull();
  });

  it('UTF-8: the header is named after the peer, not the placeholder topic title', async () => {
    const nick = '박영희 🌙';
    routeFetch([['/api/dm', () => json({ dms: [channel(DM_A, nick, null)] })]]);

    await render(<DmConversationPage />);

    expect(text()).toContain(nick);
    expect(text()).not.toContain('Conversation not found');
  });

  it('EXT-FAILURE: a network failure shows an error and a way back', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;

    await render(<DmConversationPage />);

    expect(text()).toContain('offline');
    expect(container.querySelector('a[href="/dm"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-panel"]')).toBeNull();
  });
});

// ── Message action on the member list ────────────────────────────────────────

describe('/topics/[topicId]/members — Message action', () => {
  function memberRoutes(members: Array<{ userId: string; nickname: string; role: string }>, me = 'me') {
    return [
      ['/api/auth/session', () => json({ userId: me })] as [string, () => Response],
      [`/api/topics/${TOPIC}/members`, () => json({ members })] as [string, () => Response],
      [`/api/topics/${TOPIC}`, () => json({ topic: { id: TOPIC, title: 'Topic' } })] as [string, () => Response],
    ];
  }

  beforeEach(() => {
    paramsMock.current = { topicId: TOPIC };
  });

  it('BOUNDARY 0 others: a member list containing only you offers no Message button', async () => {
    routeFetch(memberRoutes([{ userId: 'me', nickname: 'me', role: 'owner' }]));

    await render(<MembersPage />);

    expect(messageButtons()).toHaveLength(0);
  });

  it('BOUNDARY 1 other: exactly one Message button, never on your own row', async () => {
    routeFetch(memberRoutes([
      { userId: 'me', nickname: 'me', role: 'owner' },
      { userId: 'bob', nickname: 'bob', role: 'member' },
    ]));

    await render(<MembersPage />);

    const btns = messageButtons();
    expect(btns).toHaveLength(1);
    expect(btns[0].getAttribute('aria-label')).toBe('DM bob');
  });

  it('AUTHZ: no Message button is offered before the session id is known', async () => {
    routeFetch([
      // Session never resolves to a userId → we cannot tell which row is ours.
      ['/api/auth/session', () => json({})],
      [`/api/topics/${TOPIC}/members`, () => json({ members: [{ userId: 'bob', nickname: 'bob', role: 'member' }] })],
      [`/api/topics/${TOPIC}`, () => json({ topic: { id: TOPIC, title: 'Topic' } })],
    ]);

    await render(<MembersPage />);

    expect(messageButtons()).toHaveLength(0);
  });

  it('CONTRACT: clicking POSTs /api/dm with {userId} and lands in the returned channel', async () => {
    const fetchMock = routeFetch([
      ...memberRoutes([
        { userId: 'me', nickname: 'me', role: 'owner' },
        { userId: 'bob', nickname: 'bob', role: 'member' },
      ]),
      ['/api/dm', () => json({ topicId: DM_A }, true, 201)],
    ]);

    await render(<MembersPage />);
    await act(async () => { messageButtons()[0].click(); });

    const dmCall = fetchMock.mock.calls.find((c) => c[0] === '/api/dm');
    expect(dmCall).toBeDefined();
    const init = dmCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ userId: 'bob' });
    expect(routerMock.push).toHaveBeenCalledWith(`/dm/${DM_A}`);
  });

  it('IDEMPOTENCY: a 200 (existing channel) navigates to the same conversation as a 201', async () => {
    routeFetch([
      ...memberRoutes([
        { userId: 'me', nickname: 'me', role: 'owner' },
        { userId: 'bob', nickname: 'bob', role: 'member' },
      ]),
      // Server reports the pair already has a channel — start-or-GET.
      ['/api/dm', () => json({ topicId: DM_A }, true, 200)],
    ]);

    await render(<MembersPage />);
    await act(async () => { messageButtons()[0].click(); });

    expect(routerMock.push).toHaveBeenCalledWith(`/dm/${DM_A}`);
    expect(routerMock.push).toHaveBeenCalledTimes(1);
  });

  it('RACE: a double-clicked Message button issues exactly ONE POST', async () => {
    let resolveDm: (r: Response) => void = () => {};
    const pending = new Promise<Response>((res) => { resolveDm = res; });
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/auth/session') return Promise.resolve(json({ userId: 'me' }));
      if (url === `/api/topics/${TOPIC}/members`) {
        return Promise.resolve(json({ members: [
          { userId: 'me', nickname: 'me', role: 'owner' },
          { userId: 'bob', nickname: 'bob', role: 'member' },
        ] }));
      }
      if (url === `/api/topics/${TOPIC}`) return Promise.resolve(json({ topic: { id: TOPIC, title: 'Topic' } }));
      if (url === '/api/dm') return pending;
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await render(<MembersPage />);
    await act(async () => {
      messageButtons()[0].click();
      messageButtons()[0].click();
    });

    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/dm')).toHaveLength(1);

    await act(async () => { resolveDm(json({ topicId: DM_A }, true, 201)); await pending; });
    expect(routerMock.push).toHaveBeenCalledTimes(1);
  });

  it('SELF-DM: a 400 from the server surfaces and does NOT navigate', async () => {
    routeFetch([
      ...memberRoutes([
        { userId: 'me', nickname: 'me', role: 'owner' },
        { userId: 'bob', nickname: 'bob', role: 'member' },
      ]),
      ['/api/dm', () => json({ error: 'Cannot start a DM with yourself' }, false, 400)],
    ]);

    await render(<MembersPage />);
    await act(async () => { messageButtons()[0].click(); });

    // In-page error banner, not a blocking alert() dialog.
    expect(window.alert).not.toHaveBeenCalled();
    expect(dmErrorBanner()).toContain('Cannot start a DM with yourself');
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('UNKNOWN PEER: a 404 (user gone/left) surfaces and does NOT navigate', async () => {
    routeFetch([
      ...memberRoutes([
        { userId: 'me', nickname: 'me', role: 'owner' },
        { userId: 'ghost', nickname: 'ghost', role: 'member' },
      ]),
      ['/api/dm', () => json({ error: 'User not found' }, false, 404)],
    ]);

    await render(<MembersPage />);
    await act(async () => { messageButtons()[0].click(); });

    expect(window.alert).not.toHaveBeenCalled();
    expect(dmErrorBanner()).toContain('User not found');
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('EXT-FAILURE: a 200 without a topicId is treated as a failure, not a navigation', async () => {
    routeFetch([
      ...memberRoutes([
        { userId: 'me', nickname: 'me', role: 'owner' },
        { userId: 'bob', nickname: 'bob', role: 'member' },
      ]),
      ['/api/dm', () => json({}, true, 200)],
    ]);

    await render(<MembersPage />);
    await act(async () => { messageButtons()[0].click(); });

    expect(routerMock.push).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
    expect(dmErrorBanner()).not.toBeNull();
  });

  it('UTF-8: the button is labelled with the peer nickname verbatim', async () => {
    routeFetch(memberRoutes([
      { userId: 'me', nickname: 'me', role: 'owner' },
      { userId: 'k', nickname: '이수민 ✨', role: 'admin' },
    ]));

    await render(<MembersPage />);

    expect(messageButtons()[0].getAttribute('aria-label')).toBe('DM 이수민 ✨');
  });
});
