/**
 * How far the viewer has READ in each conversation, in one place.
 *
 * The defect this exists for: entering a room did not record anything. The
 * chat list kept its own `seenMessageIds` map and wrote it from the row's
 * `onPress` handler, so the marker was a property of TAPPING A ROW rather than
 * of being in the room. Every other way into a room therefore left no trace —
 * and the one the tester hit is the common one: tap a push notification, land
 * straight in the room (`ChatListScreen`'s pending-tap effect calls
 * `navigation.navigate` and nothing else), read, come back out, and the list
 * still badges every message that was just read.
 *
 * So the writer is the ROOM, not the list, and it writes what it actually put
 * on screen. That makes the marker route-independent by construction: push tap,
 * row tap, DM list, a `push` from another room — all of them mount
 * `ChatRoomScreen`, and mounting it is the event.
 *
 * IN MEMORY, per app process — and now a CACHE rather than the whole truth.
 * The durable copy is server-side, one row per (topic, user) in `chat_reads`,
 * written by `PUT /api/topics/{topicId}/chat/read` through the debounced,
 * fire-and-forget `./chatReadSync`. Which of the two owns which question:
 *
 *   - this module answers INSTANTLY, so the badge drops the moment the user
 *     walks into a room instead of after a round trip;
 *   - the server answers DURABLY and ACROSS DEVICES, so a cold start knows
 *     where every room stands and reading on the phone clears the badge on the
 *     web.
 *
 * `ChatListScreen` seeds this map from the cursor `/api/topics` returns. It
 * seeds through `markChatRead`, which is monotonic, so a server response that
 * predates a local advance can never drag the cursor backwards.
 *
 * Imports nothing from React, React Native or the host bridge, like
 * `./chatStatus` and `../hooks/pushTapRouting`, so the package's plain-node
 * vitest runner can exercise it directly.
 */
import { isProvisionalId } from './chatStatus';

/** How far one conversation has been read. */
export interface ChatReadCursor {
  /** The newest message the viewer has seen, by server id. */
  messageId: string;
  /** ...and its `createdAt`, as the server wrote it. */
  createdAt: string;
}

/** The slice of a message this needs. Both clients' rows carry these. */
export interface ReadableMessage {
  id?: unknown;
  createdAt?: unknown;
}

const cursors = new Map<string, ChatReadCursor>();
const listeners = new Set<() => void>();

/**
 * Bumped on every accepted advance. `useSyncExternalStore` needs a snapshot
 * that is `Object.is`-stable while nothing has changed, and a `Map` read is
 * not — so subscribers watch this number and re-read the cursors themselves.
 */
let version = 0;

function emit(): void {
  version += 1;
  // Snapshot: a listener may unsubscribe from inside its own callback.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One misbehaving subscriber must not stop the others being told.
    }
  }
}

/** Milliseconds for a server timestamp, or null when it is not one. */
function timeOf(createdAt: unknown): number | null {
  if (typeof createdAt !== 'string' || createdAt.trim() === '') return null;
  const ms = new Date(createdAt).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Record that `message` has been seen in `topicId`. Returns whether the cursor
 * actually moved, so a caller (or a test) can tell "advanced" from "already at
 * or past this".
 *
 * REFUSES a provisional row. A message that is on screen before the server has
 * stored it carries a `pending-` id the list will never see, and a `createdAt`
 * from the DEVICE clock — a phone running an hour fast would otherwise park the
 * cursor an hour in the future and silently mark an hour of real messages read.
 * Walking back to the newest stored row is the caller's job (see
 * `newestReadable`), because only the caller knows the order of its own list.
 *
 * MONOTONIC. Rooms report their newest row on every change, and history paging
 * or a delta-sync merge can briefly make an older row the last element; letting
 * that move the cursor backwards would resurrect a badge the user had cleared.
 */
export function markChatRead(topicId: unknown, message: ReadableMessage | null | undefined): boolean {
  if (typeof topicId !== 'string' || topicId.trim() === '') return false;
  const id = message?.id;
  if (typeof id !== 'string' || id === '' || isProvisionalId(id)) return false;
  const at = timeOf(message?.createdAt);
  if (at === null) return false;

  const key = topicId.trim();
  const prev = cursors.get(key);
  if (prev) {
    const prevAt = timeOf(prev.createdAt);
    // A tie on the millisecond with a DIFFERENT id still advances: a burst can
    // share a timestamp, and refusing there would strand the cursor on
    // whichever of them arrived first.
    if (prevAt !== null && at < prevAt) return false;
    if (prevAt === at && prev.messageId === id) return false;
  }
  cursors.set(key, { messageId: id, createdAt: String(message?.createdAt) });
  emit();
  return true;
}

/**
 * The newest message in `messages` that is safe to record, or undefined.
 *
 * `newestFirst` says which end to start from, because the two callers hold
 * their rows in opposite orders: the room renders oldest→newest, the list
 * fetches newest→oldest. Provisional rows are stepped over rather than stopping
 * the walk — sending three photos leaves three pending rows on top of the real
 * history, and the cursor should still reach the real row underneath them.
 */
export function newestReadable(
  messages: readonly ReadableMessage[],
  newestFirst = false,
): ReadableMessage | undefined {
  const indices = newestFirst
    ? messages.keys()
    : [...messages.keys()].reverse();
  for (const i of indices) {
    const message = messages[i];
    const id = message?.id;
    if (typeof id === 'string' && id !== '' && !isProvisionalId(id) && timeOf(message?.createdAt) !== null) {
      return message;
    }
  }
  return undefined;
}

/** How far `topicId` has been read, or undefined for never. */
export function getChatReadCursor(topicId: string): ChatReadCursor | undefined {
  return cursors.get(topicId);
}

/**
 * The cursor's timestamp alone. This is also the `?since=` anchor for the
 * room's delta sync on SSE reconnect — the same question ("what is the newest
 * thing this client already has") asked by the other consumer.
 */
export function getChatReadCursorIso(topicId: string): string | undefined {
  return cursors.get(topicId)?.createdAt;
}

/** A snapshot that only changes when some cursor does. See `version`. */
export function getChatReadCursorVersion(): number {
  return version;
}

/** Subscribe to cursor changes; returns an unsubscribe function. */
export function subscribeChatReadCursors(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget every cursor and subscriber. Never called in app code. */
export function resetChatReadCursors(): void {
  cursors.clear();
  listeners.clear();
  version = 0;
}
