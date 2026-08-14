/**
 * Deleting encrypted chat attachments — the half that reaches the OBJECTS.
 *
 * `archiveRetentionSweep.ts` purges `chat_archive` rows on the topic's window.
 * It cannot touch attachments: an attachment's object key lives inside the
 * MLS-sealed message body, so the server cannot read which object a message
 * named, and deleting the row deletes the last thing that was ever going to
 * mention it. The result was a topic set to 30 days that deleted its message
 * ciphertext and kept the pictures indefinitely — worse than having no
 * retention, because it reads as a deletion guarantee.
 *
 * `chat_media` is the index that makes them reachable, and this file is what
 * walks it. Two rules, deliberately separate:
 *
 *   RETENTION  — an attachment older than its topic's window goes, exactly as
 *                its message body does. Mirrors `purgeExpiredArchiveRows`
 *                statement for statement (same `> 0` guard, same strict `<`
 *                boundary, window read from the topic row inside the same
 *                query) so the two can never disagree about what "expired"
 *                means for the same message.
 *   UNCLAIMED  — an upload whose message never went out is collected after a
 *                grace window, regardless of the topic's retention. This is the
 *                only deletion that applies to an UNLIMITED topic, and it has
 *                to: an unlimited topic sweeps nothing, so a stranded object
 *                there would be paid for forever. It never touches a claimed
 *                row, so "unlimited means we delete nothing you can see" stays
 *                true.
 *
 * ORDER MATTERS: the object is deleted BEFORE its row. Delete the row first and
 * a failed object delete strands the object with nothing left to find it by —
 * the exact leak this file exists to close. This way a failure leaves a row
 * pointing at a missing object, and the next sweep retries harmlessly
 * (DeleteObject is idempotent).
 *
 * WHERE IT RUNS: request-triggered, beside the archive sweep, for all the
 * reasons written up in `archiveRetentionSweep.ts` (Cloud Run has no reliable
 * in-process timer at `min-instances=0`, and one per instance above that).
 *
 * ITS LIMITS ARE DOCUMENTED IN ONE PLACE, not two: AGENTS.md, "Chat archive
 * retention" → "the window is a ceiling, not a guarantee". A dormant topic is
 * never swept, and an attachment uploaded before this index existed has no row
 * — nothing ever deletes an object with no row, because treating "no row" as
 * "orphan" would delete live pictures. Read that paragraph before promising
 * anyone a deletion deadline.
 */
import { sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { deleteR2Object, topicObjectPrefix } from '@/lib/r2';

const MODULE = 'chatMediaSweep';

interface SqlExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}
interface Rows<T> {
  rows: T[];
}

/**
 * How long an UNCLAIMED upload is left alone before it is treated as stranded.
 *
 * An hour. The claim lands milliseconds after the upload on any working client,
 * so this is not a timing budget — it is the margin for a client that is slow,
 * offline mid-send, or retrying. Collecting an object a send is still about to
 * reference would delete a picture out from under a message that then renders
 * as permanently broken, so the window errs long: the cost of waiting is one
 * unreferenced object for an hour.
 */
export const CHAT_MEDIA_CLAIM_GRACE_MS = 60 * 60 * 1000;

/** Same cadence as the archive sweep — see ARCHIVE_SWEEP_INTERVAL_MS. */
export const CHAT_MEDIA_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Objects deleted per pass, and passes per sweep. Bounds one request's work. */
const SWEEP_BATCH = 200;
const SWEEP_MAX_PASSES = 10;

/** Cap on remembered topics — see the same memo in archiveRetentionSweep. */
const SWEEP_MEMO_MAX = 5000;
const lastSweptAt = new Map<string, number>();

/** Test seam: drop the throttle memo so a case starts from a clean slate. */
export function resetChatMediaSweepThrottle(): void {
  lastSweptAt.clear();
}

/** Deletes one object from storage. Injected so tests need no R2. */
export type ObjectDeleter = (objectKey: string) => Promise<boolean>;

/**
 * Attachment keys in this topic that have fallen outside ITS OWN window.
 *
 * A SELECT, not a DELETE...RETURNING, because the row must outlive the object:
 * see the ordering note at the top of this file.
 */
export async function selectExpiredChatMedia(
  executor: SqlExecutor,
  topicId: string,
  now: Date,
  limit = SWEEP_BATCH,
): Promise<string[]> {
  const res = (await executor.execute(sql`
    SELECT m.object_key FROM chat_media m
    JOIN topics t ON t.id = m.topic_id
    WHERE m.topic_id = ${topicId}
      AND t.chat_archive_retention_days > 0
      AND m.created_at < ${now.toISOString()}::timestamptz
                         - make_interval(days => t.chat_archive_retention_days)
    LIMIT ${limit}
  `)) as Rows<{ object_key: string }>;
  return res.rows.map((r) => r.object_key);
}

/**
 * Attachment keys in this topic that were uploaded, never claimed, and are past
 * the grace window — an upload whose message POST never landed.
 *
 * Deliberately NOT conditioned on the topic's retention: this is the one
 * collection that has to work on an unlimited topic, where nothing else ever
 * deletes anything.
 */
export async function selectUnclaimedChatMedia(
  executor: SqlExecutor,
  topicId: string,
  now: Date,
  limit = SWEEP_BATCH,
): Promise<string[]> {
  const floor = new Date(now.getTime() - CHAT_MEDIA_CLAIM_GRACE_MS);
  const res = (await executor.execute(sql`
    SELECT object_key FROM chat_media
    WHERE topic_id = ${topicId}
      AND claimed_at IS NULL
      AND created_at < ${floor.toISOString()}::timestamptz
    LIMIT ${limit}
  `)) as Rows<{ object_key: string }>;
  return res.rows.map((r) => r.object_key);
}

/** Drop index rows by key, scoped to the topic. No-op for an empty list. */
export async function deleteChatMediaRows(
  executor: SqlExecutor,
  topicId: string,
  objectKeys: string[],
): Promise<void> {
  if (objectKeys.length === 0) return;
  const list = sql.join(
    objectKeys.map((k) => sql`${k}`),
    sql`, `,
  );
  await executor.execute(sql`
    DELETE FROM chat_media WHERE topic_id = ${topicId} AND object_key IN (${list})
  `);
}

export interface ChatMediaSweepResult {
  /** False when the throttle skipped this call — not an error, and not a purge. */
  swept: boolean;
  /** Objects deleted because their topic's window expired. */
  expired: number;
  /** Objects deleted because they were never claimed by a message. */
  unclaimed: number;
}

async function deleteBatch(
  executor: SqlExecutor,
  topicId: string,
  keys: string[],
  deleteObject: ObjectDeleter,
): Promise<number> {
  /*
   * Confinement, defensively: this process wrote every one of these keys, so a
   * key outside the topic's prefix means the row is corrupt or hand-edited.
   * Refuse it rather than hand an arbitrary path to the object store.
   *
   * The prefix comes from `topicObjectPrefix`, which OWNS where a topic's
   * objects live (M-3). Chat attachments are a subpath of it, so confining to
   * the topic is the property that matters here and there is no second helper
   * that could drift from it.
   *
   * The LEGACY prefix is accepted here and NOWHERE else. M-3 moved chat objects
   * from `chat/{topicId}/…` to `topics/{topicId}/chat/…`, and a row written
   * before that move fails the new check — so it would be refused on every
   * pass, forever, and its object with it. Refusing to delete stale rows is the
   * opposite of what a collector is for. Reads and claims still reject the old
   * shape (those objects are gone), but deletion accepts it precisely because
   * we want it gone, and it stays confined to THIS topic either way.
   */
  const prefix = topicObjectPrefix(topicId);
  const legacyPrefix = `chat/${topicId}/`;
  const safe = keys.filter(
    (k) => typeof k === 'string' && !k.includes('..') && (k.startsWith(prefix) || k.startsWith(legacyPrefix)),
  );
  if (safe.length !== keys.length) {
    logger.warn(MODULE, 'Refusing index rows whose key escapes the topic prefix', {
      topicId,
      refused: keys.length - safe.length,
    });
  }
  if (safe.length === 0) return 0;

  const deleted: string[] = [];
  for (const key of safe) {
    // A missing object is a SUCCESS for our purposes: the goal state is "this
    // object does not exist", and something else having got there first is that
    // state. `deleteR2Object` already answers true for a key that was not
    // present, and false only for a real storage failure — where we keep the
    // row so the next sweep tries again.
    if (await deleteObject(key)) deleted.push(key);
  }
  await deleteChatMediaRows(executor, topicId, deleted);
  return deleted.length;
}

/**
 * Delete this topic's expired and stranded attachments, at most once per
 * `CHAT_MEDIA_SWEEP_INTERVAL_MS` per instance.
 *
 * The throttle is stamped BEFORE the work, so a burst on one hot topic produces
 * one sweep rather than one per request — and a failed sweep keeps the stamp,
 * because a storage backend that is refusing deletes now will refuse them a
 * millisecond from now.
 */
export async function sweepTopicChatMedia(
  executor: SqlExecutor,
  topicId: string,
  now: Date,
  deleteObject: ObjectDeleter = deleteR2Object,
): Promise<ChatMediaSweepResult> {
  const nowMs = now.getTime();
  const last = lastSweptAt.get(topicId);
  if (last !== undefined && nowMs - last < CHAT_MEDIA_SWEEP_INTERVAL_MS) {
    return { swept: false, expired: 0, unclaimed: 0 };
  }
  if (lastSweptAt.size >= SWEEP_MEMO_MAX) {
    const oldest = lastSweptAt.keys().next();
    if (!oldest.done) lastSweptAt.delete(oldest.value);
  }
  lastSweptAt.set(topicId, nowMs);

  let expired = 0;
  let unclaimed = 0;
  // Paged, so a topic with a long backlog drains instead of building one
  // unbounded statement — and bounded, so one request cannot be turned into
  // arbitrarily long work.
  for (let pass = 0; pass < SWEEP_MAX_PASSES; pass++) {
    const keys = await selectExpiredChatMedia(executor, topicId, now);
    if (keys.length === 0) break;
    const n = await deleteBatch(executor, topicId, keys, deleteObject);
    expired += n;
    // Nothing deleted despite rows being returned means storage is refusing:
    // stop rather than spin through the same page ten times.
    if (n === 0) break;
  }
  for (let pass = 0; pass < SWEEP_MAX_PASSES; pass++) {
    const keys = await selectUnclaimedChatMedia(executor, topicId, now);
    if (keys.length === 0) break;
    const n = await deleteBatch(executor, topicId, keys, deleteObject);
    unclaimed += n;
    if (n === 0) break;
  }

  if (expired > 0 || unclaimed > 0) {
    logger.info(MODULE, 'Swept chat attachments', { topicId, expired, unclaimed });
  }
  return { swept: true, expired, unclaimed };
}

/**
 * Run the attachment sweep beside a request without joining its fate to it.
 *
 * Same shape as `scheduleArchiveSweep`: retention is the service's obligation,
 * not the caller's errand, so a member reading history never waits for it and
 * never receives a 500 because a delete failed.
 */
export function scheduleChatMediaSweep(executor: SqlExecutor, topicId: string, now: Date): void {
  void sweepTopicChatMedia(executor, topicId, now).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(MODULE, 'Chat media sweep failed', { topicId, error: message });
  });
}
