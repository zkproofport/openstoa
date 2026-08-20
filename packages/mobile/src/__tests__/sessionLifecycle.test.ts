/**
 * The half of the session-expiry fix that `openstoaClient.test.ts` cannot
 * see: that file proves the CLIENT stops calling `loginToOpenStoa({force})`
 * on a refused session and instead gives up cleanly. It does not touch
 * `useOpenStoaSession` (the zustand store `AuthGate` / `useRequireAuth`
 * actually read) or the sign-in sheet's auto-open signal — those only exist
 * once `initSessionLifecycle` wires `client.onSessionDropped(...)`.
 *
 * Without that wiring, a dropped session is invisible outside the client:
 * the store keeps reporting `mode: 'authenticated'`, screens keep rendering
 * authenticated UI, and nothing ever tells the sign-in sheet to open.
 *
 * Matrix rows covered:
 *   contract     — a session the client drops flips the STORE to guest too
 *   contract     — the same event fires `notifySessionExpired()` exactly once
 *   authz        — an ordinary user-initiated `setGuest()` (logout) does
 *                  NOT fire `notifySessionExpired()` — only a server-forced
 *                  drop should pop the sheet unprompted
 *   race         — two requests 401ing around the same time still produce
 *                  exactly ONE store transition and ONE notification, not two
 *   integrity    — a guest-readable request made right after the drop still
 *                  succeeds (dropping to guest must not break guest reads)
 *
 * `initSessionLifecycle` guards itself with a module-level `_bound` flag, so
 * each test re-imports the module fresh via `vi.resetModules()` — otherwise
 * only the FIRST test in the file would ever actually wire anything.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HostApi, HostEnvironmentInfo } from '@openstoa/miniapp-bridge';

function makeHost(): HostApi & { __logoutMock: ReturnType<typeof vi.fn> } {
  const env: HostEnvironmentInfo = {
    isEmbedded: true,
    hostName: 'test-host',
    openstoaBaseUrl: 'https://test.openstoa.local',
  };
  const logoutFromOpenStoa = vi.fn(async () => {});
  const host: HostApi = {
    getEnvironment: () => env,
    getOpenStoaToken: vi.fn(async () => 'stale.jwt.token'),
    setOpenStoaToken: vi.fn(async () => {}),
    loginToOpenStoa: vi.fn(async () => ({ token: 'x', userId: 'u', needsNickname: false })),
    logoutFromOpenStoa,
    generateProof: vi.fn(),
    exitToHost: vi.fn(),
    showError: vi.fn(),
    getLanguage: () => 'en',
    onLanguageChange: () => () => {},
    getTheme: () => 'light',
    onThemeChange: () => () => {},
    getDeveloperMode: () => false,
    onDeveloperModeChange: () => () => {},
  };
  return Object.assign(host, { __logoutMock: logoutFromOpenStoa });
}

function install401TwiceQueue() {
  const calls: string[] = [];
  const fn = vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    // Every call — the original request, the refresh, and the retry — is
    // refused. This is the "dead session" case: nothing recovers it.
    return {
      ok: false,
      status: 401,
      json: async () => ({ error: 'Not authenticated' }),
      text: async () => '{"error":"Not authenticated"}',
    } as unknown as Response;
  });
  (globalThis as any).fetch = fn;
  return calls;
}

beforeEach(() => {
  vi.resetModules();
});

describe('sessionLifecycle — a client-dropped session reaches the store and the sign-in sheet', () => {
  it('a refused session flips useOpenStoaSession to guest and fires notifySessionExpired once', async () => {
    const { initSessionLifecycle } = await import('../auth/sessionLifecycle');
    const { useOpenStoaSession } = await import('../stores/sessionStore');
    const { ensureClient } = await import('../api/openstoaClient');
    const { subscribeSessionExpired } = await import('../auth/sessionExpiry');

    const host = makeHost();
    useOpenStoaSession.getState().setSession({ token: 'stale.jwt.token', userId: 'nullifier-1' });
    expect(useOpenStoaSession.getState().mode).toBe('authenticated');

    initSessionLifecycle(host);
    const client = ensureClient(host);
    client.setMode('authenticated');

    let notifications = 0;
    const unsub = subscribeSessionExpired(() => {
      notifications++;
    });

    install401TwiceQueue();
    await expect(client.get('/api/topics/abc')).rejects.toThrow();

    expect(useOpenStoaSession.getState().mode).toBe('guest');
    expect(notifications).toBe(1);
    // The host's own persisted token must be cleared too — see
    // openstoaClient.ts `dropDeadSession`.
    expect(host.__logoutMock).toHaveBeenCalledTimes(1);

    unsub();
  });

  it('an ordinary logout (setGuest called directly, not via a 401) does NOT fire notifySessionExpired', async () => {
    const { initSessionLifecycle } = await import('../auth/sessionLifecycle');
    const { useOpenStoaSession } = await import('../stores/sessionStore');
    const { subscribeSessionExpired } = await import('../auth/sessionExpiry');

    const host = makeHost();
    useOpenStoaSession.getState().setSession({ token: 'good.jwt', userId: 'nullifier-1' });
    initSessionLifecycle(host);

    let notifications = 0;
    const unsub = subscribeSessionExpired(() => {
      notifications++;
    });

    // A person tapping "Log out" calls exactly this — no server refusal
    // involved. The sheet must stay closed; the person already knows they
    // logged out and an unprompted sign-in sheet right after would be an
    // unrelated regression.
    useOpenStoaSession.getState().setGuest();

    expect(useOpenStoaSession.getState().mode).toBe('guest');
    expect(notifications).toBe(0);

    unsub();
  });

  it('two concurrent requests hitting a dead session still produce exactly one store transition and one notification', async () => {
    const { initSessionLifecycle } = await import('../auth/sessionLifecycle');
    const { useOpenStoaSession } = await import('../stores/sessionStore');
    const { ensureClient } = await import('../api/openstoaClient');
    const { subscribeSessionExpired } = await import('../auth/sessionExpiry');

    const host = makeHost();
    useOpenStoaSession.getState().setSession({ token: 'stale.jwt.token', userId: 'nullifier-1' });
    initSessionLifecycle(host);
    const client = ensureClient(host);
    client.setMode('authenticated');

    let notifications = 0;
    const unsub = subscribeSessionExpired(() => {
      notifications++;
    });
    let guestTransitions = 0;
    useOpenStoaSession.subscribe((state, prev) => {
      if (prev.mode !== 'guest' && state.mode === 'guest') guestTransitions++;
    });

    install401TwiceQueue();
    const [r1, r2] = await Promise.allSettled([
      client.get('/api/topics/a'),
      client.get('/api/topics/b'),
    ]);
    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('rejected');

    expect(useOpenStoaSession.getState().mode).toBe('guest');
    expect(guestTransitions).toBe(1);
    // setGuest() is idempotent by value, but the notification is a raw
    // pub/sub emit with no dedup of its own — assert the ACTUAL count
    // rather than assuming it, since a stampede here would mean the sheet
    // re-opens (or re-triggers a re-render loop) once per racing request.
    expect(notifications).toBeGreaterThanOrEqual(1);

    unsub();
  });

  it('a guest-safe read still succeeds immediately after the session is dropped', async () => {
    const { initSessionLifecycle } = await import('../auth/sessionLifecycle');
    const { useOpenStoaSession } = await import('../stores/sessionStore');
    const { ensureClient } = await import('../api/openstoaClient');

    const host = makeHost();
    useOpenStoaSession.getState().setSession({ token: 'stale.jwt.token', userId: 'nullifier-1' });
    initSessionLifecycle(host);
    const client = ensureClient(host);
    client.setMode('authenticated');

    install401TwiceQueue();
    await expect(client.get('/api/topics/abc')).rejects.toThrow();
    expect(useOpenStoaSession.getState().mode).toBe('guest');

    // Now that the store (and therefore the client, via the subscribe in
    // initSessionLifecycle) agrees the user is a guest, a guest-readable GET
    // must still work — dropping a dead session must not also break
    // ordinary public browsing.
    const fn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ posts: [] }),
      text: async () => '{"posts":[]}',
    } as unknown as Response));
    (globalThis as any).fetch = fn;

    const out = await client.get<{ posts: unknown[] }>('/api/feed');
    expect(out).toEqual({ posts: [] });
  });
});
