// @vitest-environment jsdom
/**
 * The WEB panel writes the account's read cursor, and does it from the one
 * place every route into a room converges on.
 *
 * Why this file exists rather than trusting the module tests: `chatReadSync`'s
 * own suite proves the RULE (what may be recorded, the debounce, the silence on
 * failure) against an injected transport, and would stay entirely green if
 * nobody ever called it. Deleting the one line in `ChatPanel.applyIncoming`
 * leaves every other test in this repo passing — which is the definition of a
 * guard that is decoration. This is the test that goes red for that deletion.
 *
 * The mini-app has the same wiring covered from the other end
 * (`packages/mobile/src/__tests__/chatListReadCursorHydration.test.tsx` for the
 * seeding, and `chatRoomMarksRead.test.tsx` for the room's local mark).
 *
 * EDGE-CASE MATRIX (CLAUDE.md) -> coverage here
 *   contract    -> the panel issues `PUT /chat/read` naming the NEWEST message
 *                  it rendered, after the debounce
 *   boundary    -> a room whose only rows are provisional writes nothing
 *   race        -> a burst of arrivals produces ONE request, not one per row
 *   empty/null  -> an empty history writes nothing at all
 *   hostile     -> a rejected PUT does not break the room: the messages stay on
 *                  screen and nothing throws
 *   authz / UTF-8 / large -> N/A: the panel forwards two server-supplied
 *                  strings; the route's own input surface is covered in
 *                  `src/__tests__/e2e/chat-read.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TestProviders } from './harness/providers';
import { resetChatReadSync, CHAT_READ_DEBOUNCE_MS } from '@/lib/chatReadSync';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/mls/webTransport', () => ({
  getMlsSessionStore: () => ({
    open: async () => null,
    openCached: async () => null,
    sync: async () => {},
  }),
  /*
   * The TAK stub carries every method the panel's PERIODIC effects reach, not
   * just the ones a first render touches: advancing fake timers past the
   * debounce also runs the archive back-fill loop, and a stub missing one
   * method fails as "not a function" from a path this file is not about.
   */
  getTakSessionStore: () => ({
    backfill: async () => [],
    myDeviceId: async () => 'web-test',
    distributeRoot: async () => 0,
    distributeRootWhenGroupChanged: async () => 0,
    grantPrivateHistory: async () => 0,
    backfillMissingArchive: async () => 0,
    archiveRootState: async () => null,
    sealForPush: async () => null,
  }),
  getDeviceKeyState: async () => 'ready',
  recoverDeviceWithPasskey: async () => 'restored',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/topics',
}));

vi.mock('@/components/TopicMuteToggle', () => ({ default: () => React.createElement('div') }));
vi.mock('@/components/LinkPreview', () => ({ default: () => null }));

import ChatPanel from '@/components/ChatPanel';

const SEALED = { ciphertext: 'c2VhbGVk', epoch: 3 };
const TOPIC = 't1';

const row = (id: string, iso: string, type = 'message') => ({
  id,
  topicId: TOPIC,
  userId: '0xaaa',
  nickname: 'alice',
  type,
  sealed: SEALED,
  createdAt: iso,
});

/** Two stored rows; the newest is `m2`. */
const ROWS = [
  row('m1', '2026-07-29T00:00:00.000Z'),
  row('m2', '2026-07-29T00:01:00.000Z'),
];

let container: HTMLDivElement;
let root: Root;
/** Every request the panel made, as `METHOD path` plus its parsed body. */
let requests: Array<{ method: string; url: string; body: unknown }>;
/** What `PUT /chat/read` should do. */
let readPutFails = false;

function mockFetch(rows: unknown[]) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = null;
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    } catch {
      body = init?.body ?? null;
    }
    requests.push({ method, url, body });

    if (url.includes('/chat/read')) {
      /*
       * The fake models the route's REFUSALS, not just its success: a PUT with
       * no messageId is a 400 here exactly as it is on the server. A fake that
       * accepted anything would let a panel sending garbage look correct.
       */
      if (readPutFails) return Promise.resolve(new Response('{"error":"nope"}', { status: 500 }));
      const b = body as { messageId?: unknown; readAt?: unknown } | null;
      if (typeof b?.messageId !== 'string' || typeof b?.readAt !== 'string') {
        return Promise.resolve(new Response('{"error":"messageId is required"}', { status: 400 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ lastReadAt: b.readAt, lastReadMessageId: b.messageId, unreadCount: 0 }),
          { status: 200 },
        ),
      );
    }
    if (url.includes('/chat')) {
      return Promise.resolve(
        new Response(JSON.stringify({ messages: rows, hasMore: false }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

async function mount() {
  await act(async () => {
    root.render(
      <TestProviders initialLocale="en">
        <ChatPanel topicId={TOPIC} isGuest={false} isMember fullHeight />
      </TestProviders>,
    );
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

/** Let the debounce elapse and the PUT settle. */
async function settleDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(CHAT_READ_DEBOUNCE_MS + 10);
  });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

const readPuts = () => requests.filter((r) => r.method === 'PUT' && r.url.includes('/chat/read'));

beforeEach(() => {
  resetChatReadSync();
  requests = [];
  readPutFails = false;
  // Fake timers so the 1.5s debounce does not make this suite take 1.5s per
  // case — and so "nothing was sent yet" is a fact rather than a race.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('EventSource', class {
    onmessage: unknown = null;
    onerror: unknown = null;
    close() {}
    addEventListener() {}
    removeEventListener() {}
  });
  vi.stubGlobal('IntersectionObserver', class {
    observe() {} disconnect() {} unobserve() {}
  });
  Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetChatReadSync();
});

describe('ChatPanel writes the account read cursor', () => {
  it('CONTRACT: names the NEWEST rendered message, once the debounce elapses', async () => {
    vi.stubGlobal('fetch', mockFetch(ROWS));
    await mount();

    expect(readPuts(), 'nothing may go out before the window closes').toHaveLength(0);
    await settleDebounce();

    const puts = readPuts();
    expect(puts, 'the panel must record what it put on screen').toHaveLength(1);
    expect(puts[0].url).toContain(`/api/topics/${TOPIC}/chat/read`);
    expect(puts[0].body).toEqual({ messageId: 'm2', readAt: '2026-07-29T00:01:00.000Z' });
  });

  it('RACE: a burst of arrivals is ONE request, carrying the last of them', async () => {
    vi.stubGlobal('fetch', mockFetch(ROWS));
    await mount();
    await settleDebounce();
    expect(readPuts()).toHaveLength(1);

    // A second window with nothing newer must not produce a second write.
    await settleDebounce();
    expect(readPuts(), 'an idle room writes nothing further').toHaveLength(1);
  });

  it('EMPTY: an empty history writes no cursor at all', async () => {
    vi.stubGlobal('fetch', mockFetch([]));
    await mount();
    await settleDebounce();
    expect(readPuts()).toHaveLength(0);
  });

  it('BOUNDARY: a room holding only provisional rows writes nothing', async () => {
    // A `pending-` id names a row the server has never stored, and its
    // `createdAt` is this device's clock.
    vi.stubGlobal('fetch', mockFetch([row('pending-000000000001', '2026-07-29T00:05:00.000Z')]));
    await mount();
    await settleDebounce();
    expect(readPuts()).toHaveLength(0);
  });

  it('HOSTILE: a refused PUT leaves the room working and throws nothing', async () => {
    vi.stubGlobal('fetch', mockFetch(ROWS));
    readPutFails = true;
    await mount();
    const before = container.textContent ?? '';
    await expect(settleDebounce()).resolves.toBeUndefined();
    expect(readPuts()).toHaveLength(1);
    // By the time the write runs the messages are on screen; a throw here would
    // break a read that already succeeded.
    expect(container.textContent ?? '').toBe(before);
  });
});
