/**
 * OS notification-permission reconciliation (P-M) — `readOsPushState` and
 * `applyRegistrationOutcome`, plus the forced re-registration the settings
 * switch relies on (`registerPushNow`).
 *
 * The behaviour under test is the promise that the in-app switch NEVER silently
 * does nothing: whenever the OS is the thing blocking delivery, the resolved
 * state is `blocked` so the screen can say so and offer system settings.
 *
 * Edge-case matrix rows covered here:
 *   host variants — no host support / direct read / read throws / unknown value
 *   integrity     — a `granted` direct read is not overwritten by a simulator's
 *                   `unavailable` registration outcome (false "blocked" alarm)
 *   idempotency   — registerPushNow works even after the once-per-session claim
 *                   was already taken (which is exactly why it exists)
 *   race/failure  — a failed or duplicate outcome changes nothing
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  readOsPushState,
  applyRegistrationOutcome,
  type OsPushState,
  type PushPermissionHost,
} from '../hooks/pushPermission';
import {
  registerPushOnce,
  registerPushNow,
  resetPushRegistrations,
} from '../hooks/pushRegistration';

beforeEach(() => {
  resetPushRegistrations();
});

describe('readOsPushState', () => {
  it('maps every documented status', async () => {
    const cases: Array<[string, OsPushState]> = [
      ['granted', 'granted'],
      ['denied', 'blocked'],
      ['unavailable', 'blocked'],
      ['undetermined', 'prompt'],
    ];
    for (const [status, expected] of cases) {
      const host: PushPermissionHost = {
        getPushPermissionStatus: async () => status as 'granted',
        registerForPush: async () => null,
      };
      expect(await readOsPushState(host)).toBe(expected);
    }
  });

  it('an unrecognised status is `unknown`, never an OS claim', async () => {
    const host: PushPermissionHost = {
      getPushPermissionStatus: async () => 'provisional-ish' as 'granted',
      registerForPush: async () => null,
    };
    expect(await readOsPushState(host)).toBe('unknown');
  });

  it('a host that can register but cannot report status is `unknown`', async () => {
    expect(await readOsPushState({ registerForPush: async () => null })).toBe('unknown');
  });

  it('a host with NO push support at all is `blocked`', async () => {
    expect(await readOsPushState({})).toBe('blocked');
  });

  it('a throwing host implementation is `unknown` — never crashes the screen', async () => {
    const host: PushPermissionHost = {
      getPushPermissionStatus: async () => {
        throw new Error('native module missing');
      },
    };
    await expect(readOsPushState(host)).resolves.toBe('unknown');
  });
});

describe('applyRegistrationOutcome', () => {
  it('a successful registration proves the OS granted permission', () => {
    expect(applyRegistrationOutcome('unknown', 'registered')).toBe('granted');
    expect(applyRegistrationOutcome('blocked', 'registered')).toBe('granted');
  });

  it('`unavailable` downgrades an unknown state to blocked (the legacy-host path)', () => {
    expect(applyRegistrationOutcome('unknown', 'unavailable')).toBe('blocked');
    expect(applyRegistrationOutcome('prompt', 'unavailable')).toBe('blocked');
  });

  it('INTEGRITY: `unavailable` does NOT contradict a direct `granted` read', () => {
    // Simulator / missing EAS project id: registration cannot mint a token even
    // though the permission is genuinely granted. Claiming "blocked" there would
    // send the user to system settings for nothing.
    expect(applyRegistrationOutcome('granted', 'unavailable')).toBe('granted');
  });

  it('`unsupported` (host cannot register) is blocked', () => {
    expect(applyRegistrationOutcome('unknown', 'unsupported')).toBe('blocked');
  });

  it('`duplicate` and `failed` say nothing about the OS and leave the state alone', () => {
    for (const state of ['granted', 'blocked', 'prompt', 'unknown'] as OsPushState[]) {
      expect(applyRegistrationOutcome(state, 'duplicate')).toBe(state);
      expect(applyRegistrationOutcome(state, 'failed')).toBe(state);
    }
  });
});

describe('registerPushNow (settings-screen forced registration)', () => {
  const reg = { routingHandle: 'h-1', pushToken: 'tok-1', platform: 'ios' as const };

  it('registers even though the once-per-session attempt already ran', async () => {
    const host = { registerForPush: vi.fn().mockResolvedValue(reg) };
    const client = { post: vi.fn().mockResolvedValue({ ok: true }) };

    expect(await registerPushOnce('user-1', host, client)).toBe('registered');
    // The plain once-per-session call would now be a no-op…
    expect(await registerPushOnce('user-1', host, client)).toBe('duplicate');
    // …but the settings switch must still be able to force it.
    expect(await registerPushNow('user-1', host, client)).toBe('registered');
    expect(client.post).toHaveBeenCalledTimes(2);
    expect(client.post).toHaveBeenLastCalledWith('/api/push/register', {
      routingHandle: 'h-1',
      pushToken: 'tok-1',
      platform: 'ios',
    });
  });

  it('reports `unavailable` when the host cannot produce a token (denied permission)', async () => {
    const host = { registerForPush: vi.fn().mockResolvedValue(null) };
    const client = { post: vi.fn() };
    expect(await registerPushNow('user-1', host, client)).toBe('unavailable');
    expect(client.post).not.toHaveBeenCalled();
  });

  it('reports `unsupported` on a host without push', async () => {
    expect(await registerPushNow('user-1', {}, { post: vi.fn() })).toBe('unsupported');
  });

  it('a failed POST reports `failed` and leaves the identity retryable', async () => {
    const host = { registerForPush: vi.fn().mockResolvedValue(reg) };
    const client = { post: vi.fn().mockRejectedValue(new Error('500')) };
    expect(await registerPushNow('user-1', host, client)).toBe('failed');
    // Claim released → a later attempt tries again rather than reporting duplicate.
    client.post.mockResolvedValue({ ok: true });
    expect(await registerPushOnce('user-1', host, client)).toBe('registered');
  });

  it('does not disturb OTHER identities registered in this process', async () => {
    const host = { registerForPush: vi.fn().mockResolvedValue(reg) };
    const client = { post: vi.fn().mockResolvedValue({ ok: true }) };
    await registerPushOnce('user-a', host, client);
    await registerPushOnce('user-b', host, client);
    await registerPushNow('user-a', host, client);
    expect(await registerPushOnce('user-b', host, client)).toBe('duplicate');
  });
});
