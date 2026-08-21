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
 * How long a last-known-good exclusion observation stays usable while the
 * preference store is unreachable. Opt-outs change on human timescales, so a
 * six-hour-old "this user muted this topic" is still far better evidence than
 * no evidence at all. Bounded so a permanently broken store cannot pin stale
 * state forever.
 */
const DEGRADED_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Hard cap on cached topics so the map cannot grow without bound. */
const DEGRADED_CACHE_MAX_TOPICS = 2000;

interface CachedExclusions {
  at: number;
  /** Users last observed with the GLOBAL switch off. */
  globalOff: Set<string>;
  /** Users last observed muting THIS topic. */
  muted: Set<string>;
}

/**
 * Last-known-good exclusions per topic, written only from a query that actually
 * SUCCEEDED. Read only on the degraded path. Per-process and cold on a fresh
 * Cloud Run instance — deliberately best-effort, never a source of truth.
 */
const degradedCache = new Map<string, CachedExclusions>();

function rememberExclusions(
  topicId: string,
  patch: Partial<Pick<CachedExclusions, 'globalOff' | 'muted'>>,
): void {
  const prev = degradedCache.get(topicId);
  const next: CachedExclusions = {
    at: Date.now(),
    globalOff: patch.globalOff ?? prev?.globalOff ?? new Set<string>(),
    muted: patch.muted ?? prev?.muted ?? new Set<string>(),
  };
  degradedCache.delete(topicId);
  degradedCache.set(topicId, next);
  // Map preserves insertion order, so the first key is the oldest write.
  while (degradedCache.size > DEGRADED_CACHE_MAX_TOPICS) {
    const oldest = degradedCache.keys().next();
    if (oldest.done) break;
    degradedCache.delete(oldest.value);
  }
}

function recallExclusions(topicId: string): CachedExclusions | undefined {
  const hit = degradedCache.get(topicId);
  if (!hit) return undefined;
  if (Date.now() - hit.at > DEGRADED_CACHE_TTL_MS) {
    degradedCache.delete(topicId);
    return undefined;
  }
  return hit;
}

/** Test hook: drop every cached observation so cases cannot leak into each other. */
export function __resetPushPrefsDegradedCache(): void {
  degradedCache.clear();
}

/** Which preference dimension a degraded read is standing in for. */
type PrefDimension = 'global' | 'mute';

/**
 * Run one preference sub-query. On success the answer is AUTHORITATIVE and is
 * cached. On failure it logs loudly and falls back to the last-known-good
 * observation for this (topic, dimension), or to "no evidence of an opt-out"
 * when there is none.
 */
async function readExclusionSet(
  executor: SqlExecutor,
  topicId: string,
  dimension: PrefDimension,
  query: ReturnType<typeof sql>,
): Promise<{ users: Set<string>; degraded: boolean }> {
  try {
    const res = (await executor.execute(query)) as Rows<{ user_id: string }>;
    const users = new Set(res.rows.map((r) => r.user_id));
    rememberExclusions(topicId, dimension === 'global' ? { globalOff: users } : { muted: users });
    return { users, degraded: false };
  } catch (err) {
    const cached = recallExclusions(topicId);
    const fallback = (dimension === 'global' ? cached?.globalOff : cached?.muted) ?? new Set<string>();
    logger.error(MODULE, 'PUSH_PREFS_DEGRADED push preference lookup failed', {
      dimension,
      topicId,
      // The recovery posture, spelled out so a log reader does not have to
      // reconstruct it from the code.
      fallback: cached ? 'last-known-good exclusions' : 'none — delivering to unseen users',
      fallbackExcluded: fallback.size,
      cachedAgeMs: cached ? Date.now() - cached.at : null,
      err: String(err),
    });
    return { users: fallback, degraded: true };
  }
}

/**
 * DISPATCH-SIDE FILTER — given the candidate recipients for a topic, drop every
 * user who turned notifications off globally OR muted this topic. The global
 * switch wins: the two conditions are OR-ed into one exclusion set, so
 * `enabled=false` excludes a user even for a topic they never muted.
 *
 * Generic over the target shape (anything carrying `userId`) so it works for
 * both the Phase A and Phase B fan-out without importing `pushStore` — that
 * also keeps the dependency one-way (`pushStore` -> `pushPrefs`) with no cycle.
 *
 * ## Failure posture: closed on the OPT-OUT signal, degraded on INFRASTRUCTURE
 *
 * This function used to wrap everything in one try/catch and `return []` on any
 * error. That is wrong, and it caused a real outage class: `push_prefs` and
 * `push_topic_mutes` are the LAST step of the fan-out, so a single unreadable
 * table (an unapplied migration, a connection blip, a statement timeout) turned
 * every push for every topic into a silent no-op while chat itself kept
 * answering 200. Nothing user-visible broke, so nobody looked.
 *
 * The distinction that matters is what the error actually tells us:
 *
 *  - A query that SUCCEEDS is the opt-out signal. Its answer is authoritative
 *    and we fail CLOSED on it: a user it names is dropped, full stop. Both
 *    tables encode denial as ROW-PRESENT (`enabled = false` / a mute row), so a
 *    successful read genuinely distinguishes "opted out" from "never asked".
 *  - A query that THROWS is not an opt-out signal at all. It carries zero
 *    information about anyone's preference. Converting "we could not ask" into
 *    "everyone said no" is not conservative, it is an outage: unbounded in
 *    blast radius (the whole fleet), unbounded in duration (until someone
 *    notices push is gone), and indistinguishable from working software.
 *
 * So an infrastructure failure degrades instead of denying:
 *
 *  1. The two dimensions are read INDEPENDENTLY, so a broken `push_topic_mutes`
 *    can no longer discard the global switch (and vice versa). Partial
 *    knowledge is still knowledge.
 *  2. A failed dimension falls back to the last exclusion set we actually
 *    OBSERVED for this topic (`degradedCache`, TTL-bounded). A user whose
 *    opt-out this process has seen stays opted out through the outage.
 *  3. Only users for whom we have never observed a denial are delivered to.
 *    That bounds the cost of the fault to "a user who opted out on another
 *    instance, or before this one started, may get one notification during an
 *    outage" — recoverable, self-limiting, and visible in the logs — instead of
 *    "nobody anywhere receives anything, silently, forever".
 *  4. Every degraded read logs at ERROR with the greppable marker
 *    `PUSH_PREFS_DEGRADED`, naming the dimension and the fallback used. The old
 *    code logged too, but the log was the ONLY symptom; now the log is a
 *    warning about a bounded degradation rather than the sole trace of a
 *    total outage.
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
  const userIds = [...new Set(targets.map((t) => t.userId))];
  const idList = sql.join(
    userIds.map((u) => sql`${u}`),
    sql`, `,
  );

  const globalRead = readExclusionSet(
    executor,
    topicId,
    'global',
    sql`SELECT user_id FROM push_prefs WHERE enabled = false AND user_id IN (${idList})`,
  );
  // A non-uuid topic id can hold no mute rows, so the mute dimension is skipped
  // entirely — querying `topic_id = <not a uuid>` would raise 22P02, and that
  // synthetic error must not look like an infrastructure fault in the logs.
  const muteRead = isUuid(topicId)
    ? readExclusionSet(
        executor,
        topicId,
        'mute',
        sql`SELECT user_id FROM push_topic_mutes WHERE topic_id = ${topicId}::uuid AND user_id IN (${idList})`,
      )
    : Promise.resolve({ users: new Set<string>(), degraded: false });

  const [globalOff, muted] = await Promise.all([globalRead, muteRead]);
  const excluded = new Set([...globalOff.users, ...muted.users]);
  if (excluded.size === 0) return [...targets];
  return targets.filter((t) => !excluded.has(t.userId));
}
