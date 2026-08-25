/**
 * Which sessions exist, in Redis, so a session can be ENDED and a second device
 * can be noticed.
 *
 * WHAT WAS MISSING. `createSession` minted a seven-day JWT and forgot it;
 * `verifySession` checked the signature and that the account still existed.
 * Nothing recorded which sessions were alive, so the server could not answer
 * "is another device signed in?" and could not revoke one. Signing out cleared
 * a cookie and the token stayed valid until it expired on its own.
 *
 * Three things depend on this existing:
 *   - a person holds their chat keys on ONE device, so a second sign-in has to
 *     be able to see the first;
 *   - that second sign-in must TELL them the old session will end and wait for
 *     a yes, rather than taking over silently;
 *   - signing out must actually end the session, not merely forget the cookie.
 *
 * REDIS, NOT POSTGRES. A session is a short-lived fact with a natural TTL, and
 * Redis expiring it costs nothing — no sweeper, no `WHERE expires_at > now()`
 * on the hot path, and no table that grows for a year because a cleanup job was
 * never written. The trade is that history is not kept: once a session lapses
 * there is no record it existed. That is the right trade for auth state and the
 * wrong one for an audit log, which this is not.
 *
 * The JWT stays. It still carries identity and its own expiry; this adds the
 * ability to say NO to a token that is otherwise perfectly valid.
 */

import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';

const MODULE = 'sessionStore';

/**
 * Which kind of client holds this session.
 *
 * NEVER derived from the User-Agent — a caller writes that string, so gating
 * anything on it is a request, not a rule. This is decided by WHICH LOGIN PATH
 * minted the session: the app's own endpoint issues `mobile`, the browser flow
 * issues `web`, an API key issues `agent`. Forging a UA then buys nothing.
 */
export type DeviceKind = 'mobile' | 'web' | 'agent';

export interface StoredSession {
  userId: string;
  deviceKind: DeviceKind;
  /** Stable per install/browser. Distinguishes "same phone again" from "a new one". */
  deviceId: string;
  /** Epoch ms. Informational — Redis owns the actual expiry. */
  issuedAt: number;
}

/**
 * How long a session survives WITHOUT USE — refreshed on every request.
 *
 * Sliding, not fixed. A fixed window signs out someone who has used the app
 * every day for a week, at an arbitrary moment, for no reason they can see.
 * Thirty days of silence is a real signal — an abandoned browser, a phone in a
 * drawer — and ending it then is what the expiry is for.
 *
 * The JWT's own `exp` is deliberately LONGER (see `createSession`), because two
 * clocks racing means the shorter one silently wins and the sliding behaviour
 * would only appear to work until the token's fixed date arrived. Redis owns
 * the expiry; the JWT is identity plus a backstop.
 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** One session. The id is the JWT's `jti`. */
function sessionKey(sessionId: string): string {
  return `community:session:${sessionId}`;
}

/**
 * The set of live session ids for one account.
 *
 * Kept beside the sessions because Redis cannot answer "every key matching this
 * user" without `SCAN`, which walks the whole keyspace and is the wrong thing
 * to do on a sign-in. Entries are pruned lazily on read — a set member whose
 * session has expired is simply not there any more.
 */
function userSessionsKey(userId: string): string {
  return `community:sessions:user:${userId}`;
}

/** Record a new session. Never throws: Redis being down must not block a login. */
export async function rememberSession(sessionId: string, session: StoredSession): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(sessionKey(sessionId), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
    await redis.sadd(userSessionsKey(session.userId), sessionId);
    /*
     * The index gets its own TTL, refreshed on every write. Without one it
     * would outlive the last session in it and sit in Redis for ever — a slow
     * leak of one key per account that ever signed in.
     */
    await redis.expire(userSessionsKey(session.userId), SESSION_TTL_SECONDS);
  } catch (e) {
    logger.warn(MODULE, 'could not record session', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Is this session still live?
 *
 * FAILS OPEN. If Redis cannot be reached this returns `true`, so an outage
 * degrades to the behaviour the server had before this file existed rather than
 * signing everybody out at once. A revocation that is missed for the length of
 * an outage is a smaller harm than every account losing its session because a
 * cache blinked.
 */
export async function isSessionLive(sessionId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    /*
     * TOUCH IT. This is the sliding half of the expiry: every verified request
     * pushes the session's death thirty days out again, so the clock measures
     * ABSENCE rather than age. `expire` returns 0 when the key is already gone,
     * which is the same answer `exists` would have given — so one round trip
     * does both jobs.
     */
    const refreshed = await redis.expire(sessionKey(sessionId), SESSION_TTL_SECONDS);
    return refreshed === 1;
  } catch (e) {
    logger.warn(MODULE, 'session liveness unknown; allowing', {
      error: e instanceof Error ? e.message : String(e),
    });
    return true;
  }
}

/**
 * Every live session that HOLDS CHAT KEYS — that is, the `mobile` ones.
 *
 * WHY ONLY MOBILE, and not "everything except agents", which is what this
 * counted first and was wrong.
 *
 * The one-device rule exists for one reason: a person's chat keys live on the
 * device that holds them, so two signed-in devices is not "two devices" but
 * "one that works and one that half does". That reason applies to a phone and
 * to nothing else.
 *
 * A WEB session cannot read a room at all — the middleware refuses `/chat`,
 * `/mls/` and `/tak/` to it, and the keys were never in the browser. Counting
 * it meant someone who opened the site on a laptop to read posts would end the
 * session on their own phone, for a session that holds nothing. That is a rule
 * firing where its reason does not reach.
 *
 * An AGENT is excluded for a related reason: it runs on a server its owner
 * controls and authenticates with an API key, and counting it would make a
 * human unable to sign in anywhere while their bot is running.
 *
 * So the answer is not "which sessions exist" but "which sessions would be
 * broken by a second one" — and that is the phones.
 *
 * Prunes as it reads: an id whose session has expired is dropped from the index
 * rather than left to accumulate.
 */
export async function liveDeviceSessions(userId: string): Promise<
  Array<StoredSession & { sessionId: string }>
> {
  try {
    const redis = getRedis();
    const ids: string[] = await redis.smembers(userSessionsKey(userId));
    if (ids.length === 0) return [];

    const out: Array<StoredSession & { sessionId: string }> = [];
    const dead: string[] = [];
    for (const id of ids) {
      const raw = await redis.get(sessionKey(id));
      if (!raw) {
        dead.push(id);
        continue;
      }
      try {
        const parsed = JSON.parse(raw) as StoredSession;
        // Only a phone can hold chat keys, so only a phone can be displaced.
        if (parsed.deviceKind !== 'mobile') continue;
        out.push({ ...parsed, sessionId: id });
      } catch {
        // A value that is not JSON is a value nothing can act on.
        dead.push(id);
      }
    }
    if (dead.length > 0) await redis.srem(userSessionsKey(userId), ...dead);
    return out;
  } catch (e) {
    logger.warn(MODULE, 'could not list sessions', {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/** End one session. Idempotent — ending an already-dead session is not an error. */
export async function revokeSession(sessionId: string, userId?: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(sessionKey(sessionId));
    if (userId) await redis.srem(userSessionsKey(userId), sessionId);
  } catch (e) {
    logger.warn(MODULE, 'could not revoke session', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * End every session that holds chat keys — the phones.
 *
 * What a new phone calls once the person has confirmed they want the old one
 * ended. Web sessions and agents are left alone for the same reason they are
 * not counted: nothing about them breaks by a second phone existing, and
 * ending them would be a side effect nobody asked for.
 */
export async function revokeDeviceSessions(userId: string): Promise<number> {
  const live = await liveDeviceSessions(userId);
  for (const s of live) await revokeSession(s.sessionId, userId);
  return live.length;
}
