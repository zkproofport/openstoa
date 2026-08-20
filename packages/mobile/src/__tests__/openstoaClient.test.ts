import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OpenStoaClient,
  GuestAuthRequiredError,
} from '../api/openstoaClient';
import type { HostApi, AuthResult, HostEnvironmentInfo } from '@openstoa/miniapp-bridge';

// ── Helper: build a minimal fake HostApi we can spy on ─────────────────────

interface FakeHostOpts {
  initialToken?: string | null;
  loginResult?: AuthResult;
}

function makeFakeHost(opts: FakeHostOpts = {}): HostApi & {
  __getTokenMock: ReturnType<typeof vi.fn>;
  __loginMock: ReturnType<typeof vi.fn>;
  __logoutMock: ReturnType<typeof vi.fn>;
} {
  const getOpenStoaToken = vi.fn(async () => opts.initialToken ?? null);
  const logoutFromOpenStoa = vi.fn(async () => {});
  const loginToOpenStoa = vi.fn(async () => {
    return (
      opts.loginResult ?? {
        token: 'fresh.jwt.token',
        userId: 'nullifier-fresh',
        needsNickname: false,
      }
    );
  });
  const env: HostEnvironmentInfo = {
    isEmbedded: true,
    hostName: 'test-host',
    openstoaBaseUrl: 'https://test.openstoa.local',
  };
  const host: HostApi = {
    getEnvironment: () => env,
    getOpenStoaToken,
    loginToOpenStoa,
    logoutFromOpenStoa,
    generateProof: vi.fn(),
    exitToHost: vi.fn(),
    showError: vi.fn(),
    getLanguage: () => 'en',
    onLanguageChange: () => () => {},
    getTheme: () => 'light',
    onThemeChange: () => () => {},
  };
  return Object.assign(host, {
    __getTokenMock: getOpenStoaToken,
    __loginMock: loginToOpenStoa,
    __logoutMock: logoutFromOpenStoa,
  });
}

// ── Helper: stub global fetch with a recorded queue of responses ───────────

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
  method: string;
  headers: Record<string, string>;
}

function captureHeaders(init: RequestInit | undefined): Record<string, string> {
  const h: Record<string, string> = {};
  const raw = init?.headers;
  if (!raw) return h;
  if (raw instanceof Headers) {
    raw.forEach((v, k) => {
      h[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(raw)) {
    for (const [k, v] of raw) h[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(raw as Record<string, string>)) {
      h[k.toLowerCase()] = v;
    }
  }
  return h;
}

function installFetchQueue(
  responses: Array<{ status: number; body?: unknown; bodyText?: string }>,
): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fn = vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init?.method ?? 'GET').toString().toUpperCase();
    calls.push({ url, init, method, headers: captureHeaders(init) });
    const spec = responses[i++] ?? { status: 500, bodyText: 'no-more-responses' };
    const text = spec.bodyText ?? JSON.stringify(spec.body ?? {});
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      json: async () => (spec.body !== undefined ? spec.body : JSON.parse(text)),
      text: async () => text,
    } as unknown as Response;
  });
  (globalThis as any).fetch = fn;
  return { calls };
}

beforeEach(() => {
  // Reset module-level state so the singleton in openstoaClient.ts doesn't
  // leak across tests (we use fresh instances via `new OpenStoaClient(...)`).
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenStoaClient — guest mode + auth-mode + 401 recovery', () => {
  // ── Matrix row 5: guest mode + GET /api/feed → no Authorization header ──
  it('guest mode + GET /api/feed sends NO Authorization header', async () => {
    const host = makeFakeHost();
    const client = new OpenStoaClient({ host });
    client.setMode('guest');
    const { calls } = installFetchQueue([
      { status: 200, body: { posts: [] } },
    ]);

    const out = await client.get<{ posts: unknown[] }>('/api/feed');
    expect(out).toEqual({ posts: [] });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('https://test.openstoa.local/api/feed');
    expect(calls[0].headers['authorization']).toBeUndefined();
    // And we must NOT have asked the host for a token (guests never do).
    expect(host.__getTokenMock).not.toHaveBeenCalled();
    expect(host.__loginMock).not.toHaveBeenCalled();
  });

  it('guest mode + GET on each guest-safe prefix sends no Authorization header', async () => {
    const safe = ['/api/feed', '/api/tags', '/api/categories', '/api/stats',
      '/api/og', '/api/topics', '/api/posts'];
    const host = makeFakeHost();
    const client = new OpenStoaClient({ host });
    client.setMode('guest');
    const { calls } = installFetchQueue(safe.map(() => ({ status: 200, body: {} })));

    for (const p of safe) {
      await client.get(p);
    }
    expect(calls).toHaveLength(safe.length);
    for (const call of calls) {
      expect(call.headers['authorization']).toBeUndefined();
    }
  });

  // ── Matrix row 6: guest mode + POST /api/topics/X/posts → throws BEFORE fetch ──
  it('guest mode + POST /api/topics/X/posts throws GuestAuthRequiredError WITHOUT firing fetch', async () => {
    const host = makeFakeHost();
    const client = new OpenStoaClient({ host });
    client.setMode('guest');
    const { calls } = installFetchQueue([]);

    let caught: unknown = null;
    try {
      await client.post('/api/topics/abc/posts', { title: 't', content: 'c' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GuestAuthRequiredError);
    expect((caught as GuestAuthRequiredError).kind).toBe('GUEST_AUTH_REQUIRED');
    expect((caught as GuestAuthRequiredError).path).toBe('/api/topics/abc/posts');
    // CRITICAL: fetch must not have been called at all — the whole point of
    // the pre-check is to avoid the wasted roundtrip and the 401 UX flash.
    expect(calls).toHaveLength(0);
    expect(host.__loginMock).not.toHaveBeenCalled();
  });

  it('guest mode + POST /api/posts/X/comments throws GuestAuthRequiredError without fetching', async () => {
    const host = makeFakeHost();
    const client = new OpenStoaClient({ host });
    client.setMode('guest');
    const { calls } = installFetchQueue([]);

    await expect(
      client.post('/api/posts/xyz/comments', { content: 'hi' }),
    ).rejects.toBeInstanceOf(GuestAuthRequiredError);
    expect(calls).toHaveLength(0);
  });

  it('guest mode + POST /api/posts/X/vote throws GuestAuthRequiredError without fetching', async () => {
    const host = makeFakeHost();
    const client = new OpenStoaClient({ host });
    client.setMode('guest');
    const { calls } = installFetchQueue([]);

    await expect(
      client.post('/api/posts/abc/vote', { value: 1 }),
    ).rejects.toBeInstanceOf(GuestAuthRequiredError);
    expect(calls).toHaveLength(0);
  });

  it('guest mode + POST /api/posts/X/reactions throws GuestAuthRequiredError without fetching', async () => {
    const host = makeFakeHost();
    const client = new OpenStoaClient({ host });
    client.setMode('guest');
    const { calls } = installFetchQueue([]);

    await expect(
      client.post('/api/posts/abc/reactions', { emoji: '🔥' }),
    ).rejects.toBeInstanceOf(GuestAuthRequiredError);
    expect(calls).toHaveLength(0);
  });

  it('guest mode + POST /api/posts/X/bookmark throws GuestAuthRequiredError without fetching', async () => {
    const host = makeFakeHost();
    const client = new OpenStoaClient({ host });
    client.setMode('guest');
    const { calls } = installFetchQueue([]);

    await expect(client.post('/api/posts/abc/bookmark')).rejects.toBeInstanceOf(
      GuestAuthRequiredError,
    );
    expect(calls).toHaveLength(0);
  });

  // ── Matrix row 7: guest mode + 401 → GuestAuthRequiredError, NO host login ──
  it('guest mode + 401 throws GuestAuthRequiredError and does NOT call host.loginToOpenStoa', async () => {
    const host = makeFakeHost();
    const client = new OpenStoaClient({ host });
    client.setMode('guest');
    const { calls } = installFetchQueue([
      { status: 401, bodyText: '{"error":"Not authenticated"}' },
    ]);

    await expect(client.get('/api/feed')).rejects.toBeInstanceOf(
      GuestAuthRequiredError,
    );
    // The fetch happened once (the path is guest-safe so the pre-check let it
    // through), the server returned 401, and we surfaced GuestAuthRequired.
    expect(calls).toHaveLength(1);
    // Critically: no auto-login attempt for guests.
    expect(host.__loginMock).not.toHaveBeenCalled();
  });

  it('guest mode + 401 on an explicitly allowGuest=true path also surfaces GuestAuthRequiredError', async () => {
    // allowGuest=true means the caller already said "guests may try"; but the
    // server still gets the final say. A 401 must still NOT trigger host login.
    const host = makeFakeHost();
    const client = new OpenStoaClient({ host });
    client.setMode('guest');
    const { calls } = installFetchQueue([
      { status: 401, bodyText: '{"error":"Not authenticated"}' },
    ]);
    await expect(
      client.request('/api/some-other-path', { method: 'GET', allowGuest: true }),
    ).rejects.toBeInstanceOf(GuestAuthRequiredError);
    expect(calls).toHaveLength(1);
    expect(host.__loginMock).not.toHaveBeenCalled();
  });

  /*
   * ── Matrix row 8: authenticated mode + 401 ──
   *
   * This block used to assert that a 401 calls `loginToOpenStoa({force:true})`
   * and retries. That WAS the bug. The host reads `force: true` as "the user
   * tapped Sign in" and answers it by starting the OIDC proof flow — its own
   * comment says it withholds any proof flow until the user asks. So a person
   * whose session had ended got a domain-verification sheet for opening the
   * tab, and again for pressing Create on a filled-in form.
   *
   * The contract now: refresh once, because an ordinary expiry should recover
   * without troubling anyone; and if the credential is genuinely finished,
   * drop it and let the screen offer sign-in. Never start a proof flow that
   * nobody asked for.
   */
  it('401 then a successful refresh recovers silently, without any login flow', async () => {
    const host = makeFakeHost({ initialToken: 'expired.jwt.token' });
    const client = new OpenStoaClient({ host });
    client.setMode('authenticated');
    const { calls } = installFetchQueue([
      { status: 401, bodyText: '{"error":"Not authenticated"}' },
      { status: 200, body: { token: 'fresh.jwt.token', expiresAt: Date.now() + 60_000 } },
      { status: 200, body: { ok: true } },
    ]);

    const out = await client.get<{ ok: boolean }>('/api/topics/abc');
    expect(out).toEqual({ ok: true });

    // The refused call, the refresh, then the retry carrying the new token.
    expect(calls).toHaveLength(3);
    expect(calls[0].headers['authorization']).toBe('Bearer expired.jwt.token');
    expect(calls[1].url).toContain('/api/auth/refresh');
    expect(calls[2].headers['authorization']).toBe('Bearer fresh.jwt.token');

    // The user saw nothing: no sign-in, and above all no proof request.
    expect(host.__loginMock).not.toHaveBeenCalled();
  });

  it('401 with a refresh that also fails ends at sign-in, not at a proof request', async () => {
    const host = makeFakeHost({ initialToken: 'dead.jwt.token' });
    const client = new OpenStoaClient({ host });
    client.setMode('authenticated');
    installFetchQueue([
      { status: 401, bodyText: '{"error":"Not authenticated"}' },
      { status: 401, bodyText: '{"error":"Not authenticated"}' }, // the refresh
    ]);

    await expect(client.get('/api/topics/abc')).rejects.toBeInstanceOf(GuestAuthRequiredError);

    // The whole point: the host is never asked to run a login — and therefore
    // never raises the OIDC sheet — as a reaction to the server saying no.
    expect(host.__loginMock).not.toHaveBeenCalled();
  });

  it('a refreshed token that is ALSO refused ends the session rather than looping', async () => {
    // Reachable when the account behind the token no longer exists: refresh
    // hands back a well-formed token for an identity the server will keep
    // rejecting. Retrying can never succeed, so it must not be attempted.
    const host = makeFakeHost({ initialToken: 'orphan.jwt.token' });
    const client = new OpenStoaClient({ host });
    client.setMode('authenticated');
    const { calls } = installFetchQueue([
      { status: 401, bodyText: '{"error":"Not authenticated"}' },
      { status: 200, body: { token: 'still.orphaned.token', expiresAt: Date.now() + 60_000 } },
      { status: 401, bodyText: '{"error":"Not authenticated"}' },
    ]);

    await expect(client.get('/api/topics/abc')).rejects.toBeInstanceOf(GuestAuthRequiredError);

    expect(calls).toHaveLength(3); // refused, refresh, refused again — and stop
    expect(host.__loginMock).not.toHaveBeenCalled();
  });

  it('a dead session is cleared from host storage, so the next call does not repeat it', async () => {
    // Clearing only the in-memory cache would leave the rejected Bearer in
    // host storage, and every later request would read it back and be refused
    // again — a sign-in prompt per call that nothing the user does clears.
    const host = makeFakeHost({ initialToken: 'dead.jwt.token' });
    const client = new OpenStoaClient({ host });
    client.setMode('authenticated');
    installFetchQueue([
      { status: 401, bodyText: '{"error":"Not authenticated"}' },
      { status: 401, bodyText: '{"error":"Not authenticated"}' },
    ]);

    await expect(client.get('/api/topics/abc')).rejects.toBeInstanceOf(GuestAuthRequiredError);

    expect(host.__logoutMock).toHaveBeenCalledTimes(1);

    // And a follow-up call that NEEDS a session short-circuits at the guest
    // branch — no second round trip spent rediscovering the same 401. It has
    // to be an auth-only path: reading a topic stays guest-readable, and
    // still answering those is the point of dropping to guest rather than
    // into an error state.
    const { calls: laterCalls } = installFetchQueue([{ status: 200, body: { ok: true } }]);
    await expect(
      client.post('/api/topics/abc/posts', { title: 't', content: 'c' }),
    ).rejects.toBeInstanceOf(GuestAuthRequiredError);
    expect(laterCalls).toHaveLength(0);
  });

  it('authenticated mode + 200 first try uses cached host token and does NOT call loginToOpenStoa', async () => {
    const host = makeFakeHost({ initialToken: 'good.jwt' });
    const client = new OpenStoaClient({ host });
    client.setMode('authenticated');
    const { calls } = installFetchQueue([{ status: 200, body: { x: 1 } }]);

    await client.get('/api/feed');
    expect(calls[0].headers['authorization']).toBe('Bearer good.jwt');
    expect(host.__loginMock).not.toHaveBeenCalled();
  });

  it('authenticated mode + no host token + non-guest-safe path drives host login first (no 401 needed)', async () => {
    const host = makeFakeHost({ initialToken: null });
    const client = new OpenStoaClient({ host });
    client.setMode('authenticated');
    const { calls } = installFetchQueue([{ status: 200, body: { ok: true } }]);

    await client.post('/api/topics/abc/posts', { title: 't', content: 'c' });
    // Host login fired pre-request because there was no token to attach.
    expect(host.__loginMock).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['authorization']).toBe('Bearer fresh.jwt.token');
  });

  // ── Matrix row 9: setMode('guest') drops cached token ────────────────────
  it("setMode('guest') drops the in-memory cached token", async () => {
    const host = makeFakeHost({ initialToken: 'cached.jwt' });
    const client = new OpenStoaClient({ host });
    client.setMode('authenticated');

    // Prime the cache by issuing one authenticated request.
    installFetchQueue([{ status: 200, body: {} }]);
    await client.get('/api/feed');
    expect(host.__getTokenMock).toHaveBeenCalledTimes(1);

    // Flip to guest; the next request must NOT carry the cached token.
    client.setMode('guest');
    const { calls } = installFetchQueue([{ status: 200, body: { ok: 1 } }]);
    await client.get('/api/feed');
    expect(calls[0].headers['authorization']).toBeUndefined();
    // And the host wasn't consulted for a token either.
    expect(host.__getTokenMock).toHaveBeenCalledTimes(1);
  });

  it("setMode('unknown') also drops the cached token (boot transition safety)", async () => {
    const host = makeFakeHost({ initialToken: 'cached.jwt' });
    const client = new OpenStoaClient({ host });
    client.setMode('authenticated');
    installFetchQueue([{ status: 200, body: {} }]);
    await client.get('/api/feed');

    client.setMode('unknown');
    // After unknown, an authenticated request would have to fetch the token
    // again from the host (cache was dropped). We force mode back to
    // authenticated to demonstrate.
    client.setMode('authenticated');
    const { calls } = installFetchQueue([{ status: 200, body: {} }]);
    await client.get('/api/feed');
    expect(host.__getTokenMock).toHaveBeenCalledTimes(2);
    expect(calls[0].headers['authorization']).toBe('Bearer cached.jwt');
  });

  // ── uploadFile / deleteUploadedFiles guest gating ───────────────────────
  it('uploadFile() in guest mode throws GuestAuthRequiredError', async () => {
    const host = makeFakeHost();
    const client = new OpenStoaClient({ host });
    client.setMode('guest');
    installFetchQueue([]);
    await expect(client.uploadFile('file:///tmp/foo.jpg')).rejects.toBeInstanceOf(
      GuestAuthRequiredError,
    );
  });

  it('deleteUploadedFiles() in guest mode returns null without firing fetch', async () => {
    const host = makeFakeHost();
    const client = new OpenStoaClient({ host });
    client.setMode('guest');
    const { calls } = installFetchQueue([]);
    const out = await client.deleteUploadedFiles(['https://x/y.jpg']);
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  // ── Mode default + post-construction behaviour ──────────────────────────
  it('default mode is "unknown" — no host login is auto-triggered pre-request', async () => {
    // mode='unknown' is NOT treated as guest by the pre-check, but it also
    // does NOT drive an authenticated host login pre-request (that only
    // happens when mode === 'authenticated'). The request goes through with
    // whatever token the host already had (or none); the screen-level
    // 401 handler is then responsible for surfacing GuestAuthRequiredError.
    const host = makeFakeHost({ initialToken: null });
    const client = new OpenStoaClient({ host });
    const { calls } = installFetchQueue([
      { status: 401, bodyText: '{"error":"Not authenticated"}' },
    ]);
    // The 401 path with no token + mode != 'authenticated' surfaces
    // GuestAuthRequiredError — see the same branch in `request()`.
    await expect(
      client.post('/api/topics/x/posts', { title: 't', content: 'c' }),
    ).rejects.toBeInstanceOf(GuestAuthRequiredError);
    expect(host.__loginMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['authorization']).toBeUndefined();
  });

  it('default mode is "unknown" — guest-safe GET proceeds without host login', async () => {
    // With mode='unknown' and a guest-safe path, the client does not gate
    // pre-flight and does not drive a host login. This is the boot window
    // (before OpenStoaApp has decided guest vs authenticated).
    const host = makeFakeHost({ initialToken: null });
    const client = new OpenStoaClient({ host });
    const { calls } = installFetchQueue([{ status: 200, body: { posts: [] } }]);
    await client.get('/api/feed');
    expect(host.__loginMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['authorization']).toBeUndefined();
  });

  // ── invalidateToken contract ────────────────────────────────────────────
  it('invalidateToken() forces the next request to re-fetch from the host', async () => {
    const host = makeFakeHost({ initialToken: 'cached.jwt' });
    const client = new OpenStoaClient({ host });
    client.setMode('authenticated');
    installFetchQueue([{ status: 200, body: {} }]);
    await client.get('/api/feed');
    expect(host.__getTokenMock).toHaveBeenCalledTimes(1);

    client.invalidateToken();
    installFetchQueue([{ status: 200, body: {} }]);
    await client.get('/api/feed');
    expect(host.__getTokenMock).toHaveBeenCalledTimes(2);
  });

  // ── GuestAuthRequiredError shape ─────────────────────────────────────────
  it('GuestAuthRequiredError carries the path and the kind discriminator', () => {
    const e = new GuestAuthRequiredError('/api/topics/abc/posts');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(GuestAuthRequiredError);
    expect(e.kind).toBe('GUEST_AUTH_REQUIRED');
    expect(e.path).toBe('/api/topics/abc/posts');
    // The path is a FIELD and no longer part of the message. Several screens
    // render a query error with `err.message`, and this one used to put
    // "Sign-in required for /api/topics/abc/posts" on screen — an endpoint
    // where an instruction belongs. Asserted as an absence so it cannot creep
    // back the next time someone wants a more informative message.
    expect(e.message).not.toContain('/api/');
    expect(e.message.trim()).not.toBe('');
    expect(e.name).toBe('GuestAuthRequiredError');
  });
});
