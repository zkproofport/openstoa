/**
 * Push notification PREFERENCES — the global switch (P-M) and the per-topic
 * mute (P-S). Companion to `pushStore.ts` (which owns device tokens) and
 * `push.ts` (which owns dispatch): this module owns *whether* a given user
 * wants a push at all, and nothing else. It never sees message content.
 *
 * Storage shape and why:
 *   - `push_prefs(user_id PK, enabled)` — ONE row per user, written only when
 *     the user actually touches the setting. **Row-absent means enabled**, so
 *     every pre-existing account keeps receiving notifications with no backfill
 *     migration and no "silent opt-out" window during deploy.
 *   - `push_topic_mutes(user_id, topic_id)` — ONE row per muted (user, topic).
 *     **Row-present means muted**; absence is the permissive default, so joining
 *     a topic never has to write a preference row. Mute is an idempotent
 *     `ON CONFLICT DO NOTHING` insert and unmute is a delete, so double-taps and
 *     concurrent toggles converge on the same state instead of erroring.
 *
 * Precedence: the global switch WINS. A user who turned notifications off
 * globally receives nothing even for topics they never muted — `enabled=false`
 * and "muted" are OR-ed into a single exclusion set in `filterPushRecipients`.
 *
 * Dispatch integration: `filterPushRecipients` is called from
 * `pushStore.getTopicMemberTokens`, i.e. on the ONE path both
 * `dispatchDummyForMessage` (Phase A) and `dispatchCiphertextForMessage`
 * (Phase B) already use to resolve recipients — so neither dispatcher can
 * forget it and no new call site is required in `push.ts`. See the note on
 * `filterPushRecipients` for the alternative wiring if `push.ts` is preferred
 * as the integration point.
 */
import { sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const MODULE = 'pushPrefs';

interface SqlExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}
interface Rows<T> {
  rows: T[];
}

/** Thrown for input the caller must reject with a 400 (never a 500). */
export class PushPrefsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushPrefsValidationError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strict uuid guard for `topic_id`. The length check runs FIRST so a megabyte
 * of hostile input is rejected without ever touching the regex or the driver —
 * `topic_id` is a Postgres `uuid` column, so binding anything else would raise
 * 22P02 and surface as a 500 instead of a 400.
 */
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && v.length === 36 && UUID_RE.test(v);
}

/** Result of a mute/unmute. `changed` is false when the state already matched. */
export interface MuteResult {
  /** The state AFTER the call (what the client should render). */
  muted: boolean;
  /** Whether this call actually wrote/removed a row (idempotency signal). */
  changed: boolean;
}

export interface PushPreferences {
  /** Global switch. True (the default) unless the user turned it off. */
  enabled: boolean;
  /** Topic ids this user muted individually. Empty for a fresh account. */
  mutedTopicIds: string[];
}

/**
 * Read the global switch. A user with no row has never touched the setting and
 * is therefore ENABLED — the permissive default that keeps existing users
 * unaffected.
 */
export async function getGlobalPushEnabled(
  executor: SqlExecutor,
  userId: string,
): Promise<boolean> {
  const res = (await executor.execute(sql`
    SELECT enabled FROM push_prefs WHERE user_id = ${userId}
  `)) as Rows<{ enabled: boolean }>;
  if (res.rows.length === 0) return true;
  return res.rows[0].enabled === true;
}

/**
 * Set the global switch (upsert). Idempotent: setting the same value twice
 * leaves exactly one row and returns the same result, so a double-tap or two
 * concurrent toggles converge instead of duplicating. Returns the stored value
 * as read back from the database, never the requested one, so the caller can
 * never report a state the DB did not accept.
 */
export async function setGlobalPushEnabled(
  executor: SqlExecutor,
  userId: string,
  enabled: boolean,
): Promise<boolean> {
  if (typeof enabled !== 'boolean') {
    throw new PushPrefsValidationError('enabled must be a boolean');
  }
  const res = (await executor.execute(sql`
    INSERT INTO push_prefs (user_id, enabled, updated_at)
    VALUES (${userId}, ${enabled}, now())
    ON CONFLICT (user_id) DO UPDATE SET enabled = ${enabled}, updated_at = now()
    RETURNING enabled
  `)) as Rows<{ enabled: boolean }>;
  return res.rows[0]?.enabled === true;
}

/** Every topic this user muted, oldest mute first. Empty array when none. */
export async function listMutedTopicIds(
  executor: SqlExecutor,
  userId: string,
): Promise<string[]> {
  const res = (await executor.execute(sql`
    SELECT topic_id FROM push_topic_mutes
    WHERE user_id = ${userId}
    ORDER BY created_at ASC, topic_id ASC
  `)) as Rows<{ topic_id: string }>;
  return res.rows.map((r) => r.topic_id);
}

/**
 * Is this one topic muted for this user? A non-uuid topic id can never have a
 * mute row (the column is `uuid`), so it is answered as "not muted" WITHOUT a
 * query rather than raising 22P02.
 */
export async function isTopicMuted(
  executor: SqlExecutor,
  userId: string,
  topicId: string,
): Promise<boolean> {
  if (!isUuid(topicId)) return false;
  const res = (await executor.execute(sql`
    SELECT 1 AS one FROM push_topic_mutes
    WHERE user_id = ${userId} AND topic_id = ${topicId}::uuid
    LIMIT 1
  `)) as Rows<{ one: number }>;
  return res.rows.length > 0;
}

/**
 * Mute (`muted=true`) or unmute (`muted=false`) one topic for one user. Both
 * directions are idempotent — mute uses `ON CONFLICT DO NOTHING` and unmute is
 * a plain delete — so repeating a call is a no-op that still reports the
 * correct final state (`changed=false`). Scoped to `userId`: a caller can only
 * ever change its OWN mute.
 *
 * Throws `PushPrefsValidationError` for a non-uuid topic id so the route can
 * answer 400; it never lets malformed input reach the driver.
 */
export async function setTopicMuted(
  executor: SqlExecutor,
  userId: string,
  topicId: string,
  muted: boolean,
): Promise<MuteResult> {
  if (!isUuid(topicId)) {
    throw new PushPrefsValidationError('topicId must be a UUID');
  }
  if (typeof muted !== 'boolean') {
    throw new PushPrefsValidationError('muted must be a boolean');
  }
  if (muted) {
    const res = (await executor.execute(sql`
      INSERT INTO push_topic_mutes (user_id, topic_id, created_at)
      VALUES (${userId}, ${topicId}::uuid, now())
      ON CONFLICT (user_id, topic_id) DO NOTHING
      RETURNING user_id
    `)) as Rows<{ user_id: string }>;
    return { muted: true, changed: res.rows.length > 0 };
  }
  const res = (await executor.execute(sql`
    DELETE FROM push_topic_mutes
    WHERE user_id = ${userId} AND topic_id = ${topicId}::uuid
    RETURNING user_id
  `)) as Rows<{ user_id: string }>;
  return { muted: false, changed: res.rows.length > 0 };
}

/** Both preference surfaces in one read (what the settings UI needs). */
export async function getPushPreferences(
  executor: SqlExecutor,
  userId: string,
): Promise<PushPreferences> {
  const [enabled, mutedTopicIds] = await Promise.all([
    getGlobalPushEnabled(executor, userId),
    listMutedTopicIds(executor, userId),
  ]);
  return { enabled, mutedTopicIds };
}

/**
 * DISPATCH-SIDE FILTER — given the candidate recipients for a topic, drop every
 * user who turned notifications off globally OR muted this topic. The global
 * switch wins: the two conditions are OR-ed into one exclusion set, so
 * `enabled=false` excludes a user even for a topic they never muted.
 *
 * Generic over the target shape (anything carrying `userId`) so it works for
 * both the Phase A and Phase B fan-out without importing `pushStore` — that
 * also keeps the dependency one-way (`pushStore` → `pushPrefs`) with no cycle.
 *
 * **Fails CLOSED.** If the preference lookup itself errors, NOBODY is returned
 * and the failure is logged at error level. Sending to a user who explicitly
 * turned notifications off is a broken promise; a missed notification is not.
 * (Practically, a preference-query error means a bug or a DB outage — and in an
 * outage the recipient lookup that precedes this has already failed.)
 *
 * Wiring: called from `pushStore.getTopicMemberTokens`, the single recipient
 * resolver both dispatchers already use. If `push.ts` is preferred as the
 * integration point instead, drop the call in `pushStore` and add this line to
 * each dispatcher after `getTopicMemberTokens(...)`:
 *
 *     const targets = await filterPushRecipients(db, topicId, rawTargets);
 *
 * Doing BOTH is harmless — the filter is idempotent.
 */
export async function filterPushRecipients<T extends { userId: string }>(
  executor: SqlExecutor,
  topicId: string,
  targets: readonly T[],
): Promise<T[]> {
  if (targets.length === 0) return [];
  try {
    const userIds = [...new Set(targets.map((t) => t.userId))];
    const idList = sql.join(
      userIds.map((u) => sql`${u}`),
      sql`, `,
    );
    // A non-uuid topic id can hold no mute rows, so only the global switch is
    // consulted — querying `topic_id = <not a uuid>` would raise 22P02.
    const query = isUuid(topicId)
      ? sql`
          SELECT user_id FROM push_prefs
          WHERE enabled = false AND user_id IN (${idList})
          UNION
          SELECT user_id FROM push_topic_mutes
          WHERE topic_id = ${topicId}::uuid AND user_id IN (${idList})
        `
      : sql`
          SELECT user_id FROM push_prefs
          WHERE enabled = false AND user_id IN (${idList})
        `;
    const res = (await executor.execute(query)) as Rows<{ user_id: string }>;
    const excluded = new Set(res.rows.map((r) => r.user_id));
    if (excluded.size === 0) return [...targets];
    return targets.filter((t) => !excluded.has(t.userId));
  } catch (err) {
    // Fail closed — never notify someone whose preference we could not read.
    logger.error(MODULE, 'push preference lookup failed — dropping ALL recipients', {
      topicId,
      candidates: targets.length,
      err: String(err),
    });
    return [];
  }
}
