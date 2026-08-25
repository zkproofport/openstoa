/**
 * The one-device rule as a decision, separate from any route that applies it.
 *
 * WHY THE RULE MOVED HERE. It was written inline in the proof-login poll route,
 * which meant `dev-login` — the other way a person gets a session — had no rule
 * at all. A rule one of two doors enforces is not a rule; it is a property of
 * that door. This file is the rule, and a source-level case at the bottom
 * checks that every human login path calls it.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → first phone allowed; second refused; confirmed takeover revokes
 *   boundary   → zero / one / several other devices
 *   authz      → web and agent logins are never subject to the rule, and are
 *                never displaced by a phone taking over
 *   integrity  → the conflict body carries the BACKUP STATE, because that is
 *                what the person's decision turns on
 *   integrity  → the other device's ID is NEVER returned — it is what that
 *                device proves itself with
 *   race       → the same device id signing in again is not a second device
 *   external   → a Redis that cannot answer must not block a login
 *   contract   → every human login route calls the gate (source scan)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  liveDeviceSessions: vi.fn(),
  revokeDeviceSessions: vi.fn(),
  revokeSession: vi.fn(),
  getTakBackup: vi.fn(),
}));

vi.mock('@/lib/sessionStore', () => ({
  liveDeviceSessions: mocks.liveDeviceSessions,
  revokeDeviceSessions: mocks.revokeDeviceSessions,
  revokeSession: mocks.revokeSession,
}));
vi.mock('@/lib/keyBackupStore', () => ({ getTakBackup: mocks.getTakBackup }));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { checkDeviceTakeover } from '@/lib/deviceTakeoverGate';

function otherPhone(deviceId = 'phone-old', over: Record<string, unknown> = {}) {
  return {
    sessionId: 's-old',
    userId: '0xalice',
    deviceKind: 'mobile' as const,
    deviceId,
    issuedAt: 1_700_000_000_000,
    ...over,
  };
}

beforeEach(() => {
  mocks.liveDeviceSessions.mockReset().mockResolvedValue([]);
  mocks.revokeDeviceSessions.mockReset().mockResolvedValue(0);
  mocks.revokeSession.mockReset().mockResolvedValue(undefined);
  mocks.getTakBackup.mockReset().mockResolvedValue(null);
});

describe('nothing in the way', () => {
  it('BOUNDARY: the first phone is allowed', async () => {
    const d = await checkDeviceTakeover({
      userId: '0xalice',
      deviceKind: 'mobile',
      deviceId: 'phone-1',
      takeover: false,
    });
    expect(d.kind).toBe('allow');
    expect(mocks.revokeDeviceSessions).not.toHaveBeenCalled();
  });

  it('RACE: the SAME phone signing in again is not a second phone', async () => {
    // The commonest case there is. Treating it as a conflict would show the
    // takeover warning to someone who owns exactly one device.
    mocks.liveDeviceSessions.mockResolvedValue([otherPhone('phone-1')]);
    const d = await checkDeviceTakeover({
      userId: '0xalice',
      deviceKind: 'mobile',
      deviceId: 'phone-1',
      takeover: false,
    });
    expect(d.kind).toBe('allow');
  });

  it('RACE: and its PREVIOUS session is retired — one session per device', async () => {
    /*
     * Found by the E2E, not by reasoning: three sign-ins from one phone left
     * three live records. Nothing looked broken until the account was asked how
     * many devices it had — the one question this mechanism exists to answer —
     * and a genuinely-second phone was told "3 other devices".
     */
    mocks.liveDeviceSessions.mockResolvedValue([
      otherPhone('phone-1', { sessionId: 'old-1' }),
      otherPhone('phone-1', { sessionId: 'old-2' }),
    ]);
    const d = await checkDeviceTakeover({
      userId: '0xalice',
      deviceKind: 'mobile',
      deviceId: 'phone-1',
      takeover: false,
    });
    expect(d.kind).toBe('allow');
    expect(mocks.revokeSession).toHaveBeenCalledWith('old-1', '0xalice');
    expect(mocks.revokeSession).toHaveBeenCalledWith('old-2', '0xalice');
    // INTEGRITY: retiring one's own stale records is not a takeover.
    expect(mocks.revokeDeviceSessions).not.toHaveBeenCalled();
  });
});

describe('a second phone', () => {
  it('CONTRACT: is refused, and the refusal carries the backup state', async () => {
    // What the person's decision turns on. "Did you back up?" is a question
    // they cannot answer from the phone in their hand.
    mocks.liveDeviceSessions.mockResolvedValue([otherPhone()]);
    mocks.getTakBackup.mockResolvedValue({
      ciphertext: Buffer.from('x'),
      updatedAt: new Date(1_799_000_000_000),
    });

    const d = await checkDeviceTakeover({
      userId: '0xalice',
      deviceKind: 'mobile',
      deviceId: 'phone-new',
      takeover: false,
    });

    expect(d.kind).toBe('conflict');
    if (d.kind !== 'conflict') return;
    expect(d.body.status).toBe('device_conflict');
    expect(d.body.hasBackup).toBe(true);
    expect(d.body.backupUpdatedAt).toBe(1_799_000_000_000);
    expect(mocks.revokeDeviceSessions).not.toHaveBeenCalled();
  });

  it('CONTRACT: no backup is reported as no backup, not as an absent field', async () => {
    mocks.liveDeviceSessions.mockResolvedValue([otherPhone()]);
    mocks.getTakBackup.mockResolvedValue(null);
    const d = await checkDeviceTakeover({
      userId: '0xalice',
      deviceKind: 'mobile',
      deviceId: 'phone-new',
      takeover: false,
    });
    if (d.kind !== 'conflict') throw new Error('expected a conflict');
    expect(d.body.hasBackup).toBe(false);
    expect(d.body.backupUpdatedAt).toBeNull();
  });

  it('INTEGRITY: the other device ID is never handed out', async () => {
    /*
     * It is what that device proves itself with. An endpoint that returns it
     * turns a warning into a way to impersonate the device being warned about.
     */
    mocks.liveDeviceSessions.mockResolvedValue([otherPhone('secret-install-id')]);
    const d = await checkDeviceTakeover({
      userId: '0xalice',
      deviceKind: 'mobile',
      deviceId: 'phone-new',
      takeover: false,
    });
    if (d.kind !== 'conflict') throw new Error('expected a conflict');
    const serialised = JSON.stringify(d.body);
    expect(serialised).not.toContain('secret-install-id');
    for (const entry of d.body.existingDevices) {
      expect(Object.keys(entry).sort()).toEqual(['issuedAt', 'kind']);
    }
  });

  it('BOUNDARY: several other phones are all named', async () => {
    mocks.liveDeviceSessions.mockResolvedValue([
      otherPhone('p1'),
      otherPhone('p2'),
      otherPhone('p3'),
    ]);
    const d = await checkDeviceTakeover({
      userId: '0xalice',
      deviceKind: 'mobile',
      deviceId: 'p4',
      takeover: false,
    });
    if (d.kind !== 'conflict') throw new Error('expected a conflict');
    expect(d.body.existingDevices).toHaveLength(3);
  });
});

describe('a confirmed takeover', () => {
  it('CONTRACT: ends the previous sessions and allows the login', async () => {
    mocks.liveDeviceSessions.mockResolvedValue([otherPhone()]);
    const d = await checkDeviceTakeover({
      userId: '0xalice',
      deviceKind: 'mobile',
      deviceId: 'phone-new',
      takeover: true,
    });
    expect(d.kind).toBe('allow');
    expect(mocks.revokeDeviceSessions).toHaveBeenCalledWith('0xalice');
  });

  it('INTEGRITY: the revoke happens HERE, not in the caller', async () => {
    /*
     * A caller that remembered the check but forgot the revoke would leave the
     * account with two live phones and no warning next time — the failure this
     * placement removes the opportunity for.
     */
    mocks.liveDeviceSessions.mockResolvedValue([otherPhone()]);
    await checkDeviceTakeover({
      userId: '0xalice',
      deviceKind: 'mobile',
      deviceId: 'new',
      takeover: true,
    });
    expect(mocks.revokeDeviceSessions).toHaveBeenCalledTimes(1);
  });

  it('does not revoke when there was nothing to take over', async () => {
    // `takeover: true` on a first sign-in is not an instruction to destroy
    // something that does not exist.
    const d = await checkDeviceTakeover({
      userId: '0xalice',
      deviceKind: 'mobile',
      deviceId: 'phone-1',
      takeover: true,
    });
    expect(d.kind).toBe('allow');
    expect(mocks.revokeDeviceSessions).not.toHaveBeenCalled();
  });
});

describe('AUTHZ: who the rule applies to', () => {
  it('a WEB login is never subject to it, even with a phone signed in', async () => {
    // A browser cannot read a room, so ending someone's phone session over a
    // laptop is a rule firing where its reason does not reach.
    mocks.liveDeviceSessions.mockResolvedValue([otherPhone()]);
    const d = await checkDeviceTakeover({
      userId: '0xalice',
      deviceKind: 'web',
      deviceId: 'laptop',
      takeover: false,
    });
    expect(d.kind).toBe('allow');
    expect(mocks.revokeDeviceSessions).not.toHaveBeenCalled();
    // It does not even ask — a lookup here would be work done for no decision.
    expect(mocks.liveDeviceSessions).not.toHaveBeenCalled();
  });

  it('an AGENT login is never subject to it', async () => {
    mocks.liveDeviceSessions.mockResolvedValue([otherPhone()]);
    const d = await checkDeviceTakeover({
      userId: '0xalice',
      deviceKind: 'agent',
      deviceId: 'ai',
      takeover: false,
    });
    expect(d.kind).toBe('allow');
  });
});

describe('EXTERNAL: the store cannot answer', () => {
  it('an empty answer from Redis reads as "no other device"', async () => {
    /*
     * `liveDeviceSessions` already fails closed to an empty list on an outage.
     * The consequence is deliberate and stated: during an outage a second phone
     * is allowed in without the warning. The alternative — refusing every
     * sign-in while a cache is down — locks everyone out of their own account
     * over an infrastructure blip.
     */
    mocks.liveDeviceSessions.mockResolvedValue([]);
    const d = await checkDeviceTakeover({
      userId: '0xalice',
      deviceKind: 'mobile',
      deviceId: 'phone-new',
      takeover: false,
    });
    expect(d.kind).toBe('allow');
  });
});

describe('every human login path applies the rule', () => {
  /*
   * The defect that made this file exist: the rule lived inline in one route,
   * so the other route that mints a human session had none. Read at source
   * because that is where "this door has no lock" is visible — a runtime test
   * can only exercise the doors someone remembered to write a test for.
   */
  const ROOT = process.cwd();
  const HUMAN_LOGIN_ROUTES = [
    'src/app/api/auth/poll/[requestId]/route.ts',
    'src/app/api/auth/dev-login/route.ts',
  ];

  it.each(HUMAN_LOGIN_ROUTES)('%s calls checkDeviceTakeover', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src).toContain('checkDeviceTakeover');
    // And acts on the answer, rather than calling it and ignoring the result.
    expect(src).toContain('409');
  });

  it('CONTRACT: no login route mints a session without declaring a device kind', () => {
    // A session with no kind defaults to `web`, which would silently exclude a
    // real phone from the rule AND deny it chat.
    for (const file of HUMAN_LOGIN_ROUTES) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(src, `${file} does not pass deviceKind`).toContain('deviceKind');
    }
  });
});
