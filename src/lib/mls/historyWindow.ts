/**
 * Turning a parsed `historyGrant` into concrete SQL bounds (see
 * `src/lib/historyGrant.ts` for the grant grammar and the enforcement rationale).
 *
 * Everything here is SERVER-SIDE query shaping: the bound goes into the WHERE
 * clause so an out-of-scope row is never selected, never serialized, and never
 * counted. Nothing is filtered after the fact except the TAK bundle list, which
 * has no pagination to preserve (and is filtered in the route, still server-side).
 *
 * WHAT IS ACTUALLY ENFORCEABLE, PER SURFACE — read this before adding a grant form:
 *
 *   `GET /chat` reads `chat_messages`, which carries `created_at` AND `epoch`,
 *   so `Nd`, `N` and `since_epoch:N` are all enforceable exactly.
 *
 *   `GET /archive` reads `chat_archive`, which carries only its OWN `created_at`
 *   (when the row was re-encrypted and uploaded) and `tak_version`. Neither is a
 *   usable proxy for message age:
 *     - `chat_archive.created_at` is ARCHIVAL time. A member back-filling today
 *       writes three-year-old messages with today's timestamp, so bounding on it
 *       would let a `7d` key read the entire archive — a gate that looks like
 *       protection and is not.
 *     - `tak_version` is NOT an epoch on public topics: it is 0 there (the shared
 *       archive root key) and only tracks the MLS epoch on private/secret topics.
 *       `tak_version >= N` would therefore mean different things per tier.
 *   So the archive read JOINs `chat_messages` on `message_id` and bounds on the
 *   ORIGINAL message's `created_at` / `epoch` — the same columns, and therefore
 *   the same semantics, as the `/chat` surface. The join is INNER on purpose: an
 *   archive row whose original message row is gone cannot have its age proven, and
 *   an unprovable row is excluded from a bounded read (fail-closed). An
 *   unbounded read (human, or grant `full`) never takes this path at all — it
 *   still calls `getArchiveSince`, untouched.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db as sharedDb } from '@/lib/db';
import { chatMessages } from '@/lib/db/schema';
import { grantEpochFloor, grantMessageCount, grantTimeFloor, type HistoryGrant } from '@/lib/historyGrant';
import type { ArchiveCursor, ArchiveRow } from '@/lib/mls/archive';

type DB = typeof sharedDb;

/** Structural executor types, mirroring `./archive` so tests can pass a fake. */
interface SqlExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}
interface Rows<T> {
  rows: T[];
}

/** Concrete bounds, resolved from a grant against one topic's data. */
export interface HistoryWindow {
  /** Inclusive lower bound on the ORIGINAL message's created_at, or null for no bound. */
  createdAfter: Date | null;
  /** Inclusive lower bound on the message's group epoch, or null for no bound. */
  minEpoch: number | null;
}

/** A window that bounds nothing — what a `full` grant or a human resolves to. */
export const UNBOUNDED_WINDOW: HistoryWindow = { createdAfter: null, minEpoch: null };

/**
 * `created_at` of the Nth-newest USER message in a topic, or null when the topic
 * holds fewer than N (nothing to exclude). Used to turn the count-shaped grant
 * (`N` = "the last N messages") into a timestamp bound, which — unlike a page
 * limit — survives pagination: a client walking backwards with `before=` hits the
 * same floor on every page instead of stepping past it.
 *
 * Only `type = 'message'` rows are counted, so N means N real messages; the
 * resulting time window then also admits any join/leave rows inside it. Ties on
 * `created_at` can admit slightly more than N rows — deliberately inclusive, so a
 * message is never split from its own timestamp.
 */
export async function getNewestMessagesCutoff(
  db: DB,
  topicId: string,
  count: number,
): Promise<Date | null> {
  const rows = await db
    .select({ createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(and(eq(chatMessages.topicId, topicId), eq(chatMessages.type, 'message')))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(1)
    .offset(count - 1);
  return rows[0]?.createdAt ?? null;
}

/**
 * Resolve a bounded grant into SQL bounds for one topic. Only the count form
 * costs a query; the day and epoch forms are pure arithmetic.
 */
export async function resolveHistoryWindow(
  db: DB,
  topicId: string,
  grant: HistoryGrant,
  now: Date = new Date(),
): Promise<HistoryWindow> {
  const count = grantMessageCount(grant);
  const createdAfter = count !== null
    ? await getNewestMessagesCutoff(db, topicId, count)
    : grantTimeFloor(grant, now);
  return { createdAfter, minEpoch: grantEpochFloor(grant) };
}

/** True when the window would not exclude anything (skip the windowed path). */
export function isUnboundedWindow(w: HistoryWindow): boolean {
  return w.createdAfter === null && w.minEpoch === null;
}

/**
 * Keyset-paginated archive read BOUNDED by a history window — the grant-gated
 * twin of `getArchiveSince` (`./archive`). Same cursor contract, same ordering,
 * same full-microsecond `created_at` handling; the only additions are the join
 * to `chat_messages` and the window predicates described in the module header.
 * Callers with no window must keep using `getArchiveSince` directly.
 */
export async function getArchiveWindowed(
  executor: SqlExecutor,
  topicId: string,
  cursor: ArchiveCursor | null,
  limit: number,
  window: HistoryWindow,
): Promise<ArchiveRow[]> {
  const conds = [sql`a.topic_id = ${topicId}`];
  if (cursor) {
    conds.push(
      sql`(a.created_at, a.message_id) > (${cursor.createdAt}::timestamptz, ${cursor.messageId}::uuid)`,
    );
  }
  if (window.createdAfter) {
    conds.push(sql`m.created_at >= ${window.createdAfter.toISOString()}::timestamptz`);
  }
  if (window.minEpoch !== null) {
    conds.push(sql`m.epoch >= ${window.minEpoch}`);
  }
  const where = sql.join(conds, sql` AND `);

  const res = (await executor.execute(sql`
    SELECT a.message_id, a.tak_version, a.ciphertext, to_json(a.created_at)#>>'{}' AS created_at
    FROM chat_archive a
    JOIN chat_messages m ON m.id = a.message_id
    WHERE ${where}
    ORDER BY a.created_at ASC, a.message_id ASC
    LIMIT ${limit}
  `)) as Rows<{
    message_id: string;
    tak_version: number;
    ciphertext: Buffer;
    created_at: string;
  }>;
  return res.rows.map((r) => ({
    messageId: r.message_id,
    takVersion: Number(r.tak_version),
    ciphertext: Buffer.from(r.ciphertext),
    createdAt: r.created_at,
  }));
}
