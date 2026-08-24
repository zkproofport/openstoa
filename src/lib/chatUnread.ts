/**
 * What a conversation list needs to draw a badge: the account's read cursor,
 * and how many messages sit past it.
 *
 * ── why the server returns BOTH a cursor and a count ─────────────────────────
 *
 * The CURSOR (`chat_reads.last_read_at`) is the stored fact and the only thing
 * a client ever writes. The COUNT is a pure projection of it — derived here, by
 * the rule stated once below, never stored.
 *
 * Returning only the cursor would leave the web list unable to badge at all.
 * It deliberately fetches zero message content (SI-1, and a per-room chat fetch
 * on every mount), so it holds no window to count over — which is exactly the
 * gap `ChatRoomList.tsx` carried a comment about. Returning only the count
 * would cost the other half: the mini-app's badge could not drop to zero until
 * the next poll came back, and the same cursor is the mini-app's `?since=`
 * delta-sync anchor. One fact, two consumers.
 *
 * So both ship, with an owner: the cursor is authoritative, the count is what
 * the cursor implies. A client that holds its own window (the mini-app) counts
 * locally for instant feedback and uses the cursor to seed itself; a client
 * that holds none (the web) renders the count directly. They agree because both
 * apply the SAME three rules.
 *
 * ── the three rules, which the mini-app's `countUnread` also applies ──────────
 *
 *  1. Only rows STRICTLY NEWER than the cursor. The cursor is inclusive: a
 *     message at exactly that instant has been read.
 *  2. Never the viewer's OWN messages, and never anything beneath one. Sending
 *     is being in the room, so a message of mine is itself a read mark — this
 *     is what keeps a room whose last rows are mine at zero rather than
 *     counting the older rows under them. Expressed ONLY as the `mine`
 *     threshold below, never also as a `user_id <> viewer` filter: the two
 *     would be the same rule written twice, and the filter is the copy that
 *     cannot be tested. It was there, and a mutation run proved that deleting
 *     it changed no answer and reddened no test — every message of mine is at
 *     or before my newest one, so the threshold already excludes all of them.
 *     A guard nothing can kill is decoration, and decoration next to a real
 *     guard is worse than none: it reads as the thing doing the work.
 *  3. Never system rows (`join` / `leave`). They are public furniture, not
 *     something to be unread about. They are skipped, not counted, and they do
 *     not stop the walk either — a join notice between two new messages must
 *     not hide the older one.
 *
 * SI-1: this reads `type`, `user_id` and `created_at` only. No ciphertext is
 * selected and no body is touched, so a count leaks nothing the row's existence
 * did not already.
 */
import { sql, and, eq, inArray } from 'drizzle-orm';
import { chatReads } from './db/schema';
import type { db as Db } from './db';

/** Minimal surface so this can be exercised against a stub, like `pushPrefs`. */
interface Rows<T> {
  rows: T[];
}

/**
 * The badge cap. A list row cannot render more than "999+" on either client,
 * so a larger true count is information nothing can display; clamping here
 * keeps one number on the wire instead of one per client convention.
 */
export const UNREAD_COUNT_CAP = 999;

/** One row's read state for the list. */
export interface TopicReadState {
  /** ISO instant of the account's read cursor, or null for never-read. */
  lastReadAt: string | null;
  /** The message that cursor names, or null. Informational — see the schema. */
  lastReadMessageId: string | null;
  /** Messages past the cursor by the three rules above, capped at 999. */
  unreadCount: number;
}

/** Empty state for a room with no cursor and nothing to count. */
export function emptyReadState(): TopicReadState {
  return { lastReadAt: null, lastReadMessageId: null, unreadCount: 0 };
}

/**
 * Clamp a raw count to what a badge can show.
 *
 * Separate and exported because it is the one arithmetic step here, and a
 * negative or non-finite input (a driver handing back a string, an empty
 * aggregate) must land on 0 rather than on `NaN` — a `NaN` badge renders as an
 * empty pill on the web rather than as nothing.
 */
export function capUnread(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(Math.floor(n), UNREAD_COUNT_CAP);
}

/**
 * Read state for every topic in `topicIds`, for one account.
 *
 * One query for the cursors and one for the counts, rather than N of each: the
 * list asks for every joined room at once and this is on the critical path of
 * the page the user lands on.
 *
 * A topic with no row in the result gets `emptyReadState()`, which is the
 * never-read case and NOT an error — most rooms have never been opened.
 */
export async function readStatesForTopics(
  db: typeof Db,
  userId: string,
  topicIds: readonly string[],
): Promise<Record<string, TopicReadState>> {
  const out: Record<string, TopicReadState> = {};
  if (topicIds.length === 0) return out;
  for (const id of topicIds) out[id] = emptyReadState();

  const cursors = await db
    .select({
      topicId: chatReads.topicId,
      lastReadAt: chatReads.lastReadAt,
      lastReadMessageId: chatReads.lastReadMessageId,
    })
    .from(chatReads)
    .where(and(eq(chatReads.userId, userId), inArray(chatReads.topicId, [...topicIds])));

  for (const c of cursors) {
    const row = out[c.topicId];
    if (!row) continue;
    row.lastReadAt = c.lastReadAt instanceof Date ? c.lastReadAt.toISOString() : String(c.lastReadAt);
    row.lastReadMessageId = c.lastReadMessageId;
  }

  /*
   * The three rules, as one statement.
   *
   * `mine` implements rule 2 as a THRESHOLD rather than as a walk: the mini-app
   * stops counting at its own newest message, and "stop at my newest" and
   * "ignore everything at or before my newest" are the same set. Expressing it
   * as a threshold is what lets this be one grouped count instead of a
   * per-topic scan — and it is also why no `user_id <> viewer` filter appears
   * beside it. `mine.at` IS the viewer's newest message, so every message of
   * theirs is at or before it and already excluded; the filter was redundant,
   * and a mutation run confirmed deleting it reddened nothing.
   *
   * `'-infinity'` for a room with no cursor and no message of mine — NOT NULL,
   * which would make `GREATEST` null and the comparison null, and silently
   * report every unread room as zero. That is the failure this coalesce exists
   * for and it is the reason the never-read case is tested explicitly.
   */
  // Each id cast explicitly: the columns are `uuid` and the parameters arrive
  // as text, so an uncast list is a type error rather than an empty result —
  // loud, but only at runtime, which is why it is spelled out once here.
  const idList = sql.join(topicIds.map((id) => sql`${id}::uuid`), sql`, `);

  const counts = (await db.execute(sql`
    WITH mine AS (
      SELECT topic_id, max(created_at) AS at
      FROM chat_messages
      WHERE topic_id IN (${idList}) AND user_id = ${userId}
      GROUP BY topic_id
    ),
    seen AS (
      SELECT topic_id, last_read_at
      FROM chat_reads
      WHERE topic_id IN (${idList}) AND user_id = ${userId}
    )
    SELECT m.topic_id AS topic_id, count(*)::int AS unread
    FROM chat_messages m
    LEFT JOIN mine ON mine.topic_id = m.topic_id
    LEFT JOIN seen ON seen.topic_id = m.topic_id
    WHERE m.topic_id IN (${idList})
      AND m.type = 'message'
      AND m.created_at > GREATEST(
        COALESCE(seen.last_read_at, '-infinity'::timestamptz),
        COALESCE(mine.at, '-infinity'::timestamptz)
      )
    GROUP BY m.topic_id
  `)) as unknown as Rows<{ topic_id: string; unread: unknown }>;

  for (const raw of counts.rows ?? []) {
    const row = out[raw.topic_id];
    if (!row) continue;
    row.unreadCount = capUnread(raw.unread);
  }

  return out;
}
