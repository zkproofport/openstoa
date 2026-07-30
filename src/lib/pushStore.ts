/**
 * Phase 6 push notifications — data-access layer (design §13, D13 near-blind
 * gateway). Pure DB moves over the `push_tokens` table: the server maps an
 * opaque, client-generated `routing_handle` → OS `push_token` and NEVER stores
 * or touches message content (SI-1 for push). This layer holds tokens only —
 * no keys, no plaintext, no ciphertext.
 *
 * Mirrors the archive.ts convention: a structural `SqlExecutor` is passed in so
 * the SQL runs against the real `db` proxy in the route and a real local
 * Postgres in unit tests (join-heavy queries can't be meaningfully faked).
 */
import { sql } from 'drizzle-orm';
import { filterPushRecipients } from '@/lib/pushPrefs';

interface SqlExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}
interface Rows<T> {
  rows: T[];
}

export type PushPlatform = 'ios' | 'android';

// Envelope caps (SI-4). A routing handle is a client-generated opaque id (a uuid
// or similar); a push token is an Expo/APNs/FCM token string — both are small,
// cap generously and reject abuse.
export const PUSH_HANDLE_MAX_BYTES = 256;
export const PUSH_TOKEN_MAX_BYTES = 1024;

export function isValidPlatform(p: unknown): p is PushPlatform {
  return p === 'ios' || p === 'android';
}

export interface MemberPushTarget {
  userId: string;
  routingHandle: string;
  pushToken: string;
  platform: PushPlatform;
}

/**
 * Register (or rotate) one push token for a user's routing handle. Upsert keyed
 * on (user_id, routing_handle): re-registering the SAME handle rotates the token
 * (and platform) in place instead of creating a duplicate. Returns the row id.
 * Scoped to the session user — the caller can only ever register its OWN token.
 */
export async function upsertToken(
  executor: SqlExecutor,
  userId: string,
  routingHandle: string,
  pushToken: string,
  platform: PushPlatform,
): Promise<string> {
  const res = (await executor.execute(sql`
    INSERT INTO push_tokens (user_id, routing_handle, push_token, platform, created_at, updated_at)
    VALUES (${userId}, ${routingHandle}, ${pushToken}, ${platform}, now(), now())
    ON CONFLICT (user_id, routing_handle)
    DO UPDATE SET push_token = ${pushToken}, platform = ${platform}, updated_at = now()
    RETURNING id
  `)) as Rows<{ id: string }>;
  return res.rows[0]?.id ?? '';
}

/**
 * Unregister/expire one of the caller's tokens by routing handle. Scoped to the
 * session user so a caller can never delete another user's token. Returns the
 * count actually removed (0 if the handle was unknown / already gone).
 */
export async function deleteToken(
  executor: SqlExecutor,
  userId: string,
  routingHandle: string,
): Promise<number> {
  const res = (await executor.execute(sql`
    DELETE FROM push_tokens
    WHERE user_id = ${userId} AND routing_handle = ${routingHandle}
    RETURNING id
  `)) as Rows<{ id: string }>;
  return res.rows.length;
}

/**
 * Fan-out lookup for a content-free dispatch: every push token belonging to a
 * CURRENT member of the topic, EXCLUDING the sender. The inner join to
 * topic_members guarantees non-members contribute no token; the sender filter
 * keeps the author from notifying itself. Returns one entry per registered
 * device (a member may hold several handles).
 *
 * The result is then passed through `filterPushRecipients` (pushPrefs.ts), which
 * drops users who switched notifications off globally (P-M) or muted THIS topic
 * (P-S). The filter lives here, on the single resolver both `push.ts`
 * dispatchers already call, so neither Phase A nor Phase B can forget it and
 * adding a third dispatcher inherits it for free. Preferences fail CLOSED — see
 * `filterPushRecipients`.
 */
export async function getTopicMemberTokens(
  executor: SqlExecutor,
  topicId: string,
  senderUserId: string,
): Promise<MemberPushTarget[]> {
  const res = (await executor.execute(sql`
    SELECT pt.user_id, pt.routing_handle, pt.push_token, pt.platform
    FROM push_tokens pt
    INNER JOIN topic_members tm ON tm.user_id = pt.user_id
    WHERE tm.topic_id = ${topicId}
      AND pt.user_id <> ${senderUserId}
    ORDER BY pt.created_at ASC, pt.id ASC
  `)) as Rows<{ user_id: string; routing_handle: string; push_token: string; platform: string }>;
  const targets: MemberPushTarget[] = res.rows.map((r) => ({
    userId: r.user_id,
    routingHandle: r.routing_handle,
    pushToken: r.push_token,
    platform: r.platform as PushPlatform,
  }));
  return filterPushRecipients(executor, topicId, targets);
}
