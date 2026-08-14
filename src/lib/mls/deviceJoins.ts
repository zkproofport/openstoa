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
