/**
 * Sessions are recorded, expire by ABSENCE, and can be ended.
 *
 * WHAT THIS GUARDS. Before the store existed, `createSession` minted a
 * seven-day JWT and forgot it: signing out cleared a cookie while the token
 * stayed valid, and the server could not answer "is another device signed in?".
 * Every case here is one of those two properties.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → `isSessionLive` REFRESHES on every check (the sliding half)
 *   boundary   → a session with no other devices; one; several; only agents
 *   empty      → unknown id, empty id, a user with nothing recorded
 *   hostile    → a stored value that is not JSON, a member whose session is gone
 *   race       → revoking twice, revoking something already expired
 *   external   → Redis unreachable fails OPEN for liveness, CLOSED for listing
 *   integrity  → agents are never counted as a device
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** A Redis stand-in with only the commands this module uses. */
class FakeRedis {
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  ttls = new Map<string, number>();
  /** Commands that should throw, to simulate an outage. */
  failing = new Set<string>();
  expireCalls: Array<[string, number]> = [];

  private guard(cmd: string) {
    if (this.failing.has(cmd)) throw new Error(`redis ${cmd} unavailable`);
  }
  async set(k: string, v: string, _mode: string, ttl: number) {
    this.guard('set');
    this.strings.set(k, v);
    this.ttls.set(k, ttl);
    return 'OK';
  }
  async get(k: string) {
    this.guard('get');
    return this.strings.get(k) ?? null;
  }
  async del(k: string) {
    this.guard('del');
    this.strings.delete(k);
    return 1;
  }
  async expire(k: string, ttl: number) {
    this.guard('expire');
    this.expireCalls.push([k, ttl]);
    if (!this.strings.has(k) && !this.sets.has(k)) return 0;
    this.ttls.set(k, ttl);
    return 1;
  }
  async sadd(k: string, m: string) {
    this.guard('sadd');
    const s = this.sets.get(k) ?? new Set<string>();
    s.add(m);
    this.sets.set(k, s);
    return 1;
  }
  async srem(k: string, ...members: string[]) {
    this.guard('srem');
    const s = this.sets.get(k);
    if (!s) return 0;
    for (const m of members) s.delete(m);
    return members.length;
  }
  async smembers(k: string) {
    this.guard('smembers');
    return [...(this.sets.get(k) ?? [])];
  }
}

const redis = new FakeRedis();

vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  rememberSession,
  isSessionLive,
  liveDeviceSessions,
  revokeSession,
  revokeDeviceSessions,
  SESSION_TTL_SECONDS,
  type StoredSession,
} from '@/lib/sessionStore';

function session(over: Partial<StoredSession> = {}): StoredSession {
  return {
    userId: '0xalice',
    deviceKind: 'mobile',
    deviceId: 'phone-1',
    issuedAt: 1_700_000_000_000,
    ...over,
  };
}

beforeEach(() => {
  redis.strings.clear();
  redis.sets.clear();
  redis.ttls.clear();
  redis.failing.clear();
  redis.expireCalls = [];
});

describe('recording a session', () => {
  it('stores it with the TTL and indexes it under the account', async () => {
    await rememberSession('s1', session());
    expect(await isSessionLive('s1')).toBe(true);
    expect((await liveDeviceSessions('0xalice')).map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('CONTRACT: the index carries a TTL of its own', async () => {
    // Without one it outlives the last session in it and leaks a key per
    // account that ever signed in.
    await rememberSession('s1', session());
    expect(redis.ttls.get('community:sessions:user:0xalice')).toBe(SESSION_TTL_SECONDS);
  });

  it('EXTERNAL: Redis down must not block a login', async () => {
    redis.failing.add('set');
    await expect(rememberSession('s1', session())).resolves.toBeUndefined();
  });
});

describe('liveness slides the expiry', () => {
  it('CONTRACT: every check REFRESHES the TTL — the clock measures absence, not age', async () => {
    await rememberSession('s1', session());
    redis.expireCalls = [];
    await isSessionLive('s1');
    await isSessionLive('s1');
    expect(redis.expireCalls).toEqual([
      ['community:session:s1', SESSION_TTL_SECONDS],
      ['community:session:s1', SESSION_TTL_SECONDS],
    ]);
  });

  it('EMPTY: an unknown id is not live', async () => {
    expect(await isSessionLive('never-existed')).toBe(false);
    expect(await isSessionLive('')).toBe(false);
  });

  it('EXTERNAL: an unreachable Redis fails OPEN', async () => {
    // A cache blinking must not sign every account out at once. Missing a
    // revocation for the length of an outage is the smaller harm.
    await rememberSession('s1', session());
    redis.failing.add('expire');
    expect(await isSessionLive('s1')).toBe(true);
  });
});

describe('which devices an account has', () => {
  it('BOUNDARY: none, one, several phones', async () => {
    expect(await liveDeviceSessions('0xnobody')).toEqual([]);
    await rememberSession('s1', session());
    expect(await liveDeviceSessions('0xalice')).toHaveLength(1);
    await rememberSession('s2', session({ deviceId: 'phone-2' }));
    expect(await liveDeviceSessions('0xalice')).toHaveLength(2);
  });

  it('INTEGRITY: a WEB session is not a device — it holds no keys', async () => {
    /*
     * The rule fired where its reason did not reach. Someone opening the site
     * on a laptop to read posts would have ended the session on their own
     * phone, over a session that cannot read a room at all: the middleware
     * refuses chat to a web token and the keys were never in the browser.
     */
    await rememberSession('w1', session({ deviceKind: 'web', deviceId: 'laptop' }));
    expect(await liveDeviceSessions('0xalice')).toEqual([]);

    await rememberSession('s1', session());
    // The phone is the only thing listed, and the laptop is untouched.
    expect((await liveDeviceSessions('0xalice')).map((s) => s.sessionId)).toEqual(['s1']);
    expect(await isSessionLive('w1')).toBe(true);
  });

  it('INTEGRITY: agents are never counted as a device', async () => {
    // An agent runs on a server its owner controls and authenticates with an
    // API key. Counting it would make a human unable to sign in anywhere while
    // their bot is running.
    await rememberSession('a1', session({ deviceKind: 'agent', deviceId: 'ai' }));
    await rememberSession('a2', session({ deviceKind: 'agent', deviceId: 'ai-2' }));
    expect(await liveDeviceSessions('0xalice')).toEqual([]);
  });

  it('prunes ids whose session has expired', async () => {
    await rememberSession('s1', session());
    await rememberSession('s2', session({ deviceId: 'phone-2' }));
    // s2's record lapses; the index still names it.
    redis.strings.delete('community:session:s2');
    expect((await liveDeviceSessions('0xalice')).map((s) => s.sessionId)).toEqual(['s1']);
    expect(await redis.smembers('community:sessions:user:0xalice')).toEqual(['s1']);
  });

  it('HOSTILE: a stored value that is not JSON is dropped, not thrown', async () => {
    await rememberSession('s1', session());
    redis.strings.set('community:session:s1', 'not json at all');
    expect(await liveDeviceSessions('0xalice')).toEqual([]);
  });

  it('EXTERNAL: an unreachable Redis lists nothing rather than guessing', async () => {
    await rememberSession('s1', session());
    redis.failing.add('smembers');
    expect(await liveDeviceSessions('0xalice')).toEqual([]);
  });
});

describe('ending a session', () => {
  it('a revoked session is no longer live', async () => {
    await rememberSession('s1', session());
    await revokeSession('s1', '0xalice');
    expect(await isSessionLive('s1')).toBe(false);
    expect(await liveDeviceSessions('0xalice')).toEqual([]);
  });

  it('RACE: revoking twice, and revoking something already gone, are not errors', async () => {
    await rememberSession('s1', session());
    await revokeSession('s1', '0xalice');
    await expect(revokeSession('s1', '0xalice')).resolves.toBeUndefined();
    await expect(revokeSession('never-existed')).resolves.toBeUndefined();
  });

  it('takeover ends every PHONE session and reports how many', async () => {
    await rememberSession('s1', session());
    await rememberSession('s2', session({ deviceId: 'phone-2' }));
    await rememberSession('w1', session({ deviceKind: 'web', deviceId: 'laptop' }));
    await rememberSession('a1', session({ deviceKind: 'agent', deviceId: 'ai' }));

    expect(await revokeDeviceSessions('0xalice')).toBe(2);
    expect(await isSessionLive('s1')).toBe(false);
    expect(await isSessionLive('s2')).toBe(false);
    /*
     * INTEGRITY: the laptop and the bot both survive. A person moving to a new
     * phone did not ask to be signed out of the website, and did not ask for
     * their agent to stop — neither of those breaks by the new phone existing,
     * so neither is a side effect this may have.
     */
    expect(await isSessionLive('w1')).toBe(true);
    expect(await isSessionLive('a1')).toBe(true);
  });

  it('BOUNDARY: revoking when there is nothing to revoke reports zero', async () => {
    expect(await revokeDeviceSessions('0xnobody')).toBe(0);
  });
});
