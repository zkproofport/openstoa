/**
 * ENFORCEMENT of a topic's chat-archive window — the half that actually deletes.
 *
 * `src/lib/archiveRetention.ts` decides what a window IS; this file makes the
 * server keep the promise. Without it the setting is a label on a table that
 * still grows forever, which is the state this change found the archive in.
 *
 * WHERE IT RUNS, and why it is not a cron. This service is Cloud Run: staging
 * runs at `min-instances=0` (no container exists between requests, so an
 * in-process timer is not merely unreliable, it is usually not running at all)
 * and production at `min-instances=1` with autoscaling (so an in-process timer
 * would run once PER INSTANCE, with no leader election). A scheduled purge
 * therefore has to come from outside — Cloud Scheduler calling an authenticated
 * endpoint — which needs new infrastructure and a new REQUIRED secret, and a
 * required secret that is not yet set in every environment takes the service
 * down on boot (CLAUDE.md forbids papering over that with a fallback).
 *
 * So the sweep is REQUEST-TRIGGERED, from the two archive routes: the topic
 * whose archive is being written to or read from is the topic whose window is
 * checked. The work is bounded (one topic, one indexed DELETE), it needs no new
 * infrastructure, and it runs exactly where the data is being produced and
 * consumed. It is fire-and-forget, so a failed purge can never fail a member's
 * request.
 *
 * Its honest limit: a topic nobody writes to or reads from is never swept, so
 * an abandoned room's expired rows outlive their window until someone touches
 * it. `purgeExpiredArchiveRows` is deliberately a plain exported function with
 * no request in scope, so a Cloud Scheduler endpoint can call it over every
 * topic later without any of this changing.
 */
import { sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const MODULE = 'archiveRetentionSweep';

interface SqlExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}
interface Rows<T> {
  rows: T[];
}

/**
 * How long a topic is left alone after it has been swept.
 *
 * An hour, because the window this enforces is measured in days: a row can
 * outlive its window by at most this long, which is invisible against 30 days
 * and keeps a busy room from issuing a DELETE per message.
 */
export const ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Cap on remembered topics. The throttle is per instance and in memory —
 * deliberately, so the sweep has no Redis dependency and cannot be disabled by
 * Redis being down (staging currently has none at all). The cost of forgetting
 * is one extra DELETE that removes nothing, so evicting the oldest entries when
 * a single instance has seen this many topics is free.
 */
const SWEEP_MEMO_MAX = 5000;

/** topicId → when this instance last swept it. */
const lastSweptAt = new Map<string, number>();

/** Test seam: drop the throttle memo so a case starts from a clean slate. */
export function resetArchiveSweepThrottle(): void {
  lastSweptAt.clear();
}

/**
 * Delete this topic's archive rows that have fallen outside ITS OWN window, and
 * return how many went.
 *
 * The window is read from the topic row inside the same statement rather than
 * passed in, so there is no gap between reading a topic's retention and acting
 * on it — a caller cannot delete under a window the topic no longer has, and a
 * caller cannot pass a window at all.
 *
 * Integrity, both directions:
 *   - `t.id = topicId AND a.topic_id = t.id` — one topic's rows, never another's.
 *   - `a.created_at < floor` is STRICT, so a row exactly at the edge of the
 *     window survives. The forgiving side of the line: the alternative deletes a
 *     message a reader can still see.
 *   - `retention > 0` — an unlimited topic (0, and every topic that predates
 *     this column) matches nothing, so the statement is a no-op there.
 *
 * `now` is passed in rather than taken from the database so the boundary is
 * decidable: the same instant defines the floor for the test and for the query.
 */
export async function purgeExpiredArchiveRows(
  executor: SqlExecutor,
  topicId: string,
  now: Date,
): Promise<number> {
  const res = (await executor.execute(sql`
    DELETE FROM chat_archive a
    USING topics t
    WHERE t.id = ${topicId}
      AND a.topic_id = t.id
      AND t.chat_archive_retention_days > 0
      AND a.created_at < ${now.toISOString()}::timestamptz
                         - make_interval(days => t.chat_archive_retention_days)
    RETURNING a.id
  `)) as Rows<{ id: string }>;
  return res.rows.length;
}

export interface SweepResult {
  /** False when the throttle skipped this call — not an error, and not a purge. */
  swept: boolean;
  deleted: number;
}

/**
 * Purge this topic's expired archive rows, at most once per
 * `ARCHIVE_SWEEP_INTERVAL_MS` per instance.
 *
 * The throttle is stamped BEFORE the delete runs, so a burst of concurrent
 * requests on one hot topic produces one sweep rather than one per request. A
 * failed sweep keeps the stamp for the same reason: a database that is refusing
 * this statement will refuse it again in a millisecond, and retrying on every
 * request turns one broken query into a storm.
 */
export async function sweepTopicArchive(
  executor: SqlExecutor,
  topicId: string,
  now: Date,
): Promise<SweepResult> {
  const nowMs = now.getTime();
  const last = lastSweptAt.get(topicId);
  if (last !== undefined && nowMs - last < ARCHIVE_SWEEP_INTERVAL_MS) {
    return { swept: false, deleted: 0 };
  }

  if (lastSweptAt.size >= SWEEP_MEMO_MAX) {
    // Map iterates in insertion order, so the first key is the least recently
    // ADDED. Good enough for a memo whose worst case is a redundant no-op.
    const oldest = lastSweptAt.keys().next();
    if (!oldest.done) lastSweptAt.delete(oldest.value);
  }
  lastSweptAt.set(topicId, nowMs);

  const deleted = await purgeExpiredArchiveRows(executor, topicId, now);
  if (deleted > 0) {
    logger.info(MODULE, 'Purged expired archive rows', { topicId, deleted });
  }
  return { swept: true, deleted };
}

/**
 * Run the sweep beside a request without joining its fate to it.
 *
 * Retention is the service's obligation, not the caller's errand: a member
 * reading history must not receive a 500 because a DELETE failed, and must not
 * wait for it either. The rejection is logged and swallowed — the same
 * fire-and-forget shape the archive upload itself uses.
 */
export function scheduleArchiveSweep(executor: SqlExecutor, topicId: string, now: Date): void {
  void sweepTopicArchive(executor, topicId, now).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(MODULE, 'Archive sweep failed', { topicId, error: message });
  });
}
