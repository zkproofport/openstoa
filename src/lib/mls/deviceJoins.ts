/**
 * Recording that a device joined a topic, from the Commit that did it (D-1).
 *
 * The decision and the rejected alternatives are in
 * `docs/design/device-join-signal.md`. In short: a device joining is an
 * External Commit, framed as a PublicMessage whose content is NOT encrypted, so
 * the joining leaf can be read out of bytes the server already stores. That
 * makes this signal unforgeable in the way that matters — the commit IS the act
 * of joining, so a member cannot claim another device joined without actually
 * adding it — and it needs no new client code and no MLS crypto.
 *
 * Two callers are waiting on it, which is why it is one table and not two:
 *   - the delivery obligation (R-1) can start a device's window at its JOIN
 *     rather than at its first acknowledgement;
 *   - inactive-leaf eviction can tell an abandoned leaf from a quiet one, and
 *     can name the account that owns it.
 *
 * FIRE-AND-FORGET at the call site, and forgiving here: a commit that has
 * already been recorded, or one that adds no leaf, must never turn a member's
 * accepted Commit into an error. The group's liveness does not depend on this
 * bookkeeping.
 */
import { sql } from 'drizzle-orm';
import { parseJoinerLeaf } from './framing';
import { userIdOfLeaf } from './leafIdentity';
import { logger } from '@/lib/logger';

const MODULE = 'deviceJoins';

interface SqlExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

/** What a Commit told us about the device it added. */
export interface DeviceJoin {
  deviceId: string;
  /** The credential verbatim, or null when it could not be read. */
  leafIdentity: string | null;
  /** The account the credential names, or null when it names none. */
  userId: string | null;
  joinedEpoch: number;
}

/**
 * Read the join out of a Commit, or null when it carries none.
 *
 * Separated from the write so the interesting half — what the bytes say — is
 * testable without a database, and so the route can decide nothing.
 *
 * `epoch` is the NEW epoch the Commit produced, not the one it asserted: the
 * device becomes a member at the epoch that admits it, and recording the
 * asserted one would place the join an epoch early, inside a window it could
 * not read.
 */
export function readDeviceJoin(commit: Buffer | Uint8Array, newEpoch: number): DeviceJoin | null {
  const leaf = parseJoinerLeaf(commit);
  if (!leaf) return null;
  return {
    deviceId: leaf.deviceId,
    leafIdentity: leaf.identity,
    // `userIdOfLeaf` is the ONE place that knows how a credential is shaped;
    // re-deriving it here is how the two would drift.
    userId: leaf.identity === null ? null : userIdOfLeaf(leaf.identity),
    joinedEpoch: newEpoch,
  };
}

/**
 * Record a join. Returns true when a row was written, false when there was
 * nothing to record or the row already existed.
 *
 * `ON CONFLICT DO NOTHING` because the FIRST record is the true one: a device
 * that somehow arrives twice for the same leaf key joined once, and overwriting
 * would move its `joined_at` forward — shrinking the window of messages it is
 * owed, which is the one direction that loses data.
 */
export async function recordDeviceJoin(
  executor: SqlExecutor,
  topicId: string,
  join: DeviceJoin,
): Promise<boolean> {
  const res = (await executor.execute(sql`
    INSERT INTO mls_device_joins (topic_id, device_id, leaf_identity, user_id, joined_epoch)
    VALUES (${topicId}, ${join.deviceId}, ${join.leafIdentity}, ${join.userId}, ${join.joinedEpoch})
    ON CONFLICT (topic_id, device_id) DO NOTHING
    RETURNING device_id
  `)) as { rows: unknown[] };
  return (res.rows?.length ?? 0) > 0;
}

/**
 * Record the join beside an accepted Commit without joining its fate to it.
 *
 * The Commit has already been applied and fanned out by the time this runs. A
 * failure here costs the server a piece of bookkeeping — the device falls back
 * to being discovered at its first acknowledgement, which is exactly today's
 * behaviour — and must not cost the member their Commit.
 */
export function scheduleDeviceJoinRecord(
  executor: SqlExecutor,
  topicId: string,
  commit: Buffer | Uint8Array,
  newEpoch: number,
): void {
  let join: DeviceJoin | null;
  try {
    join = readDeviceJoin(commit, newEpoch);
  } catch {
    return; // a parse that throws is a commit we simply cannot attribute
  }
  if (!join) return; // ordinary Commit: adds no leaf, nothing to record

  void recordDeviceJoin(executor, topicId, join).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(MODULE, 'Device join record failed', { topicId, error: message });
  });
}

/** How far back a newly-opened stream looks for joins it may owe keys for. */
export const JOIN_CATCH_UP_HOURS = 72;
/** Ceiling on one catch-up, so a busy account cannot open a stream and stall. */
export const JOIN_CATCH_UP_LIMIT = 20;

/** A topic that may be waiting on this account for keys, and at which epoch. */
export interface PendingKeyNeeded {
  topicId: string;
  epoch: number;
}

/**
 * Topics this account may owe keys to, for a stream that has just opened.
 *
 * The live fan-out is pub/sub, which is to say VOLATILE: an event published
 * while an account had nothing connected is gone. The host replays deliveries
 * latched while the mini-app was unmounted, but a killed app takes that latch
 * with it — so an account whose only key-holding device was closed at the
 * moment somebody joined would never learn of it, and the newcomer's room would
 * stay locked until an unrelated commit happened to fire another event.
 *
 * `mls_device_joins` already records every join, so the answer is a query
 * rather than a new piece of state to keep. Bounded on both axes: a window,
 * because a join old enough is either resolved or not worth re-attempting on
 * every app launch, and a count, because this runs before the first byte of
 * the stream.
 *
 * The tiers whose keys live only on devices: `private`, `secret` and `dm`. A
 * `public` topic keeps its root on the server, so its newcomers fetch it
 * themselves and no holder needs waking.
 *
 * A DM's row carries `visibility: 'secret'`, so it has always been selected by
 * the filter below — while the comment here claimed DMs were excluded because
 * they "grant on accept", a mechanism that was never built. The SQL was right
 * and the sentence was wrong, which is the more dangerous way round: the test
 * that guarded this asserted the exclusion against a fixture row with
 * `visibility: 'dm'`, a value the schema never produces, so it certified a rule
 * nothing implemented against a shape that cannot occur.
 *
 * Advisory, like the live event: a client that holds nothing for a topic does
 * nothing with it.
 */
export async function pendingKeyNeeded(
  executor: SqlExecutor,
  userId: string,
  limit: number = JOIN_CATCH_UP_LIMIT,
): Promise<PendingKeyNeeded[]> {
  const res = (await executor.execute(sql`
    SELECT j.topic_id AS "topicId", MAX(j.joined_epoch)::bigint AS "epoch"
    FROM mls_device_joins j
    JOIN topic_members m ON m.topic_id = j.topic_id AND m.user_id = ${userId}
    JOIN topics t ON t.id = j.topic_id
    WHERE t.visibility IN ('private', 'secret')
      AND j.joined_at > now() - (${JOIN_CATCH_UP_HOURS} * INTERVAL '1 hour')
    GROUP BY j.topic_id
    ORDER BY MAX(j.joined_at) DESC
    LIMIT ${limit}
  `)) as { rows?: Array<{ topicId: string; epoch: string | number }> } | Array<{ topicId: string; epoch: string | number }>;

  // node-postgres answers `{ rows }`; some drivers answer the array directly.
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  return rows.map((r) => ({ topicId: r.topicId, epoch: Number(r.epoch) }));
}
