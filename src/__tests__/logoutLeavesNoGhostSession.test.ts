/*
 * Three sign-outs and three sign-ins leave ONE live session, not four.
 *
 * THE DEFECT, seen on a phone. The host cleared its token locally and never
 * called `/api/auth/logout`, so each cycle left the previous record live in
 * Redis. The next sign-in found them through `liveDeviceSessions`, called them
 * other devices, and showed "This will sign out your other phone" — naming
 * phones that do not exist and warning that the chat keys went with them.
 *
 * WHY THE COUNT, AND WHY THREE. `sessionStore.test.ts` covers this module
 * thoroughly — thirty-odd cases across liveness, listing, revocation, outages
 * and hostile values — and every one of them passed while this was happening.
 * They ask what ONE call does. The defect only exists in the shape of a
 * SEQUENCE, so one cycle cannot show it: after a single logout-that-does-nothing
 * followed by a login, the account has two sessions, which is indistinguishable
 * from a person who genuinely owns two phones. At three it is unambiguous.
 *
 * That is the axis the whole family of defects found today shares, and the axis
 * no existing test used: repetition. A case that acts once cannot fail the way
 * production failed.
 *
 * SAME DEVICE THROUGHOUT. The phone does not change, so `deviceId` is constant.
 * Anything the account accumulates beyond one session is a ghost of itself.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   repetition (THE guard) → three cycles → one live session
 *   contract   → a logout that reaches the server removes exactly its own record
 *   integrity  → a genuinely second phone is NOT collapsed away by the same code
 *   boundary   → one cycle, which is the case that cannot distinguish the bug
 *   race       → logging out a session that is already gone is not an error
 *   empty      → an account that never signed in lists nothing
 *   N/A        → hostile / UTF-8 / large: no user text on this path
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Redis stand-in, same shape as the one in `sessionStore.test.ts`. */
class FakeRedis {
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  async set(k: string, v: string, _mode?: string, _ttl?: number) {
    this.strings.set(k, v);
    return 'OK';
  }
  async get(k: string) {
    return this.strings.get(k) ?? null;
  }
  async del(k: string) {
    this.strings.delete(k);
    return 1;
  }
  async expire() {
    return 1;
  }
  async sadd(k: string, m: string) {
    const s = this.sets.get(k) ?? new Set<string>();
    s.add(m);
    this.sets.set(k, s);
    return 1;
  }
  async srem(k: string, ...members: string[]) {
    const s = this.sets.get(k);
    if (!s) return 0;
    for (const m of members) s.delete(m);
    return members.length;
  }
  async smembers(k: string) {
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
  liveDeviceSessions,
  revokeSession,
  type StoredSession,
} from '@/lib/sessionStore';

const USER = '0xphone-owner';
const PHONE = 'phone-a';

function stored(deviceId = PHONE): StoredSession {
  return {
    userId: USER,
    deviceKind: 'mobile',
    deviceId,
    issuedAt: Date.now(),
  } as StoredSession;
}

let n = 0;
const nextSessionId = () => `sess-${(n += 1)}`;

/** One sign-in. Returns the session id the phone now holds. */
async function signIn(deviceId = PHONE): Promise<string> {
  const id = nextSessionId();
  await rememberSession(id, stored(deviceId));
  return id;
}

/** One sign-out, as the FIXED host does it: tell the server. */
async function signOut(sessionId: string): Promise<void> {
  await revokeSession(sessionId, USER);
}

/** One sign-out, as the BROKEN host did it: clear locally, tell nobody. */
async function signOutLocallyOnly(_sessionId: string): Promise<void> {
  // Deliberately empty. This is the whole defect.
}

beforeEach(() => {
  redis.strings.clear();
  redis.sets.clear();
});

describe('signing out leaves no ghost of this phone', () => {
  it('REPETITION: three logout/login cycles leave exactly one live session', async () => {
    let id = await signIn();
    for (let i = 0; i < 3; i++) {
      await signOut(id);
      id = await signIn();
    }

    const live = await liveDeviceSessions(USER);
    expect(live).toHaveLength(1);
    expect(live[0].sessionId).toBe(id);
  });

  it('REPETITION: the broken shape accumulates, which is how this was found', async () => {
    /*
     * The counter-example, kept because it names the defect rather than
     * describing it. Four sessions for one phone is what the account looked like
     * when the person was asked to sign out a phone they do not own.
     */
    let id = await signIn();
    for (let i = 0; i < 3; i++) {
      await signOutLocallyOnly(id);
      id = await signIn();
    }

    expect(await liveDeviceSessions(USER)).toHaveLength(4);
  });

  it('BOUNDARY: one cycle cannot tell the two apart — which is why three', async () => {
    // Documented rather than assumed: after a single broken cycle the account
    // holds two sessions, and two is what a person with two phones has.
    const first = await signIn();
    await signOutLocallyOnly(first);
    await signIn();

    expect(await liveDeviceSessions(USER)).toHaveLength(2);
  });

  it('CONTRACT: a logout removes exactly its own record', async () => {
    const a = await signIn('phone-a');
    const b = await signIn('phone-b');

    await signOut(a);

    const live = await liveDeviceSessions(USER);
    expect(live.map((s) => s.sessionId)).toEqual([b]);
  });

  it('INTEGRITY: a genuinely second phone still shows as a second phone', async () => {
    /*
     * The guard against over-correcting. Ending ghosts must not end real
     * devices — the takeover prompt exists for a reason and has to still fire.
     */
    const mine = await signIn('phone-a');
    await signIn('phone-b');

    const live = await liveDeviceSessions(USER);
    expect(live).toHaveLength(2);
    expect(live.some((s) => s.sessionId === mine)).toBe(true);
  });

  it('RACE: signing out a session that is already gone is not an error', async () => {
    const id = await signIn();
    await signOut(id);

    await expect(signOut(id)).resolves.toBeUndefined();
    expect(await liveDeviceSessions(USER)).toHaveLength(0);
  });

  it('EMPTY: an account that never signed in lists nothing', async () => {
    expect(await liveDeviceSessions('0xnobody')).toEqual([]);
  });
});
