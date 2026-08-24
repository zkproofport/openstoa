/**
 * The room paints from the device before the network answers.
 *
 * WHAT WAS MISSING. The archive cache has existed since P3-17 — `backfill`
 * reads and writes it on every entry, and the double in `chatRoomMarksRead`
 * even documents it as "the room reads its own snapshot before it asks the
 * network for anything". Nothing painted from it. `useInfiniteQuery` here is
 * pinned to `staleTime: 0, refetchOnMount: 'always'` for a real reason (a
 * just-sent message lives only in `liveMessages`, and a served-stale page loses
 * it), so a relaunched app had NOTHING to draw until `/chat` came back.
 *
 * The reason it was never wired: a cached row held `{id, createdAt, plaintext}`
 * and a bubble needs an author — a name to show and a side to sit on. The
 * record now carries one, and these assertions are what keep the wiring wired:
 * both calls go through an optional-call so the many partial store doubles do
 * not crash on render, and that same tolerance would hide a deleted call.
 *
 * EDGE-CASE MATRIX → coverage
 *   contract   → cached rows are read on entry and rendered
 *   contract   → what was rendered is written back, with its author
 *   integrity  → a row that also arrives from the network appears once
 *   empty      → a miss, and an empty cached room, paint nothing
 *   empty      → a cached row with no author is skipped, not shown anonymous
 *   boundary   → a bodiless row (a join notice) is never stored
 *   hostile    → a store that throws on read or write still renders the room
 *   authz/read → locked rows are never written to disk
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react-test-renderer';
import { renderScreen } from './harness/screen';

const TOPIC = '11111111-2222-4333-8444-555555555555';
const OTHER = 'nullifier-other';

const missingStoreMethods: string[] = [];

function storeDouble(methods: Record<string, (...args: never[]) => unknown>) {
  return new Proxy(methods, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return (...args: never[]) => {
        missingStoreMethods.push(prop);
        void args;
        return Promise.resolve(null);
      };
    },
  });
}

/*
 * Opens `ct-<body>` into `<body>`, and refuses anything else.
 *
 * On mobile a body ONLY ever comes out of the store: `toDisplayMessageMls`
 * never reads `raw.message`, so a "plaintext wire row" is not a thing that
 * exists here — a row is sealed and opened, or it is locked. A double that
 * always refused could not tell a row that came from the network apart from one
 * that came from the cache, which is exactly what these tests compare.
 */
const mlsDouble = storeDouble({
  openCached: async (_t: never, _id: never, sealed: never) => {
    const ct = (sealed as unknown as { ciphertext?: string } | null)?.ciphertext;
    return ct?.startsWith('ct-') ? ct.slice(3) : null;
  },
  open: async () => null,
  seal: async () => ({ ciphertext: 'ct', epoch: 0 }),
  cachePlaintext: async () => {},
  reconcileMembership: async () => {},
});

const readHistoryCache = vi.fn(async (_topicId: string) => cachedHistory);
const writeHistoryCache = vi.fn(
  async (_topicId: string, _rows: Record<string, unknown>[]): Promise<void> => {},
);

const takDouble = storeDouble({
  backfill: async () => [],
  myDeviceId: async () => 'device-1',
  publicRootFingerprint: async () => null,
  archiveRootState: async () => null,
  distributeRootWhenGroupChanged: async () => {},
  grantPrivateHistory: async () => {},
  backfillMissingArchive: async () => {},
  takForPush: async () => null,
  forgetUnsettledRoot: () => {},
  sealForPush: async () => null,
  archiveOnSend: async () => {},
  readHistoryCache: (t: string) => readHistoryCache(t),
  writeHistoryCache: (t: string, rows: Record<string, unknown>[]) => writeHistoryCache(t, rows),
});

vi.mock('../crypto/mobileTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto/mobileTransport')>();
  return { ...actual, getMlsSessionStore: () => mlsDouble, getTakSessionStore: () => takDouble };
});

const { ChatRoomScreen } = await import('../screens/chat/ChatRoomScreen');

function at(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

/** A row as the cache stores it, author included. */
function cachedRow(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `m${n}`,
    createdAt: at(n * 10),
    plaintext: `cached body ${n}`,
    userId: OTHER,
    nickname: 'other',
    type: 'message',
    ...over,
  };
}

/** A row as the wire carries it: sealed, which the double above opens. */
function wireRow(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `m${n}`,
    topicId: TOPIC,
    userId: OTHER,
    nickname: 'other',
    type: 'message',
    createdAt: at(n * 10),
    message: null,
    sealed: { ciphertext: `ct-network body ${n}`, epoch: 0 },
    ...over,
  };
}

/** True when `/chat` must hang, so a test can prove the cache stands alone. */
let chatNeverAnswers = false;
let cachedHistory: { messages: Record<string, unknown>[]; cursor: null } | null = null;
let history: Record<string, unknown>[] = [];

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function enterRoom() {
  const { rendered } = await renderScreen(<ChatRoomScreen />);
  await settle();
  return rendered;
}

/** Every string the tree currently renders. */
function textOf(rendered: { root: { findAll: (p: (n: unknown) => boolean) => unknown[] } }): string {
  const nodes = rendered.root.findAll(() => true) as { children?: unknown[] }[];
  const out: string[] = [];
  for (const n of nodes) {
    for (const c of n.children ?? []) if (typeof c === 'string') out.push(c);
  }
  return out.join(' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  missingStoreMethods.length = 0;
  cachedHistory = null;
  chatNeverAnswers = false;
  history = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (chatNeverAnswers && url.includes('/chat?')) return new Promise<Response>(() => {});
      const body = url.includes('/chat/media')
        ? { ciphertext: '' }
        : url.includes('/chat')
          ? { messages: history, total: history.length }
          : { messages: [], total: 0, topic: { visibility: 'public' }, members: [] };
      return { ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CONTRACT: the device is read before the network', () => {
  it('reads the cache on entry and renders what it holds', async () => {
    cachedHistory = { messages: [cachedRow(1), cachedRow(2)], cursor: null };
    const rendered = await enterRoom();

    expect(readHistoryCache).toHaveBeenCalledWith(TOPIC);
    const text = textOf(rendered);
    expect(text).toContain('cached body 1');
    expect(text).toContain('cached body 2');
    expect(missingStoreMethods, 'the screen reached for an unmodelled method').toEqual([]);
    rendered.unmount();
  });

  it('a cache that answers LATE still reaches the screen', async () => {
    /*
     * The dependency-array case, and it needs its own arrangement.
     *
     * `allMessages` is a `useMemo`; leaving `cachedMessages` out of its
     * dependencies is a silent failure — the rows land in state and the list
     * never recomputes. Every other test here misses it, because the mount
     * settles through several unrelated state changes and any one of them
     * re-runs the memo anyway. So this one lets everything else finish FIRST
     * and only then resolves the cache, which is also the real shape of the
     * race: a disk read that loses to the network.
     */
    let release: (v: { messages: Record<string, unknown>[]; cursor: null }) => void = () => {};
    readHistoryCache.mockReturnValueOnce(
      new Promise((res) => {
        release = res;
      }) as ReturnType<typeof readHistoryCache>,
    );
    history = [wireRow(9)];

    const rendered = await enterRoom();
    expect(textOf(rendered)).not.toContain('cached body 1');

    await act(async () => {
      release({ messages: [cachedRow(1)], cursor: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      textOf(rendered),
      'the cached rows never reached the list — check the memo dependencies',
    ).toContain('cached body 1');
    rendered.unmount();
  });

  it('INTEGRITY: a row that also arrives from the network is rendered once', async () => {
    cachedHistory = { messages: [cachedRow(1)], cursor: null };
    history = [wireRow(1), wireRow(2)];
    const rendered = await enterRoom();

    const text = textOf(rendered);
    // The live source wins the first-wins de-dupe; either way, not both.
    expect((text.match(/body 1/g) ?? []).length).toBe(1);
    expect(text).toContain('network body 2');
    rendered.unmount();
  });
});

describe('CONTRACT: the network is not a precondition', () => {
  /*
   * The web needed a second fix for this — its panel refuses to draw until
   * `/api/auth/session` names the reader, so a cached room still waited a round
   * trip. The mini-app does not: `useOpenStoaSession` already holds the signed-in
   * id locally, so `isOwn` is knowable on the first frame. This asserts that
   * difference rather than assuming it, because it is the whole reason the cache
   * pays off here without the extra machinery.
   */
  it('cached rows render while /chat never answers at all', async () => {
    cachedHistory = { messages: [cachedRow(1), cachedRow(2)], cursor: null };
    chatNeverAnswers = true;

    const rendered = await enterRoom();

    const text = textOf(rendered);
    expect(text, 'the room waited for the network it did not need').toContain('cached body 1');
    expect(text).toContain('cached body 2');
    rendered.unmount();
  });
});

describe('CONTRACT: what was rendered is written back', () => {
  it('writes rows with their author attached', async () => {
    history = [wireRow(1)];
    const rendered = await enterRoom();

    expect(writeHistoryCache).toHaveBeenCalled();
    const [topicId, rows] = writeHistoryCache.mock.calls.at(-1)!;
    expect(topicId).toBe(TOPIC);
    const row = rows.find((r) => r.id === 'm1');
    expect(row, 'the rendered row was not written').toBeDefined();
    expect(row!.nickname).toBe('other');
    expect(row!.userId).toBe(OTHER);
    expect(row!.plaintext).toBe('network body 1');
    rendered.unmount();
  });

  it('BOUNDARY: a bodiless row is never stored', async () => {
    // A join notice has no message at all. Storing one restores an empty bubble.
    history = [wireRow(1), wireRow(2, { type: 'join', message: null, sealed: null })];
    const rendered = await enterRoom();

    for (const [, rows] of writeHistoryCache.mock.calls) {
      expect(rows.some((r) => r.id === 'm2')).toBe(false);
      for (const r of rows) expect(typeof r.plaintext).toBe('string');
    }
    rendered.unmount();
  });

  it('AUTHZ/READ: a locked row is never written to disk', async () => {
    // `unopenable-` does not match the double's prefix, so it stays locked.
    history = [wireRow(1, { sealed: { ciphertext: 'unopenable-m1', epoch: 0 } })];
    const rendered = await enterRoom();

    for (const [, rows] of writeHistoryCache.mock.calls) {
      expect(rows.some((r) => r.id === 'm1')).toBe(false);
    }
    rendered.unmount();
  });
});

describe('EMPTY and HOSTILE', () => {
  it('a cache miss paints nothing and breaks nothing', async () => {
    cachedHistory = null;
    history = [wireRow(1)];
    const rendered = await enterRoom();
    expect(textOf(rendered)).toContain('network body 1');
    rendered.unmount();
  });

  it('an empty cached room is treated as a miss', async () => {
    cachedHistory = { messages: [], cursor: null };
    const rendered = await enterRoom();
    expect(textOf(rendered)).not.toContain('cached body');
    rendered.unmount();
  });

  it('a cached row with no author is skipped rather than shown anonymous', async () => {
    cachedHistory = {
      messages: [cachedRow(1, { nickname: undefined }), cachedRow(2, { userId: undefined }), cachedRow(3)],
      cursor: null,
    };
    const rendered = await enterRoom();
    const text = textOf(rendered);
    expect(text).not.toContain('cached body 1');
    expect(text).not.toContain('cached body 2');
    expect(text).toContain('cached body 3');
    rendered.unmount();
  });

  it('a store that throws on read still renders the room', async () => {
    readHistoryCache.mockRejectedValueOnce(new Error('store gone'));
    history = [wireRow(1)];
    const rendered = await enterRoom();
    expect(textOf(rendered)).toContain('network body 1');
    rendered.unmount();
  });

  it('a store that rejects on write still renders the room', async () => {
    writeHistoryCache.mockRejectedValue(new Error('quota'));
    history = [wireRow(1)];
    const rendered = await enterRoom();
    expect(textOf(rendered)).toContain('network body 1');
    writeHistoryCache.mockResolvedValue(undefined);
    rendered.unmount();
  });
});
