/**
 * The device-local history cache — matrix rows named per case.
 *
 * The defect this closes is invisible by construction: every room re-downloaded
 * its whole archive and re-decrypted every row on entry, and because the result
 * was CORRECT no test and no error could see it. So these cases assert the
 * bounds and the ordering, and the wiring test asserts the thing that actually
 * regressed — that the cache is consulted at all.
 *
 * N/A rows: authorization (this store is device-local and holds one account's
 * own plaintext; the isolation that does matter here is BETWEEN ROOMS, which
 * SCOPE covers).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  readChatHistory,
  writeChatHistory,
  cursorFrom,
  utf8Length,
  CHAT_HISTORY_CACHE_ROOM_BYTES,
  CHAT_HISTORY_CACHE_MAX_BYTES,
  type CachedChatMessage,
  type ChatHistoryStore,
} from '../../packages/mls/src/chatHistoryCache';

class MemStore implements ChatHistoryStore {
  map = new Map<string, string>();
  failOn: 'none' | 'get' | 'set' = 'none';
  async get(k: string) {
    if (this.failOn === 'get') throw new Error('storage unavailable');
    return this.map.get(k) ?? null;
  }
  async set(k: string, v: string) {
    if (this.failOn === 'set') throw new Error('disk full');
    this.map.set(k, v);
  }
}

let store: MemStore;
beforeEach(() => {
  store = new MemStore();
});

function msg(n: number, over: Partial<CachedChatMessage> = {}): CachedChatMessage {
  return {
    id: `m${String(n).padStart(6, '0')}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    plaintext: `body ${n}`,
    ...over,
  };
}
const many = (n: number) => Array.from({ length: n }, (_, i) => msg(i + 1));

// ---------------------------------------------------------------------------
describe('BOUNDARY: the per-room byte budget', () => {
  /** A message whose serialized cost is close to `bytes`. */
  const sized = (n: number, bytes: number) => msg(n, { plaintext: 'x'.repeat(bytes) });

  it.each([1, 10, 500])('keeps all %i messages when they fit', async (n) => {
    await writeChatHistory(store, 't1', many(n), null);
    expect((await readChatHistory(store, 't1'))!.messages).toHaveLength(n);
  });

  it('keeps FAR more short messages than long ones — the point of budgeting by size', async () => {
    const shortRoom = Array.from({ length: 4000 }, (_, i) => sized(i + 1, 20));
    const longRoom = Array.from({ length: 4000 }, (_, i) => sized(i + 1, 8_000));
    await writeChatHistory(store, 'short', shortRoom, null);
    await writeChatHistory(store, 'long', longRoom, null);

    const shortKept = (await readChatHistory(store, 'short'))!.messages.length;
    const longKept = (await readChatHistory(store, 'long'))!.messages.length;
    // A message-count cap would have kept the same number in both.
    expect(shortKept).toBeGreaterThan(longKept * 10);
  });

  it('BOUNDARY: a room stays under the per-room ceiling', async () => {
    await writeChatHistory(store, 't1', Array.from({ length: 3000 }, (_, i) => sized(i + 1, 500)), null);
    expect(utf8Length(store.map.get('chatHistory/v1/t1')!)).toBeLessThanOrEqual(
      CHAT_HISTORY_CACHE_ROOM_BYTES,
    );
  });

  it('INTEGRITY: trimming drops the OLDEST, never the newest', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => sized(i + 1, 500));
    await writeChatHistory(store, 't1', rows, null);
    const got = await readChatHistory(store, 't1');
    // Opening a room on old text and then jumping is the failure this prevents.
    expect(got!.messages[got!.messages.length - 1].id).toBe(rows[rows.length - 1].id);
    expect(got!.messages.length).toBeLessThan(rows.length);
  });

  it('BOUNDARY: one message larger than the whole room budget is still kept', async () => {
    // Refusing it would re-fetch the entire archive on every entry, and would do
    // so for exactly the rooms whose messages cost the most to fetch.
    await writeChatHistory(store, 't1', [sized(1, CHAT_HISTORY_CACHE_ROOM_BYTES * 2)], null);
    expect((await readChatHistory(store, 't1'))!.messages).toHaveLength(1);
  });

  it('writing nothing leaves no room behind', async () => {
    await writeChatHistory(store, 't1', [], null);
    expect(await readChatHistory(store, 't1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('utf8Length — the budget must not favour English', () => {
  it.each([
    ['ascii', 'hello', 5],
    ['empty', '', 0],
    ['Korean', '안녕', 6],
    ['Japanese', '日本語', 9],
    ['emoji (surrogate pair)', '🌟', 4],
    ['two-byte latin', 'é', 2],
    ['mixed', 'a안🌟', 8],
  ])('%s', (_label, input, expected) => {
    expect(utf8Length(input as string)).toBe(expected as number);
  });

  it('a Korean room is not silently given three times the disk', async () => {
    // String.length would count these as one unit each and undercount threefold.
    const korean = Array.from({ length: 3000 }, (_, i) =>
      msg(i + 1, { plaintext: '안'.repeat(300) }),
    );
    await writeChatHistory(store, 'ko', korean, null);
    expect(utf8Length(store.map.get('chatHistory/v1/ko')!)).toBeLessThanOrEqual(
      CHAT_HISTORY_CACHE_ROOM_BYTES,
    );
  });
});

// ---------------------------------------------------------------------------
describe('INTEGRITY: order and identity', () => {
  it('returns messages oldest-first regardless of input order', async () => {
    await writeChatHistory(store, 't1', [msg(3), msg(1), msg(2)], null);
    const got = await readChatHistory(store, 't1');
    expect(got!.messages.map((m) => m.id)).toEqual([msg(1).id, msg(2).id, msg(3).id]);
  });

  it('a repeated id appears once, and the LAST copy wins', async () => {
    // The caller merges fresh rows onto cached ones; the fresh copy is the one
    // that just came off the wire.
    const stale = msg(1, { plaintext: 'stale' });
    const fresh = msg(1, { plaintext: 'fresh' });
    await writeChatHistory(store, 't1', [stale, fresh], null);
    const got = await readChatHistory(store, 't1');
    expect(got!.messages).toHaveLength(1);
    expect(got!.messages[0].plaintext).toBe('fresh');
  });

  it('BOUNDARY: two messages sharing an instant keep a total, stable order', async () => {
    const at = new Date(Date.UTC(2026, 0, 1)).toISOString();
    const a = { id: 'aaa', createdAt: at, plaintext: 'A' };
    const b = { id: 'bbb', createdAt: at, plaintext: 'B' };
    await writeChatHistory(store, 't1', [b, a], null);
    expect((await readChatHistory(store, 't1'))!.messages.map((m) => m.id)).toEqual(['aaa', 'bbb']);
  });
});

// ---------------------------------------------------------------------------
describe('SCOPE: one room never reads another room', () => {
  it('keeps rooms apart', async () => {
    await writeChatHistory(store, 't1', [msg(1, { plaintext: 'in one' })], null);
    await writeChatHistory(store, 't2', [msg(1, { plaintext: 'in two' })], null);
    expect((await readChatHistory(store, 't1'))!.messages[0].plaintext).toBe('in one');
    expect((await readChatHistory(store, 't2'))!.messages[0].plaintext).toBe('in two');
  });

  it('an unknown room is a miss, not another room history', async () => {
    await writeChatHistory(store, 't1', [msg(1)], null);
    expect(await readChatHistory(store, 'never-seen')).toBeNull();
  });

  it('refuses a blank topic id on both sides', async () => {
    await writeChatHistory(store, '', [msg(1)], null);
    expect(await readChatHistory(store, '')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('UTF-8 and hostile plaintext survive the round trip', () => {
  it.each([
    ['Korean', '안녕하세요 반갑습니다'],
    ['emoji', '🌟🔐👩‍👩‍👧‍👦'],
    ['mixed scripts', '한글 English 日本語 🌟'],
    ['newlines and tabs', 'line one\nline two\ttabbed'],
    ['JSON-shaped', '{"id":"x","plaintext":"not really"}'],
    ['quotes and backslashes', 'he said "hi" \\ then left'],
    ['control chars', 'ab c'],
    ['SQL-shaped', "'; DROP TABLE chat_messages; --"],
    ['wildcards', '100% _ \\ literal'],
    ['script tag', '<script>alert(1)</script>'],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('%s', async (_label, plaintext) => {
    await writeChatHistory(store, 't1', [msg(1, { plaintext })], null);
    expect((await readChatHistory(store, 't1'))!.messages[0].plaintext).toBe(plaintext);
  });
});

// ---------------------------------------------------------------------------
describe('BOUNDARY: the global byte budget', () => {
  /** A room big enough that a handful of them blow the budget. */
  const fat = (tag: string) =>
    Array.from({ length: 100 }, (_, i) => msg(i + 1, { plaintext: `${tag}:${'x'.repeat(20_000)}` }));
  // 100 x 20KB is clipped to the per-room ceiling, so each fat room costs ~512KB.

  it('evicts the least-recently-written room, and keeps the newest', async () => {
    // Each fat room is clipped to the per-room ceiling, so it takes more than
    // MAX_BYTES / ROOM_BYTES of them before the global budget can bite at all.
    const rooms = Array.from({ length: 20 }, (_, i) => `room${String(i).padStart(2, '0')}`);
    for (const r of rooms) await writeChatHistory(store, r, fat(r), null);

    const survivors: string[] = [];
    for (const r of rooms) if (await readChatHistory(store, r)) survivors.push(r);

    // The room just written is always readable...
    expect(survivors).toContain(rooms[rooms.length - 1]);
    // ...and the budget actually bit, rather than everything surviving.
    expect(survivors.length).toBeLessThan(rooms.length);
    // Eviction runs oldest-first, so a survivor set never skips a newer room.
    const idx = survivors.map((r) => rooms.indexOf(r));
    expect(idx).toEqual([...idx].sort((x, y) => x - y));
    expect(Math.max(...idx)).toBe(rooms.length - 1);
  });

  it('a room that alone exceeds the budget is still written', async () => {
    // Writing it and immediately dropping it spends the IO and keeps nothing.
    const huge = Array.from({ length: 200 }, (_, i) =>
      msg(i + 1, { plaintext: 'y'.repeat(Math.ceil(CHAT_HISTORY_CACHE_MAX_BYTES / 100)) }),
    );
    await writeChatHistory(store, 'solo', huge, null);
    expect((await readChatHistory(store, 'solo'))?.messages.length).toBeGreaterThan(0);
  });

  it('re-writing the same room does not multiply its cost', async () => {
    for (let i = 0; i < 8; i++) await writeChatHistory(store, 'same', fat('same'), null);
    expect(await readChatHistory(store, 'same')).not.toBeNull();
    const index = JSON.parse(store.map.get('chatHistory/v1/index')!);
    expect(index.rooms.filter((r: { topicId: string }) => r.topicId === 'same')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('the cursor', () => {
  it('round-trips alongside the messages', async () => {
    const cursor = { createdAt: msg(3).createdAt, messageId: msg(3).id };
    await writeChatHistory(store, 't1', many(3), cursor);
    expect((await readChatHistory(store, 't1'))!.cursor).toEqual(cursor);
  });

  it('EMPTY: no cursor means the caller must read everything', async () => {
    await writeChatHistory(store, 't1', many(3), null);
    expect((await readChatHistory(store, 't1'))!.cursor).toBeNull();
  });

  it('INTEGRITY: a cursor with no messages behind it is refused whole', async () => {
    // Half of this pair would tell the caller to fetch only the delta and then
    // render nothing — an empty room that looks like a working one.
    store.map.set(
      'chatHistory/v1/t1',
      JSON.stringify({ v: 1, cursor: { createdAt: 'x', messageId: 'y' }, messages: [] }),
    );
    expect(await readChatHistory(store, 't1')).toBeNull();
  });

  it('cursorFrom picks the newest row, breaking a tie on message id', () => {
    const at = '2026-01-01T00:00:00.000Z';
    expect(
      cursorFrom([
        { messageId: 'b', createdAt: at },
        { messageId: 'c', createdAt: at },
      ]),
    ).toEqual({ createdAt: at, messageId: 'c' });
    expect(
      cursorFrom([
        { messageId: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { messageId: 'new', createdAt: '2026-06-01T00:00:00.000Z' },
      ]),
    ).toEqual({ createdAt: '2026-06-01T00:00:00.000Z', messageId: 'new' });
  });

  it('cursorFrom returns null when there is nothing usable', () => {
    expect(cursorFrom([])).toBeNull();
    expect(cursorFrom([{ messageId: '', createdAt: 'x' }])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('EXTERNAL FAILURE: storage never breaks the room', () => {
  it('a read that throws is a miss', async () => {
    await writeChatHistory(store, 't1', many(3), null);
    store.failOn = 'get';
    await expect(readChatHistory(store, 't1')).resolves.toBeNull();
  });

  it('a write that throws does not reject', async () => {
    store.failOn = 'set';
    await expect(writeChatHistory(store, 't1', many(3), null)).resolves.toBeUndefined();
  });

  it('an absent store is a miss, not a crash', async () => {
    await expect(readChatHistory(undefined, 't1')).resolves.toBeNull();
    await expect(writeChatHistory(undefined, 't1', many(3), null)).resolves.toBeUndefined();
  });

  it.each([
    ['not json', 'definitely not json'],
    [
      'wrong version',
      JSON.stringify({ v: 99, cursor: null, messages: [{ id: 'a', createdAt: 'x', plaintext: 'p' }] }),
    ],
    // `v: 99` above already covers a version mismatch; this row must fail on
    // the SHAPE, so it carries no version at all rather than a stale literal.
    ['messages not an array', JSON.stringify({ cursor: null, messages: 'nope' })],
    ['null body', JSON.stringify(null)],
  ])('a stored value that is %s reads as a miss', async (_label, raw) => {
    store.map.set('chatHistory/v1/t1', raw);
    await expect(readChatHistory(store, 't1')).resolves.toBeNull();
  });

  it('drops malformed rows but keeps the good ones', async () => {
    /*
     * Seeded THROUGH `writeChatHistory` and then corrupted, rather than
     * hand-written as a literal. A literal has to name the format version, and
     * naming it made this the one test that failed whenever the version was
     * bumped — a false alarm that says nothing about the behaviour under test.
     * Writing first takes whatever version the module currently stamps.
     */
    await writeChatHistory(store, 't1', [msg(1), msg(2)], null);
    const stored = JSON.parse(store.map.get('chatHistory/v1/t1')!);
    stored.messages = [msg(1), { id: 'no-date' }, null, 42, msg(2)];
    store.map.set('chatHistory/v1/t1', JSON.stringify(stored));

    const got = await readChatHistory(store, 't1');
    expect(got!.messages.map((m) => m.id)).toEqual([msg(1).id, msg(2).id]);
  });

  it('a corrupt INDEX does not stop a room being written or read', async () => {
    store.map.set('chatHistory/v1/index', '{{{');
    await writeChatHistory(store, 't1', many(3), null);
    expect((await readChatHistory(store, 't1'))!.messages).toHaveLength(3);
  });
});
