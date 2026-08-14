/**
 * Turning `chat_messages.ciphertext` back into a delivery QUEUE.
 *
 * The live copy is currently storage: every sealed body ever sent is still on
 * the server. That is not what the column is for. WhatsApp keeps an undelivered
 * message for at most 30 days and then deletes it; Signal and Google Messages
 * do the same on delivery. Our history layer is `chat_archive`, which the tier
 * design deliberately retains — this file never touches it.
 *
 * THE GUARD, and why it is not symmetrical with "delivered".
 *
 *     purge only when   delivered to everyone owed   AND   the archive row EXISTS
 *
 * The archive half is UNCONDITIONAL and every path below goes through it,
 * including the grace cap. `archiveOnSend` is fire-and-forget and can fail, and
 * in a one-member topic the delivery half is true the instant the message is
 * sent — so in the case that is easiest to reach, the archive check is the only
 * thing standing between a failed upload and a message that is simply gone.
 *
 * WHO IS OWED. The devices that were in the group AT SEND TIME. A later joiner
 * is not owed the live copy and never could have used it: MLS gives a
 * newly-added leaf no past-epoch secrets, so those rows are undecryptable to it
 * whether or not the server still holds them. This was measured, not reasoned
 * about — web created a topic on one device, sent three messages, mobile joined
 * afterwards and read them, and it read them from `chat_archive`.
 *
 * That also covers the hole in the delivery set itself. A device the server has
 * never heard from is not in `chat_delivery_cursors` and therefore does not
 * block anything — which would be alarming if the archive row were optional.
 * It is not optional, so the worst case for such a device is reading from the
 * archive, which is the path it would have taken anyway.
 *
 * THE LIMIT THAT IS LEFT, stated rather than buried. A device's obligation
 * window starts at its FIRST ACK, because that is the only evidence the server
 * has that it exists — the ratchet tree is client-side. So a member device that
 * is added to the group and then never opens the topic is not owed the messages
 * sent meanwhile, and once the other devices acknowledge them the live copies
 * go. That device can still read them from the archive, which is why this is a
 * degradation and not a loss — but on `private`/`secret` the archive row is
 * opened with a per-epoch TAK, so it depends on that device having received a
 * bundle or grant for those epochs. Before this change it could instead have
 * caught up through the commit log and opened the live copies directly. Closing
 * it properly needs the server to learn a device's JOIN time (not merely its
 * first ack), which is the same missing signal the inactive-leaf pruning needs.
 *
 * WHERE IT RUNS. Same reasoning as `archiveRetentionSweep.ts`, which this file
 * deliberately mirrors: Cloud Run has no reliable in-process timer (staging
 * scales to zero, production runs several instances with no leader election), a
 * scheduled endpoint needs infrastructure and a new required secret, and a
 * required secret missing in any environment takes the service down on boot. So
 * the sweep is REQUEST-TRIGGERED, from the two places where a purge becomes
 * possible: a delivery cursor moving, and an archive row landing. Those are
 * exactly the two preconditions, so the sweep runs when the answer can have
 * changed and not otherwise.
 */
import { sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const MODULE = 'chatDeliveryPurge';

interface SqlExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}
interface Rows<T> {
  rows: T[];
}

/**
 * How long a message waits for a device that never comes back.
 *
 * 30 days, the same figure WhatsApp publishes for undelivered messages: it
 * keeps them encrypted on its servers for up to 30 days while trying to
 * deliver, and deletes them after that
 * (https://www.whatsapp.com/legal/privacy-policy-uk).
 *
 * The cap exists because "delivered to everyone" is a promise a single
 * abandoned device can make unkeepable forever, and because pruning that device
 * out of the MLS tree requires a Remove Commit from another member's client —
 * something no server-side sweep can do or wait for. It relaxes ONLY the
 * delivery half; a message past the cap with no archive row still survives.
 */
export const DELIVERY_GRACE_DAYS = 30;

/**
 * How long a device may be silent before it stops blocking a purge.
 *
 * Shorter than the grace cap on purpose. A device that has not been seen in a
 * week is very likely gone — cleared browser data abandons a leaf that stays in
 * the tree and never acks again — and there is no point holding every message
 * in the topic hostage to it for the full month. It is a floor on
 * `last_seen_at`, not a deletion: the row stays, and the moment that device
 * comes back and acks it counts again.
 */
export const DEVICE_STALE_DAYS = 7;

/** ISO for `now` minus `days`, for use as a SQL floor. */
function floorIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/** One device's standing on one message, for the pure decision below. */
export interface OwedDevice {
  /** When this device first appeared in the topic. */
  firstSeenAt: Date;
  /** Last contact of any kind. Older than the staleness floor → stops blocking. */
  lastSeenAt: Date;
  /** Newest message this device has fetched. INCLUSIVE. */
  deliveredThrough: Date;
  /** False once the account is no longer a member — it is owed nothing. */
  isMember: boolean;
}

export interface PurgeDecisionInput {
  createdAt: Date;
  /** The unconditional half. */
  hasArchiveRow: boolean;
  devices: readonly OwedDevice[];
  now: Date;
  graceDays?: number;
  staleDays?: number;
}

/**
 * May this message's live ciphertext be dropped?
 *
 * Extracted as a pure function because the SQL below is one statement with four
 * predicates in it, and a statement cannot be interrogated about WHY it spared
 * a row. Every rule the query implements is decided here as well, and the tests
 * hold the two to the same answers.
 *
 * R-3b NOTE on `createdAt.getTime()` vs the SQL's `m.created_at`: this
 * function is safe from the millisecond/microsecond mismatch the SQL had to
 * be fixed for, but not because it does anything extra — a JS `Date` cannot
 * represent sub-millisecond time AT ALL, so `createdAt` here has already lost
 * whatever microsecond residue Postgres's real `now()` produced by the time
 * any caller (a route, or this file's own tests) constructs a `Date` from it.
 * The SQL doesn't get that for free: it compares the raw `timestamptz` column
 * value directly, at its native microsecond resolution, which is what let the
 * two diverge — a case only the SQL, not this function, could get wrong. See
 * `purgeDeliveredCiphertext` below.
 */
export function isPurgeable(input: PurgeDecisionInput): boolean {
  const { createdAt, hasArchiveRow, devices, now } = input;
  // The archive row comes first and has no exceptions. Nothing below can
  // override it, which is the whole point of checking it first.
  if (!hasArchiveRow) return false;

  const graceDays = input.graceDays ?? DELIVERY_GRACE_DAYS;
  const staleDays = input.staleDays ?? DEVICE_STALE_DAYS;
  const graceFloor = now.getTime() - graceDays * 86_400_000;
  const staleFloor = now.getTime() - staleDays * 86_400_000;

  // Past the cap: no device can hold this message any longer. The archive row
  // above is what makes that safe rather than lossy.
  if (createdAt.getTime() < graceFloor) return true;

  for (const d of devices) {
    if (!d.isMember) continue; // a removed account is owed nothing
    // Not in the group when this was sent → never owed it (see file header).
    if (d.firstSeenAt.getTime() > createdAt.getTime()) continue;
    // Silent long enough that it is treated as gone.
    if (d.lastSeenAt.getTime() < staleFloor) continue;
    // INCLUSIVE: a cursor exactly at the message's instant has it.
    if (d.deliveredThrough.getTime() < createdAt.getTime()) return false;
  }
  return true;
}

/**
 * Drop the live ciphertext of every message in this topic that no longer needs
 * one, and return how many were dropped.
 *
 * The row itself SURVIVES — only `ciphertext` is nulled. The message id, its
 * order and its author are what the archive is keyed by and what the client
 * renders history against; deleting the row would orphan the archive copy and
 * lose the conversation's shape.
 *
 * `now` is passed in rather than taken from the database so both boundaries are
 * decidable: the same instant defines the grace floor and the staleness floor
 * for the test and for the statement.
 *
 * Integrity, in the order the predicates appear:
 *   - `m.type = 'message'` — system join/leave rows carry public text, not
 *     ciphertext, and are not this column's business.
 *   - `EXISTS (chat_archive …)` — the unconditional guard.
 *   - the grace cap OR nobody outstanding — and "outstanding" excludes devices
 *     that joined after the message, that are stale, or whose account has left.
 */
export async function purgeDeliveredCiphertext(
  executor: SqlExecutor,
  topicId: string,
  now: Date,
  opts?: { graceDays?: number; staleDays?: number },
): Promise<number> {
  const graceFloor = floorIso(now, opts?.graceDays ?? DELIVERY_GRACE_DAYS);
  const staleFloor = floorIso(now, opts?.staleDays ?? DEVICE_STALE_DAYS);
  /*
   * R-3b: compare delivered_through vs. created_at at MILLISECOND resolution,
   * not the column's native microsecond resolution.
   *
   * created_at is set by Postgres's own now() (the schema's defaultNow()) and
   * keeps real microseconds. delivered_through is always written from a JS
   * Date (see the ack route), which cannot represent anything finer than a
   * millisecond in the first place — and a client can only ever have
   * RECEIVED created_at at millisecond resolution too (JSON round-trips a
   * Date through toISOString(), 3 fractional digits). So an honest ack of
   * "delivered through exactly this message" lands up to 999us BEFORE the
   * raw column value; without the trunc that reads as "still owed" forever —
   * the newest acked message in an otherwise-idle room never clears.
   *
   * Truncating BOTH sides is defensive, not load-bearing: delivered_through
   * is already millisecond-exact by construction, but doing it makes the
   * comparison manifestly same-resolution instead of relying on that
   * invariant holding forever at every future write site.
   */
  const res = (await executor.execute(sql`
    UPDATE chat_messages m
    SET ciphertext = NULL
    WHERE m.topic_id = ${topicId}
      AND m.type = 'message'
      AND m.ciphertext IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM chat_archive a
        WHERE a.topic_id = m.topic_id AND a.message_id = m.id
      )
      AND (
        m.created_at < ${graceFloor}::timestamptz
        OR NOT EXISTS (
          SELECT 1 FROM chat_delivery_cursors c
          JOIN topic_members tm
            ON tm.topic_id = c.topic_id AND tm.user_id = c.user_id
          WHERE c.topic_id = m.topic_id
            AND c.first_seen_at <= m.created_at
            AND c.last_seen_at >= ${staleFloor}::timestamptz
            AND date_trunc('milliseconds', c.delivered_through) < date_trunc('milliseconds', m.created_at)
        )
      )
    RETURNING m.id
  `)) as Rows<{ id: string }>;
  return res.rows.length;
}

/**
 * How long a topic is left alone after a purge pass.
 *
 * A minute, not the archive sweep's hour. The two enforce different things: the
 * archive window is measured in days, so an hour of slack is invisible, while
 * this one is chasing a cursor that moves whenever anyone reads the room. Too
 * long here and a busy topic keeps ciphertext well past the moment it stopped
 * being needed — which is the state this whole change is fixing.
 */
export const DELIVERY_SWEEP_INTERVAL_MS = 60 * 1000;

/** Cap on remembered topics — see `archiveRetentionSweep`, same rationale. */
const SWEEP_MEMO_MAX = 5000;

/** topicId → when this instance last swept it. */
const lastSweptAt = new Map<string, number>();

/** Test seam: drop the throttle memo so a case starts from a clean slate. */
export function resetDeliverySweepThrottle(): void {
  lastSweptAt.clear();
}

export interface DeliverySweepResult {
  /** False when the throttle skipped this call — not an error, and not a purge. */
  swept: boolean;
  purged: number;
}

/**
 * Purge this topic's delivered ciphertext, at most once per
 * `DELIVERY_SWEEP_INTERVAL_MS` per instance.
 *
 * The throttle is stamped BEFORE the statement runs, so a burst of acks on one
 * hot topic produces one pass rather than one per request, and a failed pass
 * keeps the stamp — a database refusing this statement will refuse it again a
 * millisecond later, and retrying per request turns one broken query into a
 * storm.
 */
export async function sweepTopicDelivery(
  executor: SqlExecutor,
  topicId: string,
  now: Date,
  opts?: { graceDays?: number; staleDays?: number },
): Promise<DeliverySweepResult> {
  const nowMs = now.getTime();
  const last = lastSweptAt.get(topicId);
  if (last !== undefined && nowMs - last < DELIVERY_SWEEP_INTERVAL_MS) {
    return { swept: false, purged: 0 };
  }

  if (lastSweptAt.size >= SWEEP_MEMO_MAX) {
    const oldest = lastSweptAt.keys().next();
    if (!oldest.done) lastSweptAt.delete(oldest.value);
  }
  lastSweptAt.set(topicId, nowMs);

  const purged = await purgeDeliveredCiphertext(executor, topicId, now, opts);
  if (purged > 0) {
    logger.info(MODULE, 'Purged delivered ciphertext', { topicId, purged });
  }
  return { swept: true, purged };
}

/**
 * Run the sweep beside a request without joining its fate to it.
 *
 * Reclaiming delivered ciphertext is the service's obligation, not the caller's
 * errand: a member acking delivery must not receive a 500 because an UPDATE
 * failed, and must not wait for it either.
 */
export function scheduleDeliverySweep(executor: SqlExecutor, topicId: string, now: Date): void {
  void sweepTopicDelivery(executor, topicId, now).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(MODULE, 'Delivery sweep failed', { topicId, error: message });
  });
}
