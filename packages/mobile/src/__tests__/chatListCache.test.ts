/**
 * The room list survives a cold start with no network.
 *
 * THE DEFECT, reproduced on a real device (SM-A235N) by turning wifi and mobile
 * data off and relaunching: the Chat tab showed "Couldn't load chats — Could
 * not reach the server" and nothing else. Not one room — including rooms whose
 * entire history was already decrypted and sitting in the device store. The
 * rooms had not gone anywhere; the LIST of them existed only in a server
 * response, and a cold start has no response.
 *
 * It is the same mistake as the sign-out one in `sessionVerdict`: treating
 * "nobody answered" as "there is nothing". Here it locked the reader out of
 * content the phone was already holding.
 *
 * WHAT IS STORED. Routing metadata only — id, title, kind, activity time, read
 * cursor. No message bodies, no ciphertext. A reader of this file learns which
 * rooms exist and when they were last busy, which is what the list on screen
 * already shows them.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → a write round-trips, and a later write REPLACES
 *   integrity  → the cache is per account; another account reads nothing
 *   hostile    → corrupt JSON, a JSON object, an array of junk, nulls
 *   empty      → no store, no user id, an empty list, an absent key
 *   boundary   → the entry bound holds, and the newest rows are the kept ones
 *   external   → a store that throws on read and on write
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  readCachedChatList,
  writeCachedChatList,
  CHAT_LIST_CACHE_MAX,
  type ChatListStore,
} from '../lib/chatListCache';

const USER = '0xabc';
const OTHER = '0xdef';

function memoryStore(): ChatListStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    async getItem(k) {
      return raw.get(k) ?? null;
    },
    async setItem(k, v) {
      raw.set(k, v);
    },
  };
}

const room = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `room ${id}`,
  kind: 'topic',
  lastChatAt: '2026-08-25T00:00:00.000Z',
  ...extra,
});

let store: ReturnType<typeof memoryStore>;
beforeEach(() => {
  store = memoryStore();
});

describe('the room list survives an unreachable server', () => {
  it('CONTRACT: what was written comes back', async () => {
    await writeCachedChatList(store, USER, [room('a'), room('b')]);
    const rooms = await readCachedChatList(store, USER);
    expect(rooms.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rooms[0].title).toBe('room a');
  });

  it('CONTRACT: a later write REPLACES — a room you left must disappear', async () => {
    await writeCachedChatList(store, USER, [room('a'), room('b')]);
    await writeCachedChatList(store, USER, [room('b')]);
    expect((await readCachedChatList(store, USER)).map((r) => r.id)).toEqual(['b']);
  });

  it('CONTRACT: fields the server adds later are carried, not dropped', async () => {
    // A cache that kept only the fields it knew about would silently downgrade
    // the list after every restart as the API grows.
    await writeCachedChatList(store, USER, [room('a', { unreadCount: 4, somethingNew: 'x' })]);
    const [row] = await readCachedChatList(store, USER);
    expect(row.unreadCount).toBe(4);
    expect(row.somethingNew).toBe('x');
  });

  it('INTEGRITY: another account reads nothing', async () => {
    // Two accounts on one phone, and signing out and in as someone else, must
    // never paint the previous person's rooms — not even for one frame.
    await writeCachedChatList(store, USER, [room('a')]);
    expect(await readCachedChatList(store, OTHER)).toEqual([]);
  });

  it.each([
    ['not JSON at all', 'not json'],
    ['a JSON object, not an array', '{"topics":[]}'],
    ['a JSON string', '"hello"'],
    ['null', 'null'],
    ['a truncated array', '[{"id":"a"'],
  ])('HOSTILE: %s reads as no cache rather than crashing the list', async (_l, raw) => {
    store.raw.set(`openstoa.chatList.v1.${USER}`, raw);
    await expect(readCachedChatList(store, USER)).resolves.toEqual([]);
  });

  it('HOSTILE: an array of junk keeps only the rows that could be drawn', async () => {
    store.raw.set(
      `openstoa.chatList.v1.${USER}`,
      JSON.stringify([null, 42, 'x', { noId: true }, { id: '' }, room('good')]),
    );
    expect((await readCachedChatList(store, USER)).map((r) => r.id)).toEqual(['good']);
  });

  it.each([
    ['no store — a host build without one', null],
    ['an undefined store', undefined],
  ])('EMPTY: %s is an empty list, never a throw', async (_l, s) => {
    await expect(readCachedChatList(s, USER)).resolves.toEqual([]);
    await expect(writeCachedChatList(s, USER, [room('a')])).resolves.toBeUndefined();
  });

  it.each([
    ['no user id yet — booting', null],
    ['an empty user id', ''],
  ])('EMPTY: %s neither reads nor writes', async (_l, uid) => {
    await writeCachedChatList(store, uid, [room('a')]);
    expect(store.raw.size).toBe(0);
    await expect(readCachedChatList(store, uid)).resolves.toEqual([]);
  });

  it('EMPTY: an account with no rooms round-trips as an empty list', async () => {
    await writeCachedChatList(store, USER, []);
    await expect(readCachedChatList(store, USER)).resolves.toEqual([]);
  });

  it('BOUNDARY: the entry bound holds, and it is the FIRST rows that are kept', async () => {
    // The list arrives ordered by activity, so the tail is what nobody is
    // looking at — dropping from the end is dropping the least useful rows.
    const many = Array.from({ length: CHAT_LIST_CACHE_MAX + 50 }, (_, i) => room(`r${i}`));
    await writeCachedChatList(store, USER, many);
    const rooms = await readCachedChatList(store, USER);
    expect(rooms).toHaveLength(CHAT_LIST_CACHE_MAX);
    expect(rooms[0].id).toBe('r0');
    expect(rooms[rooms.length - 1].id).toBe(`r${CHAT_LIST_CACHE_MAX - 1}`);
  });

  it('EXTERNAL FAILURE: a store that throws on read is an empty list', async () => {
    const broken: ChatListStore = {
      getItem: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
      setItem: vi.fn(async () => {}),
    };
    await expect(readCachedChatList(broken, USER)).resolves.toEqual([]);
  });

  it('EXTERNAL FAILURE: a store that throws on write never breaks a good load', async () => {
    // The list has just been fetched successfully; a full disk may not turn
    // that into a visible failure.
    const broken: ChatListStore = {
      getItem: vi.fn(async () => null),
      setItem: vi.fn(async () => {
        throw new Error('quota exceeded');
      }),
    };
    await expect(writeCachedChatList(broken, USER, [room('a')])).resolves.toBeUndefined();
  });
});
