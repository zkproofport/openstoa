// @vitest-environment jsdom
/**
 * A room paints from the device before it asks the server anything.
 *
 * THE COST THIS REMOVES. `paintCache` is a module-level `Map`, so it dies with
 * the page: re-entering a room inside one page load painted in 102ms on
 * staging, and the SAME room after a refresh took 637ms, because nothing could
 * be drawn until `/chat` came back. The durable cache that would have covered
 * it already existed — `backfill` has read and written it since P3-17 — but
 * nothing painted from it, because a cached row held `{id, createdAt,
 * plaintext}` and the renderer needs an author to put a name on a bubble and
 * to decide which side it sits on. `CachedChatMessage` now carries the author,
 * and these are the assertions that keep the wiring wired.
 *
 * WHY THIS FILE EXISTS AT ALL. Both calls go through an optional-call, because
 * a dozen test files swap the store for a partial stand-in and a plain call
 * would crash every one of them on render. That tolerance is correct and it is
 * also a hole: deleting the read or the write entirely would leave every other
 * suite green. So these tests assert the calls HAPPEN, with a store that
 * implements them.
 *
 * EDGE-CASE MATRIX → coverage
 *   contract   → the cached rows are on screen before /chat resolves
 *   contract   → what is rendered is written back, with its author
 *   integrity  → the network reconciles rather than duplicating (id de-dupe)
 *   boundary   → a cache miss paints nothing and breaks nothing
 *   empty      → a row with no author is skipped, not rendered anonymous
 *   hostile    → a store that throws is survived
 *   race       → rows that arrived first are not overwritten by the cache
 *   authz/read → pending, failed and locked rows are never written to disk
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = 'nullifier-me';
/** A fresh topic per test: `paintCache` is module-level and outlives a render. */
let topicSeq = 0;
const nextTopic = () => `11111111-2222-4333-8444-${String(++topicSeq).padStart(12, '0')}`;

/** Held open so the test can assert the paint happened BEFORE the fetch answers. */
let releaseChat: (rows: unknown[]) => void;
let chatPromise: Promise<unknown[]>;

const readHistoryCache = vi.fn();
/** Typed, so `mock.calls` is a real tuple and the assertions need no cast. */
const writeHistoryCache = vi.fn(
  async (_topicId: string, _rows: Record<string, unknown>[]): Promise<void> => {},
);

const takStore = {
  readHistoryCache,
  writeHistoryCache,
  backfill: vi.fn(async () => []),
  myDeviceId: vi.fn(async () => 'device-1'),
  distributeRoot: vi.fn(async () => 0),
  distributeRootWhenGroupChanged: vi.fn(async () => 0),
  grantPrivateHistory: vi.fn(async () => {}),
  sealForPush: vi.fn(async () => null),
  takForPush: vi.fn(async () => null),
  archiveOnSend: vi.fn(async () => {}),
  archiveRootState: vi.fn(async () => 'verified'),
  backfillMissingArchive: vi.fn(async () => 0),
  forgetUnsettledRoot: vi.fn(() => {}),
  sealMedia: vi.fn(async () => null),
  openMedia: vi.fn(async () => ({ ok: false as const, reason: 'no-key' as const })),
};

const mlsStore = {
  openCached: vi.fn(async (_t: string, _id: string, s: { ciphertext: string }) =>
    s.ciphertext ? s.ciphertext.replace(/^ct-/, '') : null,
  ),
  open: vi.fn(async () => null),
  seal: vi.fn(async (_t: string, p: string) => ({ ciphertext: `ct-${p}`, epoch: 0 })),
  cachePlaintext: vi.fn(async () => {}),
};

vi.mock('@/lib/mls/webTransport', () => ({
  getMlsSessionStore: () => mlsStore,
  getTakSessionStore: () => takStore,
  getDeviceKeyState: async () => 'ready',
  recoverDeviceWithPasskey: async () => true,
}));

const { default: ChatPanel } = await import('@/components/ChatPanel');
const { I18nProvider } = await import('@/lib/i18n/I18nProvider');

class FakeEventSource {
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener(t: string, fn: (e: { data: string }) => void) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  }
  close() {}
}

function json(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function cached(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `m${n}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    plaintext: `cached body ${n}`,
    userId: 'nullifier-other',
    nickname: 'alice',
    type: 'message',
    ...over,
  };
}

function wire(n: number) {
  return {
    id: `m${n}`,
    topicId: 'x',
    userId: 'nullifier-other',
    nickname: 'alice',
    type: 'message',
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    message: null,
    sealed: { ciphertext: `ct-network body ${n}`, epoch: 0 },
  };
}

/** False when `/api/auth/session` must hang, so a test can prove independence. */
let sessionAnswers = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  sessionAnswers = true;
  localStorage.clear();
  // jsdom has no layout engine and no `scrollTo`; the panel's `scrollToBottom`
  // calls it on the scroller after every paint. Counting is not what this file
  // measures — it only has to exist. Same stub `chatPanel-sync` installs.
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = function scrollTo() {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  readHistoryCache.mockResolvedValue(null);
  chatPromise = new Promise((res) => {
    releaseChat = res;
  });
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/session') {
        // A lookup that never resolves models the reload where the panel used
        // to sit blank waiting for it.
        if (!sessionAnswers) return new Promise<Response>(() => {});
        return json({ userId: ME });
      }
      if (/^\/api\/topics\/[^/?]+$/.test(url)) {
        return json({ topic: { visibility: 'public' }, currentUserRole: 'member' });
      }
      if (/^\/api\/topics\/[^/]+\/chat\?/.test(url)) {
        return json({ messages: await chatPromise });
      }
      return json({});
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/**
 * Mount from a FRESH module graph.
 *
 * `cachedUserId` is a module variable that deliberately outlives a panel — one
 * session lookup per page, not per room — so any earlier test that resolved it
 * leaves the gate open and a test about the gate asserting nothing. Both the
 * panel and the provider come from the same fresh graph, because React context
 * identity is per module instance.
 */
async function mountFresh(topicId: string) {
  vi.resetModules();
  const { default: FreshChatPanel } = await import('@/components/ChatPanel');
  const { I18nProvider: FreshI18nProvider } = await import('@/lib/i18n/I18nProvider');
  await act(async () => {
    root.render(
      <FreshI18nProvider initialLocale="en">
        <FreshChatPanel topicId={topicId} isGuest={false} isMember />
      </FreshI18nProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(topicId: string) {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <ChatPanel topicId={topicId} isGuest={false} isMember />
      </I18nProvider>,
    );
  });
  // Let the cache read's microtasks settle without resolving the fetch.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('CONTRACT: the device paints first', () => {
  it('cached rows are on screen while /chat is still in flight', async () => {
    const topic = nextTopic();
    readHistoryCache.mockResolvedValue({ messages: [cached(1), cached(2)], cursor: null });

    await mount(topic);

    expect(readHistoryCache).toHaveBeenCalledWith(topic);
    // The assertion that matters: this runs before `releaseChat` is called.
    expect(container.textContent).toContain('cached body 1');
    expect(container.textContent).toContain('cached body 2');
  });

  it('INTEGRITY: the network reconciles the same ids rather than doubling them', async () => {
    const topic = nextTopic();
    readHistoryCache.mockResolvedValue({ messages: [cached(1), cached(2)], cursor: null });
    await mount(topic);

    await act(async () => {
      releaseChat([wire(1), wire(2), wire(3)]);
      await chatPromise;
      await Promise.resolve();
    });

    const rows = container.textContent ?? '';
    // m1 and m2 appear once each; the body may be either copy, but not both.
    expect((rows.match(/body 1/g) ?? []).length).toBe(1);
    expect((rows.match(/body 2/g) ?? []).length).toBe(1);
    expect(rows).toContain('network body 3');
  });

  it('RACE: rows already in state are not replaced by a slower cache read', async () => {
    const topic = nextTopic();
    let releaseCache: (v: unknown) => void = () => {};
    readHistoryCache.mockReturnValue(
      new Promise((res) => {
        releaseCache = res;
      }),
    );
    await mount(topic);
    await act(async () => {
      releaseChat([wire(9)]);
      await chatPromise;
      await Promise.resolve();
    });
    await act(async () => {
      releaseCache({ messages: [cached(1)], cursor: null });
      await Promise.resolve();
    });
    expect(container.textContent).toContain('network body 9');
    expect(container.textContent).not.toContain('cached body 1');
  });
});

describe('CONTRACT: the list is drawable on the first paint', () => {
  /*
   * The gate that made the whole cache pointless.
   *
   * The panel refuses to draw ANY row until it knows the reader's own id —
   * correctly, since a bubble whose side is unknown would open under someone
   * else's name and then slide across the panel. But that id lived only in a
   * module variable, so a reload waited on `/api/auth/session` before it could
   * render anything. Measured on staging: the archive cache was read and
   * complete at 59ms, and the first row appeared at 380ms, exactly when that
   * request returned. Caching the history and not the id bought nothing.
   */
  it('a remembered id lets cached rows paint without waiting for /api/auth/session', async () => {
    const topic = nextTopic();
    // The one key `Header` has always used — not a second store beside it.
    localStorage.setItem('os-session', JSON.stringify({ userId: ME }));
    readHistoryCache.mockResolvedValue({ messages: [cached(1)], cursor: null });
    // The session lookup never answers, which is the point: if the panel still
    // paints, it is not waiting on it.
    sessionAnswers = false;

    await mountFresh(topic);

    expect(
      container.textContent,
      'the room waited for the session lookup even though the id was known',
    ).toContain('cached body 1');
  });

  it('without a remembered id the room still waits, rather than guessing a side', async () => {
    const topic = nextTopic();
    localStorage.clear();
    readHistoryCache.mockResolvedValue({ messages: [cached(1)], cursor: null });
    sessionAnswers = false;

    await mountFresh(topic);

    // Drawing here is the defect the gate exists to prevent — a bubble under
    // the wrong name that jumps sides when the answer arrives.
    expect(container.textContent).not.toContain('cached body 1');
  });

  it('the id is written back once the lookup does answer', async () => {
    const topic = nextTopic();
    localStorage.clear();
    await mountFresh(topic);
    await act(async () => {
      releaseChat([wire(1)]);
      await chatPromise;
      await Promise.resolve();
    });
    const stored = JSON.parse(localStorage.getItem('os-session') ?? 'null');
    expect(stored?.userId, 'the shared session cache was not written').toBe(ME);
  });
});

describe('CONTRACT: what is rendered is written back', () => {
  it('writes the rows with their author attached', async () => {
    const topic = nextTopic();
    await mount(topic);
    await act(async () => {
      releaseChat([wire(1)]);
      await chatPromise;
      await Promise.resolve();
    });

    expect(writeHistoryCache).toHaveBeenCalled();
    const [calledTopic, rows] = writeHistoryCache.mock.calls.at(-1)!;
    expect(calledTopic).toBe(topic);
    const row = rows.find((r) => r.id === 'm1');
    expect(row, 'the rendered row was not written').toBeDefined();
    // An author is the whole reason the format changed: without it the next
    // visit can restore bodies but not bubbles.
    expect(row!.nickname).toBe('alice');
    expect(row!.userId).toBe('nullifier-other');
    expect(row!.plaintext).toBe('network body 1');
  });

  it('AUTHZ/READ: a row that cannot be opened is never written to disk', async () => {
    const topic = nextTopic();
    mlsStore.openCached.mockResolvedValueOnce(null);
    await mount(topic);
    await act(async () => {
      releaseChat([wire(1)]);
      await chatPromise;
      await Promise.resolve();
    });
    for (const [, rows] of writeHistoryCache.mock.calls) {
      expect(rows.some((r) => r.id === 'm1')).toBe(false);
    }
  });
});

describe('EMPTY, BOUNDARY and HOSTILE', () => {
  it('a cache miss paints nothing and breaks nothing', async () => {
    const topic = nextTopic();
    readHistoryCache.mockResolvedValue(null);
    await mount(topic);
    expect(container.textContent).not.toContain('cached body');
    await act(async () => {
      releaseChat([wire(1)]);
      await chatPromise;
      await Promise.resolve();
    });
    expect(container.textContent).toContain('network body 1');
  });

  it('an empty cached room is treated as a miss', async () => {
    const topic = nextTopic();
    readHistoryCache.mockResolvedValue({ messages: [], cursor: null });
    await mount(topic);
    expect(container.textContent).not.toContain('cached body');
  });

  it('a cached row with no author is skipped rather than rendered anonymous', async () => {
    const topic = nextTopic();
    readHistoryCache.mockResolvedValue({
      messages: [cached(1, { nickname: undefined }), cached(2, { userId: undefined }), cached(3)],
      cursor: null,
    });
    await mount(topic);
    expect(container.textContent).not.toContain('cached body 1');
    expect(container.textContent).not.toContain('cached body 2');
    expect(container.textContent).toContain('cached body 3');
  });

  it('a store that throws on read is survived', async () => {
    const topic = nextTopic();
    readHistoryCache.mockRejectedValue(new Error('idb gone'));
    await mount(topic);
    await act(async () => {
      releaseChat([wire(1)]);
      await chatPromise;
      await Promise.resolve();
    });
    expect(container.textContent).toContain('network body 1');
  });

  it('a store that rejects on write never reaches the reader', async () => {
    const topic = nextTopic();
    writeHistoryCache.mockRejectedValue(new Error('quota'));
    await mount(topic);
    await act(async () => {
      releaseChat([wire(1)]);
      await chatPromise;
      await Promise.resolve();
    });
    expect(container.textContent).toContain('network body 1');
    writeHistoryCache.mockResolvedValue(undefined);
  });
});
