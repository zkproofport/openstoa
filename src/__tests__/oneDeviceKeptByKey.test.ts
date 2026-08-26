/*
 * A phone that lost its id is still the same phone.
 *
 * WHAT WENT WRONG, on a real device on 2026-08-26. `deviceId` is a string the
 * client generates and keeps. When it is lost — an unreadable store, a reinstall
 * on Android — the phone arrives under a new one, and the takeover gate files
 * its OWN previous session under `others`. The person is shown
 *
 *     "This will sign out your other phone.
 *      Your chat keys stay on that phone..."
 *
 * naming a device that does not exist, and warning that keys went with it while
 * they sit on the phone in their hand. Every sign-in did it again.
 *
 * The gate was not wrong about its own rule; the rule was asked with a bad
 * input. So the fix is not to soften the warning but to answer "is this the same
 * phone" with something that cannot be lost the same way — the registered
 * signing key. Two ids that map to one key are one device.
 *
 * THE AXIS IS REPETITION. Losing an id once is indistinguishable from owning two
 * phones; the account that surfaced this had collected several. A case that
 * signs in once cannot see it, which is why the guards that already covered this
 * gate stayed green throughout.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   repetition (THE guard) → id lost 3 times, still one device, no prompt
 *   contract   → a genuinely second phone STILL prompts (no over-correction)
 *   integrity  → the presented id counts as mine even with nothing registered
 *   integrity  → a different key under the same account is another device
 *   boundary   → no key supplied → previous behaviour, id alone
 *   external   → the key lookup failing falls back to the id, never merges
 *   authz      → web and agent logins are not subject to the rule at all
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Rows in `device_signing_keys`, as the gate reads them. */
let keyRows: Array<{ userId: string; deviceId: string; publicKey: string }> = [];
let keyLookupThrows = false;

/** Live sessions, as `liveDeviceSessions` returns them. */
let sessions: Array<{ sessionId: string; deviceId: string; deviceKind: string; issuedAt: number }> = [];
const revoked: string[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      deviceSigningKeys: {
        findMany: async () => {
          if (keyLookupThrows) throw new Error('db unavailable');
          return keyRows;
        },
      },
    },
  },
}));
vi.mock('@/lib/sessionStore', () => ({
  liveDeviceSessions: async () => sessions,
  revokeSession: async (id: string) => {
    revoked.push(id);
    sessions = sessions.filter((s) => s.sessionId !== id);
  },
  revokeDeviceSessions: async () => {
    const n = sessions.length;
    sessions = [];
    return n;
  },
}));
vi.mock('@/lib/keyBackupStore', () => ({ getTakBackup: async () => null }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { checkDeviceTakeover } from '@/lib/deviceTakeoverGate';

const USER = '0xowner';
const KEY_A = 'key-of-the-phone-in-your-hand';
const KEY_B = 'key-of-a-genuinely-different-phone';

let n = 0;
/** One sign-in from a device, returning the gate's answer. */
async function signIn(deviceId: string, publicKey?: string, takeover = false) {
  const decision = await checkDeviceTakeover({
    userId: USER,
    deviceKind: 'mobile',
    deviceId,
    devicePublicKey: publicKey,
    takeover,
  });
  if (decision.kind === 'allow') {
    sessions.push({
      sessionId: `sess-${(n += 1)}`,
      deviceId,
      deviceKind: 'mobile',
      issuedAt: Date.now(),
    });
  }
  return decision;
}

/** The device registers its key under whatever id it currently has. */
function register(deviceId: string, publicKey: string) {
  keyRows.push({ userId: USER, deviceId, publicKey });
}

beforeEach(() => {
  keyRows = [];
  sessions = [];
  revoked.length = 0;
  keyLookupThrows = false;
  n = 0;
});

describe('one phone stays one phone even when its id does not', () => {
  it('REPETITION: losing the id three times still shows no takeover prompt', async () => {
    /*
     * THE guard. Each round is the phone arriving under a fresh id, exactly as
     * it did when the store could not be read. Before the key was consulted,
     * round two already prompted.
     */
    register('id-1', KEY_A);
    await signIn('id-1', KEY_A);

    for (const id of ['id-2', 'id-3', 'id-4']) {
      register(id, KEY_A);
      const decision = await signIn(id, KEY_A);
      expect(decision.kind).toBe('allow');
    }

    // And the stale sessions were retired rather than left to accumulate.
    expect(sessions).toHaveLength(1);
    expect(revoked).toHaveLength(3);
  });

  it('CONTRACT: a genuinely second phone still prompts', async () => {
    /*
     * The over-correction guard. The warning exists because a second phone
     * really does mean the chat keys are elsewhere; a fix that silenced it
     * would trade a false alarm for a silent loss.
     */
    register('id-1', KEY_A);
    await signIn('id-1', KEY_A);

    register('id-other', KEY_B);
    const decision = await signIn('id-other', KEY_B);

    expect(decision.kind).toBe('conflict');
  });

  it('INTEGRITY: the presented id is mine even with nothing registered', async () => {
    // A first sign-in has no key on file. It must not look like a second phone.
    await signIn('id-1');
    const decision = await signIn('id-1');

    expect(decision.kind).toBe('allow');
  });

  it('BOUNDARY: no key supplied falls back to the id alone', async () => {
    /*
     * Previous behaviour, kept deliberately: a client that has not registered
     * yet is no worse off than before, and no better.
     */
    await signIn('id-1');
    const decision = await signIn('id-2');

    expect(decision.kind).toBe('conflict');
  });

  it('EXTERNAL: a failing key lookup falls back to the id, never merges devices', async () => {
    /*
     * The direction of the fallback matters. Treating an unknown as "same
     * device" would skip a warning about losing keys; treating it as "another
     * device" only shows a prompt that should not have appeared.
     */
    register('id-1', KEY_A);
    await signIn('id-1', KEY_A);

    keyLookupThrows = true;
    const decision = await signIn('id-2', KEY_A);

    expect(decision.kind).toBe('conflict');
  });

  it('REPETITION: with the key, three sign-ins all succeed and leave one session', async () => {
    /*
     * The count alone is not enough, and the first draft of this case proved it:
     * it asserted only `sessions.length === 1` and passed under a mutation that
     * ignored the key entirely — because a REFUSED sign-in mints nothing, so
     * three refusals also leave the one session from the first. It was green for
     * the opposite of the reason intended.
     *
     * So each sign-in is asserted to be allowed as well.
     */
    const outcomes: string[] = [];
    for (const id of ['id-1', 'id-2', 'id-3']) {
      register(id, KEY_A);
      outcomes.push((await signIn(id, KEY_A)).kind);
    }

    expect(outcomes).toEqual(['allow', 'allow', 'allow']);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].deviceId).toBe('id-3');
  });

  it('AUTHZ: a web login is not subject to the rule at all', async () => {
    register('id-1', KEY_A);
    await signIn('id-1', KEY_A);

    const decision = await checkDeviceTakeover({
      userId: USER,
      deviceKind: 'web',
      deviceId: 'a-browser',
      takeover: false,
    });

    expect(decision.kind).toBe('allow');
  });

  it('CONTRACT: confirming a takeover ends the other phone', async () => {
    register('id-1', KEY_A);
    await signIn('id-1', KEY_A);
    register('id-other', KEY_B);

    const decision = await signIn('id-other', KEY_B, true);

    expect(decision.kind).toBe('allow');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].deviceId).toBe('id-other');
  });
});
