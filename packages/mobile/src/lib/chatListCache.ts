/**
 * The rooms this account is in, kept on the device so the list survives a cold
 * start with no network.
 *
 * THE DEFECT THIS EXISTS FOR, reproduced on a real device (SM-A235N) by turning
 * wifi and mobile data off and relaunching: the Chat tab showed "Couldn't load
 * chats — Could not reach the server" and nothing else. Not one room, not even
 * the ones whose entire history was already decrypted and sitting in the device
 * store. The rooms had not gone anywhere; the LIST of them existed only in a
 * server response, and a cold start had no response.
 *
 * That is the same mistake as the sign-out one next door in `sessionVerdict`:
 * treating "nobody answered" as "there is nothing". Here it locked the reader
 * out of content they already held.
 *
 * ROUTING METADATA ONLY. What is stored is what the list draws — id, title,
 * kind, the last-activity timestamp and the read cursor. NO message bodies and
 * no ciphertext: those live in the history cache, under the group's own key.
 * A reader of this file learns which rooms exist and when they were last busy,
 * which is exactly what the room list on screen already shows.
 */

/** The slice of the host's key/value store this needs. */
export interface ChatListStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * One row, as the list needs it.
 *
 * Deliberately loose about extra fields: the server adds columns to
 * `/api/topics` over time and a cache that dropped unknown ones would quietly
 * downgrade the list after every restart. Only the fields named here are
 * REQUIRED to be present and of the right type.
 */
export interface CachedChatRoom {
  id: string;
  title?: string | null;
  kind?: string | null;
  lastChatAt?: string | null;
  lastReadAt?: string | null;
  lastReadMessageId?: string | null;
  unreadCount?: number;
  [extra: string]: unknown;
}

/**
 * Per ACCOUNT, not global.
 *
 * Two accounts on one phone — the owner's and a test one — must not see each
 * other's rooms, and signing out and back in as someone else must not paint the
 * previous person's list for a frame. The user id is in the key so a wrong
 * account is a miss rather than a leak.
 */
function keyFor(userId: string): string {
  return `openstoa.chatList.v1.${userId}`;
}

/**
 * Most rooms a cache will hold.
 *
 * The list is ordered by activity, so the tail is the part nobody is looking
 * at. A bound in ENTRIES is right here — unlike media, a row is a few hundred
 * bytes and they do not vary — and 200 is far past what any screen scrolls
 * while staying small enough to write on every refresh without thinking about
 * it.
 */
export const CHAT_LIST_CACHE_MAX = 200;

/** True for a value that could be drawn as a room row. */
function isRoom(value: unknown): value is CachedChatRoom {
  if (typeof value !== 'object' || value === null) return false;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0;
}

/**
 * The rooms last seen for this account, or an empty list.
 *
 * NEVER THROWS and never returns garbage. A store that fails, a value that is
 * not JSON, JSON that is not an array, an array holding nulls — all of them are
 * "no cache", because the alternative is a chat list that crashes on a corrupt
 * string written by an older build.
 */
export async function readCachedChatList(
  store: ChatListStore | null | undefined,
  userId: string | null | undefined,
): Promise<CachedChatRoom[]> {
  if (!store || !userId) return [];
  try {
    const raw = await store.getItem(keyFor(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRoom).slice(0, CHAT_LIST_CACHE_MAX);
  } catch {
    return [];
  }
}

/**
 * Keep `rooms` for next time.
 *
 * Called after a successful fetch, so it always REPLACES rather than merges: a
 * room the account has left must disappear from the cache, and a merge would
 * keep it visible forever.
 */
export async function writeCachedChatList(
  store: ChatListStore | null | undefined,
  userId: string | null | undefined,
  rooms: readonly unknown[],
): Promise<void> {
  if (!store || !userId) return;
  try {
    const rows = rooms.filter(isRoom).slice(0, CHAT_LIST_CACHE_MAX);
    await store.setItem(keyFor(userId), JSON.stringify(rows));
  } catch {
    // A cache write is an optimisation. It may never be the reason a list that
    // just loaded successfully fails to render.
  }
}
