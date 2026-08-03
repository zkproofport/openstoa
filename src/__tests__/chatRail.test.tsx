// @vitest-environment jsdom
/**
 * `ChatRail.tsx` — the right-edge chat rail's two-level nav (list ↔ room),
 * the Topics/Direct tabs, and the new-conversation picker.
 *
 * `ChatPanel` is stubbed: this is a UI/wiring test for the rail itself, and
 * stubbing lets "at most one ChatPanel is asked to mount" be an assertable
 * count rather than something inferred from crypto side effects (that guard
 * is separately pinned at the crypto layer by
 * `mls-session-single-consumer.test.ts`).
 *
 * Edge-case matrix rows covered here:
 *   boundary     — 0 / 1 / many topics and DMs
 *   empty        — empty topics tab, empty DMs tab, empty candidate list
 *   UTF-8        — Korean + emoji topic titles and candidate nicknames
 *   large        — a very long nickname/title does not break rendering
 *   hostile      — a `<script>`-shaped nickname renders as text only
 *   self         — the viewer never appears in the new-conversation picker
 *   race         — a double-clicked candidate issues exactly ONE POST /api/dm
 *   contract     — open-in-new-tab href: /chat for the LIST, /chat/{id} for a
 *                  topic room, /dm/{id} for a DM room, and never two of them
 *                  at once; new conversation POSTs /api/dm and opens the room
 *   mount-unique — a room whose standalone page IS the current pathname is
 *                  never handed to ChatPanel (suppressPanel) — this is the
 *                  regression this whole redesign must not reintroduce
 *   open-request — an external "jump to this room" request (the left-nav
 *                  Chat entry, a topic page's "Open topic chat" — both wired
 *                  in `CommunityLayout.tsx`) opens the right room on first
 *                  mount AND while already mounted, and a repeat of the same
 *                  target (new nonce, same room) still re-applies
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pathnameMock = vi.hoisted(() => ({ current: '/topics' }));
const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock.current,
  // UserCard (rendered inside the member list) calls useRouter() unconditionally
  // as its no-rail-context fallback path — never exercised by ChatRail's own
  // tests (a ChatRailContext.Provider is never mounted here), but the hook
  // still needs to resolve to something rather than throw.
  useRouter: () => routerMock,
}));

/**
 * `mountCount` counts real MOUNTS (a `[]`-dep effect), not renders.
 *
 * It used to increment in the component body, which counted every render — so
 * a guard named "mount-uniqueness" was actually measuring render count, and a
 * re-render looked identical to a remount. That distinction is the whole point
 * here: MLS drops each message's decrypt key after first use, so what must
 * never happen is a SECOND live panel or a needless remount that re-runs the
 * initial history fetch. `renderCount` is kept separately for assertions that
 * genuinely care about re-renders.
 */
const panelProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
  mountCount: 0,
  renderCount: 0,
}));
vi.mock('@/components/ChatPanel', () => ({
  default: (props: Record<string, unknown>) => {
    panelProps.current = props;
    panelProps.renderCount += 1;
    React.useEffect(() => {
      panelProps.mountCount += 1;
    }, []);
    return React.createElement('div', { 'data-testid': 'chat-panel' });
  },
}));

vi.mock('@/components/TopicMuteToggle', () => ({
  default: () => React.createElement('div', { 'data-testid': 'mute-toggle' }),
}));

// Spies on the REAL `invalidateDmCandidates` (still calls through — the
// dedupe/TTL logic below stays real, per the module doc) so FIX9's "starting
// a DM invalidates the cache" contract is directly assertable, not just
// inferred from its side effects.
vi.mock('@/lib/dmCandidatesCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dmCandidatesCache')>();
  return { ...actual, invalidateDmCandidates: vi.fn(actual.invalidateDmCandidates) };
});

import ChatRail from '@/components/ChatRail';
import { invalidateDmCandidates } from '@/lib/dmCandidatesCache';
import { I18nProvider } from '@/lib/i18n/I18nProvider';

let container: HTMLDivElement;
let root: Root;

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function routeFetch(routes: Array<[string, (url: string, init?: RequestInit) => Response]>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const [prefix, handler] of routes) {
      if (url.startsWith(prefix)) return Promise.resolve(handler(url, init));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

type OpenRequest = { room: { kind: 'topic' | 'dm'; topicId: string; title: string } | null; nonce: number } | null;

// `ChatRail` (and the `UserCard`/`TopicMuteToggle` it renders internally)
// now read copy through `useTranslation()` — see src/lib/i18n/I18nProvider.tsx.
// Every render needs the provider in the tree, same as the app root
// (src/app/layout.tsx).
async function mount(onClose: () => void = () => {}, openRequest: OpenRequest = null) {
  await act(async () => {
    root.render(<I18nProvider initialLocale="en"><ChatRail onClose={onClose} openRequest={openRequest} /></I18nProvider>);
  });
  await flush();
}

/** Re-render the SAME mounted ChatRail with a new `openRequest` — a prop
 *  update, not a remount, exercising the "while already open" path rather
 *  than the lazy-`useState` mount-time path. */
async function rerenderWithRequest(openRequest: OpenRequest, onClose: () => void = () => {}) {
  await act(async () => {
    root.render(<I18nProvider initialLocale="en"><ChatRail onClose={onClose} openRequest={openRequest} /></I18nProvider>);
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

const defaultRoutes: Array<[string, (url: string) => Response]> = [
  ['/api/auth/session', () => json({ userId: 'me' })],
  ['/api/topics', () => json({ topics: [] })],
  ['/api/dm', () => json({ dms: [] })],
];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pathnameMock.current = '/topics';
  panelProps.current = null;
  panelProps.mountCount = 0;
  panelProps.renderCount = 0;
  // `dmCandidatesCache` is a module-level cache shared across the whole test
  // file (its dedupe/TTL logic is real, only wrapped in a call-spy — see the
  // vi.mock above) — without this, test N+1 would silently see test N's
  // cached candidates instead of its own routeFetch mock.
  invalidateDmCandidates();
  vi.mocked(invalidateDmCandidates).mockClear();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('list view — Topics tab', () => {
  it('BOUNDARY 0: no joined topics shows the empty state with an explore link', async () => {
    routeFetch(defaultRoutes);
    await mount();

    expect(text()).toContain('joined any chat topics yet');
    const explore = container.querySelector('a[href="/topics/explore"]');
    expect(explore).not.toBeNull();
  });

  it('BOUNDARY 1: a single topic renders one row', async () => {
    routeFetch([
      ...defaultRoutes.filter(([p]) => p !== '/api/topics'),
      ['/api/topics', () => json({ topics: [{ id: 't1', title: 'Zoning Law' }] })],
    ]);
    await mount();

    expect(byTestId('chat-rail-topic-row')).toHaveLength(1);
    expect(text()).toContain('Zoning Law');
  });

  it('clicking a topic row opens the room view and mounts ChatPanel exactly once', async () => {
    routeFetch([
      ...defaultRoutes.filter(([p]) => p !== '/api/topics'),
      ['/api/topics', () => json({ topics: [{ id: 't1', title: 'Zoning Law' }] })],
    ]);
    await mount();

    await act(async () => {
      byTestId('chat-rail-topic-row')[0].click();
    });

    expect(byTestId('chat-panel')).toHaveLength(1);
    expect(panelProps.mountCount).toBe(1);
    expect(panelProps.current).toMatchObject({ topicId: 't1', roomy: true, hideHeader: true, fullHeight: true });
    // Back button returns to the list.
    const back = container.querySelector('button[aria-label="Back to chat list"]') as HTMLButtonElement;
    await act(async () => { back.click(); });
    expect(byTestId('chat-panel')).toHaveLength(0);
  });

  it('the open-in-new-tab link for a topic room points at /chat/{id}', async () => {
    routeFetch([
      ...defaultRoutes.filter(([p]) => p !== '/api/topics'),
      ['/api/topics', () => json({ topics: [{ id: 't1', title: 'Zoning Law' }] })],
    ]);
    await mount();
    await act(async () => { byTestId('chat-rail-topic-row')[0].click(); });

    const newTab = container.querySelector('a[aria-label="Open in new tab"]');
    expect(newTab?.getAttribute('href')).toBe('/chat/t1');
  });

  it('UTF-8: a Korean + emoji topic title renders intact', async () => {
    const title = '법률 상담 🏛️ zk';
    routeFetch([
      ...defaultRoutes.filter(([p]) => p !== '/api/topics'),
      ['/api/topics', () => json({ topics: [{ id: 't1', title } ] })],
    ]);
    await mount();

    expect(text()).toContain(title);
  });

  it('HOSTILE: a script-shaped topic title renders as text, never as an element', async () => {
    const title = '<script>alert(1)</script>';
    routeFetch([
      ...defaultRoutes.filter(([p]) => p !== '/api/topics'),
      ['/api/topics', () => json({ topics: [{ id: 't1', title }] })],
    ]);
    await mount();

    expect(container.querySelector('script')).toBeNull();
    expect(text()).toContain(title);
  });
});

describe('list view — Direct tab', () => {
  it('BOUNDARY 0: no DMs shows the empty state', async () => {
    routeFetch(defaultRoutes);
    await mount();

    await act(async () => { tabButtons()[1].click(); });
    expect(text()).toContain('No direct messages yet');
  });

  it('BOUNDARY 1: a single DM renders one row and opens /dm/{id} in a new tab', async () => {
    routeFetch([
      ...defaultRoutes.filter(([p]) => p !== '/api/dm'),
      ['/api/dm', () => json({ dms: [{ topicId: 'd1', peer: { userId: 'u1', nickname: 'bob', profileImage: null }, lastActivityAt: null }] })],
    ]);
    await mount();
    await act(async () => { tabButtons()[1].click(); });

    expect(byTestId('chat-rail-dm-row')).toHaveLength(1);
    await act(async () => { byTestId('chat-rail-dm-row')[0].click(); });

    expect(panelProps.current).toMatchObject({ topicId: 'd1' });
    const newTab = container.querySelector('a[aria-label="Open in new tab"]');
    expect(newTab?.getAttribute('href')).toBe('/dm/d1');
  });
});

describe('list header — pop the LIST out into its own tab', () => {
  function listPopOut(): HTMLAnchorElement | null {
    return container.querySelector('a[aria-label="Open chat list in new tab"]');
  }

  it('CONTRACT: the list header offers a pop-out link to /chat, in a new tab', async () => {
    routeFetch(defaultRoutes);
    await mount();

    const link = listPopOut();
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/chat');
    expect(link!.getAttribute('target')).toBe('_blank');
    // `noopener` is what keeps the popped-out tab from reaching back into
    // this one via window.opener — same treatment as the room pop-out.
    expect(link!.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('CONTRACT: it is the LIST-level control — the room view offers the room pop-out instead', async () => {
    routeFetch([
      ...defaultRoutes.filter(([p]) => p !== '/api/topics'),
      ['/api/topics', () => json({ topics: [{ id: 't1', title: 'Zoning Law' }] })],
    ]);
    await mount();
    expect(listPopOut()).not.toBeNull();

    await act(async () => { byTestId('chat-rail-topic-row')[0].click(); });

    // In a room the two must not both be present — one pop-out affordance at
    // a time, whose target is unambiguous.
    expect(listPopOut()).toBeNull();
    expect(container.querySelector('a[aria-label="Open in new tab"]')?.getAttribute('href')).toBe('/chat/t1');
  });

  it('the pop-out survives the new-conversation picker being opened and cancelled', async () => {
    routeFetch([
      ['/api/dm/candidates', () => json({ candidates: [] })],
      ...defaultRoutes,
    ]);
    await mount();
    await act(async () => {
      (container.querySelector('button[aria-label="New conversation"]') as HTMLButtonElement).click();
    });
    await flush();
    // The picker replaces the BODY, not the header — the list header (and so
    // its pop-out) is still the chrome above it.
    expect(listPopOut()).not.toBeNull();

    const cancel = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!;
    await act(async () => { cancel.click(); });
    expect(listPopOut()).not.toBeNull();
  });
});

describe('mount-uniqueness guard', () => {
  it('MOUNT-UNIQUE: a room matching the current standalone page never gets its own ChatPanel', async () => {
    pathnameMock.current = '/chat/t1';
    routeFetch([
      ...defaultRoutes.filter(([p]) => p !== '/api/topics'),
      ['/api/topics', () => json({ topics: [{ id: 't1', title: 'Zoning Law' }] })],
    ]);
    await mount();

    await act(async () => { byTestId('chat-rail-topic-row')[0].click(); });

    expect(byTestId('chat-panel')).toHaveLength(0);
    expect(panelProps.mountCount).toBe(0);
    expect(text()).toContain("already viewing this conversation");
  });

  it('a DIFFERENT topic room than the current page DOES mount its own ChatPanel', async () => {
    pathnameMock.current = '/chat/some-other-topic';
    routeFetch([
      ...defaultRoutes.filter(([p]) => p !== '/api/topics'),
      ['/api/topics', () => json({ topics: [{ id: 't1', title: 'Zoning Law' }] })],
    ]);
    await mount();
    await act(async () => { byTestId('chat-rail-topic-row')[0].click(); });

    expect(byTestId('chat-panel')).toHaveLength(1);
  });
});

describe('new-conversation picker', () => {
  const candidates = [
    { userId: 'u1', nickname: 'bob', profileImage: null, badges: [], sharedTopics: [{ id: 't1', title: 'Zoning' }] },
    { userId: 'u2', nickname: '김철수 🚀', profileImage: null, badges: [], sharedTopics: [{ id: 't1', title: 'Zoning' }] },
    { userId: 'me', nickname: 'myself', profileImage: null, badges: [], sharedTopics: [{ id: 't1', title: 'Zoning' }] },
  ];

  function openPicker() {
    return act(async () => {
      (container.querySelector('button[aria-label="New conversation"]') as HTMLButtonElement).click();
    });
  }

  it('SELF: the viewer never appears in the candidate list even if the server erroneously included them', async () => {
    routeFetch([
      // '/api/dm/candidates' must be listed BEFORE the plain '/api/dm' route
      // below — routeFetch matches by prefix, and '/api/dm/candidates'
      // starts with '/api/dm', so the generic route would otherwise win.
      ['/api/dm/candidates', () => json({ candidates })],
      ...defaultRoutes,
    ]);
    await mount();
    await openPicker();
    await flush();

    expect(byTestId('dm-candidate-row')).toHaveLength(2);
    expect(text()).not.toContain('myself');
  });

  it('EMPTY: no shareable candidates shows the explanatory empty state', async () => {
    routeFetch([
      ...defaultRoutes.filter(([p]) => p !== '/api/dm/candidates'),
      ['/api/dm/candidates', () => json({ candidates: [] })],
    ]);
    await mount();
    await openPicker();
    await flush();

    expect(text()).toContain('No one to message yet');
  });

  it('client-side search filters by nickname (UTF-8 substring)', async () => {
    routeFetch([
      // '/api/dm/candidates' must be listed BEFORE the plain '/api/dm' route
      // below — routeFetch matches by prefix, and '/api/dm/candidates'
      // starts with '/api/dm', so the generic route would otherwise win.
      ['/api/dm/candidates', () => json({ candidates })],
      ...defaultRoutes,
    ]);
    await mount();
    await openPicker();
    await flush();

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '철수');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(byTestId('dm-candidate-row')).toHaveLength(1);
    expect(text()).toContain('김철수');
  });

  it('CONTRACT + RACE: picking a candidate issues exactly ONE POST /api/dm and opens the room', async () => {
    let dmPosts = 0;
    routeFetch([
      ...defaultRoutes.filter(([p]) => p !== '/api/dm/candidates' && p !== '/api/dm'),
      ['/api/dm/candidates', () => json({ candidates })],
      ['/api/dm', (url, init) => {
        if (init?.method === 'POST') {
          dmPosts += 1;
          return json({ topicId: 'new-dm-topic' }, true, 201);
        }
        return json({ dms: [] });
      }],
    ]);
    await mount();
    await openPicker();
    await flush();

    const row = byTestId('dm-candidate-row')[0] as HTMLButtonElement;
    // Both clicks fire synchronously within the same event-loop turn — the
    // in-flight ref guard (set before the first `await`) must block the
    // second before either POST response has come back.
    await act(async () => {
      row.click();
      row.click();
    });
    await flush();

    expect(dmPosts).toBe(1);
    expect(panelProps.current).toMatchObject({ topicId: 'new-dm-topic' });
    // FIX9: starting a DM invalidates the candidates cache immediately —
    // otherwise the person just messaged would keep appearing in the
    // new-conversation picker (stale cache) for up to 60s even though the
    // server now excludes them.
    expect(invalidateDmCandidates).toHaveBeenCalledTimes(1);
  });
});

describe('openRequest — external jump-to-room', () => {
  it('CONTRACT: a request present at mount opens straight to that room (no list flash)', async () => {
    routeFetch(defaultRoutes);
    await mount(() => {}, { room: { kind: 'topic', topicId: 't1', title: 'Zoning Law' }, nonce: 1 });

    expect(byTestId('chat-panel')).toHaveLength(1);
    expect(panelProps.current).toMatchObject({ topicId: 't1' });
    // No "Back to chat list" button implies we never rendered the list first.
    expect(text()).not.toContain('joined any chat topics yet');
  });

  it('a request with room: null (present at mount) is a no-op — the list is the default anyway', async () => {
    routeFetch(defaultRoutes);
    await mount(() => {}, { room: null, nonce: 1 });

    expect(byTestId('chat-panel')).toHaveLength(0);
    expect(text()).toContain('joined any chat topics yet');
  });

  it('CONTRACT: a request applied WHILE ALREADY MOUNTED jumps from the list to that room', async () => {
    routeFetch(defaultRoutes);
    await mount();
    expect(byTestId('chat-panel')).toHaveLength(0);

    await rerenderWithRequest({ room: { kind: 'dm', topicId: 'd9', title: 'bob' }, nonce: 1 });

    expect(byTestId('chat-panel')).toHaveLength(1);
    expect(panelProps.current).toMatchObject({ topicId: 'd9' });
  });

  it('CONTRACT: a later request with room: null sends an already-open room back to the list', async () => {
    routeFetch([
      ...defaultRoutes.filter(([p]) => p !== '/api/topics'),
      ['/api/topics', () => json({ topics: [{ id: 't1', title: 'Zoning Law' }] })],
    ]);
    await mount();
    await act(async () => { byTestId('chat-rail-topic-row')[0].click(); });
    expect(byTestId('chat-panel')).toHaveLength(1);

    await rerenderWithRequest({ room: null, nonce: 1 });

    expect(byTestId('chat-panel')).toHaveLength(0);
    expect(text()).toContain('Zoning Law'); // back on the topic list row
  });

  it('CONTRACT: a request also closes the new-conversation picker if it was open', async () => {
    routeFetch([
      ['/api/dm/candidates', () => json({ candidates: [] })],
      ...defaultRoutes,
    ]);
    await mount();
    await act(async () => {
      (container.querySelector('button[aria-label="New conversation"]') as HTMLButtonElement).click();
    });
    await flush();
    expect(text()).toContain('No one to message yet');

    await rerenderWithRequest({ room: { kind: 'topic', topicId: 't2', title: '다른 주제 🏛️' }, nonce: 1 });

    expect(text()).not.toContain('No one to message yet');
    expect(panelProps.current).toMatchObject({ topicId: 't2' });
  });

  it('REPEAT: a second request for the SAME room (new nonce) still re-applies rather than being ignored', async () => {
    routeFetch(defaultRoutes);
    await mount();
    const room = { kind: 'topic' as const, topicId: 't1', title: 'Zoning Law' };

    await rerenderWithRequest({ room, nonce: 1 });
    expect(panelProps.current).toMatchObject({ topicId: 't1' });

    // User backs out to the list client-side (not via a new external request)...
    await act(async () => {
      (container.querySelector('button[aria-label="Back to chat list"]') as HTMLButtonElement).click();
    });
    expect(byTestId('chat-panel')).toHaveLength(0);

    // ...then the SAME entry point is clicked again — nonce advances, room is
    // identical. Without nonce-based re-triggering this would be a no-op
    // (React bails on an unchanged effect dependency) and the room would
    // never reopen.
    await rerenderWithRequest({ room, nonce: 2 });
    expect(byTestId('chat-panel')).toHaveLength(1);
    expect(panelProps.current).toMatchObject({ topicId: 't1' });
  });

  it('MOUNT-UNIQUE still applies to an externally-requested room: suppressed on its own standalone page', async () => {
    pathnameMock.current = '/chat/t1';
    routeFetch(defaultRoutes);
    await mount(() => {}, { room: { kind: 'topic', topicId: 't1', title: 'Zoning Law' }, nonce: 1 });

    expect(byTestId('chat-panel')).toHaveLength(0);
    expect(text()).toContain('already viewing this conversation');
  });

  it('FOCUS: applying a room request moves DOM focus into the rail container', async () => {
    routeFetch(defaultRoutes);
    await mount();
    expect(document.activeElement).not.toBe(container.querySelector('[data-testid="chat-rail"]'));

    await rerenderWithRequest({ room: { kind: 'dm', topicId: 'd9', title: 'bob' }, nonce: 1 });

    expect(document.activeElement).toBe(container.querySelector('[data-testid="chat-rail"]'));
  });

  it('FOCUS: a room: null request (return to list) does not steal focus — nothing to focus INTO', async () => {
    routeFetch([
      ...defaultRoutes.filter(([p]) => p !== '/api/topics'),
      ['/api/topics', () => json({ topics: [{ id: 't1', title: 'Zoning Law' }] })],
    ]);
    await mount();
    await act(async () => { byTestId('chat-rail-topic-row')[0].click(); });
    const rail = container.querySelector('[data-testid="chat-rail"]') as HTMLElement;
    // Focus something else first so we can tell the null-room request left it alone.
    const decoy = document.createElement('button');
    document.body.appendChild(decoy);
    decoy.focus();
    expect(document.activeElement).toBe(decoy);

    await rerenderWithRequest({ room: null, nonce: 1 });

    expect(document.activeElement).not.toBe(rail);
    decoy.remove();
  });
});

describe('room view — inline member list (topic rooms only)', () => {
  const membersRoute = (topicId: string, members: Array<{ userId: string; nickname: string; role: 'owner' | 'admin' | 'member' }>): [string, (url: string) => Response] => [
    `/api/topics/${topicId}/members`,
    () => json({ members }),
  ];

  async function openTopicRoom(topicId = 't1', title = 'Zoning Law') {
    routeFetch([
      ...defaultRoutes.filter(([p]) => p !== '/api/topics'),
      ['/api/topics', () => json({ topics: [{ id: topicId, title }] })],
    ]);
    await mount();
    await act(async () => { byTestId('chat-rail-topic-row')[0].click(); });
  }

  function membersButton(): HTMLButtonElement | null {
    return container.querySelector('button[aria-label="Show members"], button[aria-label="Hide members"]');
  }

  it('CONTRACT: the Members toggle is offered on a topic room', async () => {
    await openTopicRoom();
    expect(membersButton()).not.toBeNull();
  });

  it('CONTRACT: the Members toggle is absent on a DM room', async () => {
    routeFetch([
      ...defaultRoutes.filter(([p]) => p !== '/api/dm'),
      ['/api/dm', () => json({ dms: [{ topicId: 'd1', peer: { userId: 'u1', nickname: 'bob', profileImage: null }, lastActivityAt: null }] })],
    ]);
    await mount();
    await act(async () => { tabButtons()[1].click(); });
    await act(async () => { byTestId('chat-rail-dm-row')[0].click(); });

    expect(membersButton()).toBeNull();
  });

  it('BOUNDARY 1: toggling members fetches and renders exactly one row, over a still-mounted ChatPanel', async () => {
    await openTopicRoom();
    // The members route MUST be listed before the generic `/api/topics` route
    // below — routeFetch matches by prefix, and `/api/topics/t1/members`
    // starts with `/api/topics`, so the general route would otherwise win
    // and hand back `{ topics: [...] }`, whose `.members` is undefined.
    routeFetch([
      membersRoute('t1', [{ userId: 'u1', nickname: 'bob', role: 'member' }]),
      ...defaultRoutes,
    ]);

    await act(async () => { membersButton()!.click(); });
    await flush();

    expect(byTestId('rail-member-row')).toHaveLength(1);
    expect(text()).toContain('bob');
    // The panel stays mounted UNDER the overlay — replacing it would drop the
    // SSE stream and re-run the history fetch on every peek at the members.
    expect(byTestId('chat-panel')).toHaveLength(1);
    expect(panelProps.mountCount).toBe(1);
  });

  it('BOUNDARY many: renders one row per member, with a role tag for non-plain-member roles', async () => {
    await openTopicRoom();
    routeFetch([
      membersRoute('t1', [
        { userId: 'me', nickname: 'me', role: 'owner' },
        { userId: 'u1', nickname: 'bob', role: 'admin' },
        { userId: 'u2', nickname: 'carol', role: 'member' },
      ]),
      ...defaultRoutes,
    ]);

    await act(async () => { membersButton()!.click(); });
    await flush();

    expect(byTestId('rail-member-row')).toHaveLength(3);
    expect(text()).toContain('owner');
    expect(text()).toContain('admin');
  });

  it('EXT-FAILURE: a failed member fetch shows a retry, not an empty list (would misread as "no members")', async () => {
    await openTopicRoom();
    let calls = 0;
    routeFetch([
      [`/api/topics/t1/members`, () => {
        calls += 1;
        return calls === 1 ? json({ error: 'boom' }, false, 500) : json({ members: [{ userId: 'u1', nickname: 'bob', role: 'member' }] });
      }],
      ...defaultRoutes,
    ]);

    await act(async () => { membersButton()!.click(); });
    await flush();
    expect(text()).toContain('Could not load the member list');

    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Try again')!;
    await act(async () => { retry.click(); });
    await flush();

    expect(byTestId('rail-member-row')).toHaveLength(1);
  });

  it('MOUNT-UNIQUE: the member list overlays ChatPanel without ever remounting it', async () => {
    await openTopicRoom();
    routeFetch([
      membersRoute('t1', [{ userId: 'u1', nickname: 'bob', role: 'member' }]),
      ...defaultRoutes,
    ]);

    // The member list is an OVERLAY: the panel stays mounted underneath, so
    // the SSE stream, scroll position and already-decrypted history all
    // survive a glance at the members. Replacing the panel instead would
    // unmount it and re-run the initial fetch on every toggle.
    await act(async () => { membersButton()!.click(); });
    await flush();
    expect(byTestId('chat-panel')).toHaveLength(1);
    expect(panelProps.mountCount).toBe(1);

    await act(async () => { membersButton()!.click(); });
    // Still ONE mount across the whole round trip — never two live panels, and
    // never a throwaway remount either.
    expect(byTestId('chat-panel')).toHaveLength(1);
    expect(panelProps.mountCount).toBe(1);
  });

  it('UTF-8: a Korean + emoji member nickname renders intact', async () => {
    await openTopicRoom();
    const nickname = '김철수 🚀';
    routeFetch([
      membersRoute('t1', [{ userId: 'u1', nickname, role: 'member' }]),
      ...defaultRoutes,
    ]);

    await act(async () => { membersButton()!.click(); });
    await flush();

    expect(text()).toContain(nickname);
  });

  it('leaving the room (back to list) resets the member-list toggle for next time', async () => {
    await openTopicRoom();
    routeFetch([
      membersRoute('t1', [{ userId: 'u1', nickname: 'bob', role: 'member' }]),
      ...defaultRoutes,
    ]);
    await act(async () => { membersButton()!.click(); });
    await flush();
    expect(byTestId('rail-member-row')).toHaveLength(1);

    await act(async () => { (container.querySelector('button[aria-label="Back to chat list"]') as HTMLButtonElement).click(); });
    await act(async () => { byTestId('chat-rail-topic-row')[0].click(); });

    // Back in the room — chat, not the member list, is the default view again.
    expect(byTestId('chat-panel')).toHaveLength(1);
    expect(byTestId('rail-member-row')).toHaveLength(0);
  });
});
