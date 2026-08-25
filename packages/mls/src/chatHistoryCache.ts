/**
 * The most recent messages of a room, decrypted, kept on the device.
 *
 * WHY THIS DID NOT ALREADY EXIST, because the reason is the trap. MLS messages
 * have had a plaintext cache from the start (`mlsSession.openCached`) — forward
 * secrecy consumes the per-message key on first decrypt, so WITHOUT a cache a
 * restart loses the message entirely. It was mandatory, so it got built.
 *
 * The archive (TAK) path is the opposite: the root or epoch key stays on the
 * device, so a row can always be opened again. A cache there is not required
 * for correctness — and "not required" quietly became "not done". Nothing broke;
 * the room simply re-downloaded its whole archive and re-decrypted every row on
 * every entry, which no test could see and no error could report.
 *
 * TIER-AGNOSTIC ON PURPOSE. public, private, secret and dm all pay the same cost
 * and all get this. The key model differs between them — one topic root versus a
 * key per epoch — but that is a question about how a row is OPENED, and by the
 * time a plaintext exists the tier no longer matters.
 *
 * BOUNDED IN BYTES, NOT IN MESSAGES. A message count is a proxy for the thing
 * that actually matters, and a poor one: 300 one-word messages are about 3KB
 * and 300 long ones about 300KB, a hundredfold spread for the same number. It
 * is not even a good proxy for the thing the cache is FOR — a screen holds
 * roughly a fixed amount of text, not a fixed number of messages, so "how much
 * scrollback does this buy" also tracks bytes. Two budgets, both in bytes: one
 * per room so a single busy conversation cannot crowd out every other, and one
 * across all rooms so the device is never the worse for us.
 *
 * WHAT IS STORED IS PLAINTEXT, and that is safe here because the caller wraps
 * this store with `encrypting(...)`, which seals every value under the device
 * master key. The same wrapper already holds the MLS message cache.
 */

/** A message the device has already opened. */
export interface CachedChatMessage {
  id: string;
  /** ISO instant, server-assigned. The ordering key. */
  createdAt: string;
  plaintext: string;
  /**
   * Who wrote it, so a room can be PAINTED from this cache and not merely
   * decrypted from it.
   *
   * Without these the cache could restore bodies but not bubbles: the renderer
   * needs an author to put a name on a row and to decide which side it sits on,
   * so a cached room still had to wait for `/chat` before it could show
   * anything — which is the whole cost the cache exists to remove, and it was
   * still being paid on every reload. Measured on staging: a re-entry inside
   * one page load paints in 102ms, and after a refresh it was 637ms again.
   *
   * Storing them adds no exposure. They are not secret to begin with — the
   * server assigns them and returns them in the clear on every `/chat` read,
   * and on a `public` topic it holds the archive root and can read the bodies
   * too — and this whole record is sealed under the device master key by the
   * `encrypting(...)` wrapper before it reaches storage. What stays out is
   * anything the server does NOT already have.
   *
   * Optional because a row can be opened by `backfill` from an `ArchiveEntry`,
   * which carries ciphertext and no author at all. Such a row keeps its
   * plaintext and gets its author from the network read that follows.
   */
  userId?: string;
  nickname?: string;
  profileImage?: string;
  /** `'message' | 'join' | 'leave'` — a join notice renders as a notice, not a bubble. */
  type?: string;
  isAI?: boolean;
}

/** Where to resume from — the newest archive row this cache has seen. */
export interface ChatHistoryCursor {
  createdAt: string;
  messageId: string;
}

export interface CachedChatHistory {
  messages: CachedChatMessage[];
  /** Null when nothing has been cached yet: the caller must do a full read. */
  cursor: ChatHistoryCursor | null;
}

/**
 * How much decrypted history one room may keep.
 *
 * An ordinary chat message is well under 200 bytes of text — attachments live
 * in object storage and only their URL is in the body — so this is thousands of
 * messages in a normal room, and still several hundred in a room where every
 * message is a wall of text. Either way it is far more scrollback than anyone
 * reads before they would have hit the network anyway.
 */
export const CHAT_HISTORY_CACHE_ROOM_BYTES = 512 * 1024;

/**
 * Total across every room.
 *
 * Sixteen rooms at the per-room ceiling, and in practice hundreds, because a
 * real room is nowhere near 512KB of text. Small enough that a phone which is
 * already short of space is never made worse by us.
 */
export const CHAT_HISTORY_CACHE_MAX_BYTES = 8 * 1024 * 1024;

/** Storage this cache needs. Matches `SecureKVStore` so the encrypting wrapper fits. */
export interface ChatHistoryStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/*
 * Bumped when the shape of a stored room changes. A record written by an older
 * version is DISCARDED, not migrated: OpenStoa has not shipped, so there is no
 * installed base to carry, and the cache is re-derivable from the archive by
 * design — dropping it costs one slow room once.
 */
const VERSION = 2;
const ROOM_PREFIX = 'chatHistory/v1/';
const INDEX_KEY = 'chatHistory/v1/index';

interface StoredRoom {
  v: number;
  cursor: ChatHistoryCursor | null;
  messages: CachedChatMessage[];
}

/** One entry per room, so eviction can see the whole picture without reading every room. */
interface IndexEntry {
  topicId: string;
  bytes: number;
  /** Monotonic write counter, NOT a clock: a device whose clock moves backwards
   *  must not resurrect an old room as the most recently used. */
  seq: number;
}

interface StoredIndex {
  v: number;
  seq: number;
  rooms: IndexEntry[];
}

/*
 * THE ACCOUNT IS PART OF THE KEY.
 *
 * It was not, and that was a leak. This record holds DECRYPTED messages, and
 * the key was the topic id alone — so on a phone where one person signed out
 * and another signed in, the second person's app read the first person's
 * plaintext for any room they both belonged to, including the stretch before
 * they joined, which is precisely the history the tier policy withholds from
 * them. `chatListCache` had already been namespaced by account; this file had
 * not, so one of the two caches on the same device disagreed about whose data
 * it was.
 *
 * Old entries written under the un-namespaced key are simply unreachable now.
 * They are left rather than migrated: OpenStoa has not shipped, so there is no
 * installed base to carry, and the cache is re-derivable from the archive by
 * design.
 */
function roomKey(accountId: string, topicId: string): string {
  return `${ROOM_PREFIX}${accountId}/${topicId}`;
}

/** The eviction index is per-account for the same reason the rooms are. */
function indexKey(accountId: string): string {
  return `${INDEX_KEY}/${accountId}`;
}

/**
 * Length of `s` in UTF-8 bytes.
 *
 * `String.length` counts UTF-16 units, which undercounts Korean and most other
 * non-Latin text threefold and emoji twofold — budgeting on it would give a
 * Korean conversation three times the disk a English one gets for the same
 * stated ceiling. Hand-rolled rather than `TextEncoder`/`Buffer` because this
 * file has a byte-identical twin in the mini-app and must stay free of anything
 * that is not in every runtime it ships to.
 */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A surrogate PAIR is one code point in four bytes.
        n += 4;
        i++;
        continue;
      }
      // A lone surrogate is not a code point; JSON.stringify escapes it, and
      // three is what the replacement character costs.
      n += 3;
    } else n += 3;
  }
  return n;
}

function isMessage(x: unknown): x is CachedChatMessage {
  if (!x || typeof x !== 'object') return false;
  const m = x as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    m.id.length > 0 &&
    typeof m.createdAt === 'string' &&
    typeof m.plaintext === 'string'
  );
}

/** What one message costs on disk, including the comma that separates it. */
function messageBytes(m: CachedChatMessage): number {
  return utf8Length(JSON.stringify(m)) + 1;
}

/**
 * Newest last, one row per id, trimmed from the FRONT to fit `maxBytes`.
 *
 * Exported because `backfill` must return the SAME list it stores. Merging
 * cached rows with freshly opened ones by concatenation alone produced a
 * duplicated, out-of-order list on the way back to the caller while the stored
 * copy was fine — the room rendered a message twice and in the wrong place, and
 * only the render showed it.
 *
 * Trimming takes the OLDEST. A cache that dropped the newest messages would
 * open the room on old text and then jump, which is worse than opening on a
 * short history that is correct.
 *
 * De-duplication keeps the LAST occurrence, because the caller merges freshly
 * decrypted rows onto cached ones and the fresh copy is the one that just came
 * off the wire.
 *
 * At least one message always survives, however large it is. A room that
 * refused to cache its only message would re-fetch the whole archive every
 * time — the exact behaviour this exists to end — and it would do so for the
 * rooms whose messages are most expensive to fetch.
 */
export function mergeChatHistory(
  messages: CachedChatMessage[],
  maxBytes = CHAT_HISTORY_CACHE_ROOM_BYTES,
): CachedChatMessage[] {
  const byId = new Map<string, CachedChatMessage>();
  for (const m of messages) {
    if (isMessage(m)) byId.set(m.id, m);
  }
  const ordered = [...byId.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    // Same instant: fall back to the id so the order is total and stable.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // `{"v":1,"cursor":{...},"messages":[]}` and the cursor it may carry.
  let total = 128;
  const kept: CachedChatMessage[] = [];
  for (let i = ordered.length - 1; i >= 0; i--) {
    const size = messageBytes(ordered[i]);
    if (kept.length > 0 && total + size > maxBytes) break;
    total += size;
    kept.push(ordered[i]);
  }
  return kept.reverse();
}

async function readIndex(store: ChatHistoryStore, accountId: string): Promise<StoredIndex> {
  try {
    const raw = await store.get(indexKey(accountId));
    if (raw) {
      const parsed = JSON.parse(raw) as StoredIndex;
      if (parsed?.v === VERSION && Array.isArray(parsed.rooms)) {
        return {
          v: VERSION,
          seq: Number(parsed.seq) || 0,
          rooms: parsed.rooms.filter((r) => r?.topicId),
        };
      }
    }
  } catch {
    /* unreadable or from an older shape → start over rather than guess */
  }
  return { v: VERSION, seq: 0, rooms: [] };
}

/**
 * What the device already holds for this room.
 *
 * Never throws and never rejects. A cache that can fail the room it exists to
 * speed up is worse than no cache: every caller would need a try/catch, and the
 * one that forgets it turns a storage hiccup into an unopenable conversation.
 * A miss and a failure are the same answer here — read it from the server.
 */
export async function readChatHistory(
  store: ChatHistoryStore | undefined,
  /**
   * Whose cache this is. REQUIRED, and a miss when absent: an unattributed
   * record is the defect this parameter exists to prevent, so there is no
   * "unknown account" bucket to fall back into.
   */
  accountId: string | null | undefined,
  topicId: string,
): Promise<CachedChatHistory | null> {
  if (!store || !accountId || !topicId.trim()) return null;
  try {
    const raw = await store.get(roomKey(accountId, topicId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredRoom;
    if (parsed?.v !== VERSION || !Array.isArray(parsed.messages)) return null;
    const messages = mergeChatHistory(parsed.messages);
    const cursor =
      parsed.cursor &&
      typeof parsed.cursor.createdAt === 'string' &&
      typeof parsed.cursor.messageId === 'string'
        ? parsed.cursor
        : null;
    // A cursor with no messages behind it would tell the caller to fetch only
    // the delta and then render nothing. Refuse the pair rather than the parts.
    if (cursor && messages.length === 0) return null;
    return { messages, cursor };
  } catch {
    return null;
  }
}

/**
 * Keep as much of the tail of `messages` as the per-room budget allows.
 *
 * Eviction across rooms drops WHOLE ROOMS, least-recently-written first, never
 * individual messages from inside a room. Trimming across rooms would punch
 * holes in the middle of conversations — a reader would scroll into a gap that
 * looks like lost history and is not — whereas an evicted room simply re-syncs
 * the next time it is opened, which is the behaviour every room had before this
 * existed.
 *
 * The room being written is never the one evicted.
 */
export async function writeChatHistory(
  store: ChatHistoryStore | undefined,
  /** Whose cache this is — see `readChatHistory`. Without it nothing is written. */
  accountId: string | null | undefined,
  topicId: string,
  messages: CachedChatMessage[],
  cursor: ChatHistoryCursor | null,
): Promise<void> {
  if (!store || !accountId || !topicId.trim()) return;
  try {
    const kept = mergeChatHistory(messages);
    if (kept.length === 0) return;
    const body = JSON.stringify({ v: VERSION, cursor, messages: kept } satisfies StoredRoom);
    await store.set(roomKey(accountId, topicId), body);

    const index = await readIndex(store, accountId);
    const seq = index.seq + 1;
    const rooms = index.rooms.filter((r) => r.topicId !== topicId);
    rooms.push({ topicId, bytes: utf8Length(body), seq });

    // Oldest write first, so the tail of this list is what goes.
    rooms.sort((a, b) => a.seq - b.seq);
    let total = rooms.reduce((n, r) => n + r.bytes, 0);
    const survivors: IndexEntry[] = [];
    for (const room of rooms) {
      if (total <= CHAT_HISTORY_CACHE_MAX_BYTES || room.topicId === topicId) {
        survivors.push(room);
        continue;
      }
      total -= room.bytes;
      // Best-effort: an un-clearable room stays on disk but leaves the index,
      // so the budget is still honoured for everything counted from here on.
      await store.set(roomKey(accountId, room.topicId), '').catch(() => {});
    }

    await store.set(
      indexKey(accountId),
      JSON.stringify({ v: VERSION, seq, rooms: survivors } satisfies StoredIndex),
    );
  } catch {
    /* the cache is an optimisation; losing a write must never fail the room */
  }
}

/** The resume point for a set of archive rows: the newest one. */
export function cursorFrom(
  rows: Array<{ messageId: string; createdAt: string }>,
): ChatHistoryCursor | null {
  let newest: { messageId: string; createdAt: string } | null = null;
  for (const r of rows) {
    if (!r?.messageId || typeof r.createdAt !== 'string') continue;
    if (
      !newest ||
      r.createdAt > newest.createdAt ||
      (r.createdAt === newest.createdAt && r.messageId > newest.messageId)
    ) {
      newest = r;
    }
  }
  return newest ? { createdAt: newest.createdAt, messageId: newest.messageId } : null;
}
