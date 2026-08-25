import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// Set env before importing module
beforeAll(() => {
  process.env.COMMUNITY_JWT_SECRET = 'test-secret-key-for-jwt-signing-minimum-length';
});

// `verifySession` now confirms the token's userId still resolves to a real
// `users` row (S-2 fix — see src/lib/session.ts). Every test below runs
// against a mocked `@/lib/db` so that check is under test control instead of
// hitting a real database. Default: "the user exists" (found = true),
// matching every pre-existing test's assumption; individual tests override
// this per-case to exercise the deleted/missing-user paths.
const mocks = vi.hoisted(() => ({
  usersFindFirst: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      users: { findFirst: mocks.usersFindFirst },
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  mocks.usersFindFirst.mockReset();
  mocks.usersFindFirst.mockResolvedValue({ id: 'found', nickname: 'found-user' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session', () => {
  it('should create a valid JWT token', async () => {
    const { createSession, verifySession } = await import('@/lib/session');

    const token = await createSession('user-123', 'testuser');
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');

    // Token should have 3 parts (header.payload.signature)
    const parts = token.split('.');
    expect(parts.length).toBe(3);
  });

  it('should verify a valid token and return payload', async () => {
    const { createSession, verifySession } = await import('@/lib/session');

    const token = await createSession('user-456', 'alice');
    const payload = await verifySession(token);

    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe('user-456');
    expect(payload!.nickname).toBe('alice');
    expect(payload!.verifiedAt).toBeTypeOf('number');
    expect(payload!.verifiedAt).toBeLessThanOrEqual(Date.now());
  });

  it('should return null for an invalid token', async () => {
    const { verifySession } = await import('@/lib/session');

    const payload = await verifySession('invalid.token.here');
    expect(payload).toBeNull();
  });

  it('should return null for a tampered token', async () => {
    const { createSession, verifySession } = await import('@/lib/session');

    const token = await createSession('user-789', 'bob');
    // Tamper with the payload
    const parts = token.split('.');
    parts[1] = parts[1] + 'tampered';
    const tamperedToken = parts.join('.');

    const payload = await verifySession(tamperedToken);
    expect(payload).toBeNull();
  });

  it('should return null for an empty string', async () => {
    const { verifySession } = await import('@/lib/session');

    const payload = await verifySession('');
    expect(payload).toBeNull();
  });

  it('should contain correct payload fields', async () => {
    const { createSession, verifySession } = await import('@/lib/session');

    const before = Date.now();
    const token = await createSession('nullifier-hex', 'charlie');
    const after = Date.now();

    const payload = await verifySession(token);
    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe('nullifier-hex');
    expect(payload!.nickname).toBe('charlie');
    expect(payload!.verifiedAt).toBeGreaterThanOrEqual(before);
    expect(payload!.verifiedAt).toBeLessThanOrEqual(after);
    // Should have exp claim (the JWT backstop — Redis owns the real expiry)
    expect(payload!.exp).toBeDefined();
    expect(payload!.iat).toBeDefined();
  });

  it('should return null for an expired token', async () => {
    vi.useFakeTimers();
    const { createSession, verifySession } = await import('@/lib/session');

    const now = new Date('2026-01-01T00:00:00Z');
    vi.setSystemTime(now);
    const token = await createSession('user-expired', 'expireduser');

    /*
     * The JWT's own expiry is now the BACKSTOP, not the session's lifetime.
     *
     * The real expiry moved to the Redis record, which slides on every verified
     * request (`SESSION_TTL_SECONDS`), so a person who uses the app daily is
     * never signed out for having started long ago. The token is minted with a
     * deliberately LONGER date so two clocks cannot race — if this were still
     * 7d, the fixed date would silently win and the sliding behaviour would
     * appear to work right up until it arrived.
     *
     * 91 days: one past the mint, which is what proves the backstop still fires
     * rather than that expiry was removed.
     */
    vi.setSystemTime(new Date(now.getTime() + 91 * 24 * 60 * 60 * 1000));
    const payload = await verifySession(token);
    expect(payload).toBeNull();
  });

  it('BOUNDARY: still valid at 8 days — the old fixed window is gone', async () => {
    // Day eight is where the previous contract expired. A change that
    // reinstates a short fixed `exp` fails here rather than quietly signing
    // everyone out mid-week.
    vi.useFakeTimers();
    const { createSession, verifySession } = await import('@/lib/session');
    const now = new Date('2026-01-01T00:00:00Z');
    vi.setSystemTime(now);
    const token = await createSession('user-day8', 'day8user');
    vi.setSystemTime(new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000));
    expect(await verifySession(token)).not.toBeNull();
  });

  it('should return null for a random non-JWT string', async () => {
    const { verifySession } = await import('@/lib/session');

    const payload = await verifySession('notavalidtoken');
    expect(payload).toBeNull();
  });

  it('should return null for a token with only one part', async () => {
    const { verifySession } = await import('@/lib/session');

    const payload = await verifySession('eyJhbGciOiJIUzI1NiJ9');
    expect(payload).toBeNull();
  });

  it('should return null for a token signed with wrong secret', async () => {
    const { verifySession } = await import('@/lib/session');
    const { SignJWT } = await import('jose');

    const wrongSecret = new TextEncoder().encode('wrong-secret-key-definitely-not-correct');
    const token = await new SignJWT({ userId: 'hacker', nickname: 'hax' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(wrongSecret);

    const payload = await verifySession(token);
    expect(payload).toBeNull();
  });

  it('should return null for a pre-expired token signed with correct secret', async () => {
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode('test-secret-key-for-jwt-signing-minimum-length');
    const token = await new SignJWT({ userId: 'expired-user', nickname: 'expired', verifiedAt: Date.now() })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60) // expired 60 seconds ago
      .sign(secret);

    const { verifySession } = await import('@/lib/session');
    const payload = await verifySession(token);
    expect(payload).toBeNull();
  });

  it('should return null for a token with only dots', async () => {
    const { verifySession } = await import('@/lib/session');

    const payload = await verifySession('...');
    expect(payload).toBeNull();
  });

  it('should return null for a structurally valid but content-invalid token', async () => {
    const { verifySession } = await import('@/lib/session');

    const payload = await verifySession('eyJhbGciOiJIUzI1NiJ9.INVALID.INVALID');
    expect(payload).toBeNull();
  });

  it('should include isAI=true in payload when created with isAI option', async () => {
    const { createSession, verifySession } = await import('@/lib/session');

    const token = await createSession('ai-user-123', 'ai_agent', { isAI: true });
    const payload = await verifySession(token);

    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe('ai-user-123');
    expect(payload!.isAI).toBe(true);
  });

  it('should not include isAI in payload when created without isAI option', async () => {
    const { createSession, verifySession } = await import('@/lib/session');

    const token = await createSession('human-user-123', 'human_user');
    const payload = await verifySession(token);

    expect(payload).not.toBeNull();
    expect(payload!.isAI).toBeUndefined();
  });

  it('should not include isAI in payload when isAI is false', async () => {
    const { createSession, verifySession } = await import('@/lib/session');

    const token = await createSession('human-user-456', 'human_user2', { isAI: false });
    const payload = await verifySession(token);

    expect(payload).not.toBeNull();
    expect(payload!.isAI).toBeUndefined();
  });

  it('should throw when COMMUNITY_JWT_SECRET is not set', async () => {
    const originalSecret = process.env.COMMUNITY_JWT_SECRET;
    delete process.env.COMMUNITY_JWT_SECRET;

    vi.resetModules();
    const { createSession } = await import('@/lib/session');
    await expect(createSession('user', 'nick')).rejects.toThrow('COMMUNITY_JWT_SECRET');

    process.env.COMMUNITY_JWT_SECRET = originalSecret;
  });
});

/**
 * S-2: a signature-valid JWT naming a `users` row that no longer exists
 * (account deletion, or a truncated table as reproduced on staging) must
 * answer null (→ 401 at the route) instead of being trusted through to a
 * downstream FK-violation 500 that leaks raw Postgres driver text. See
 * `verifySession` in src/lib/session.ts and the edge-case matrix in the
 * task report for the full boundary/hostile/authz/race breakdown — the rows
 * that are testable at this (mocked-db) layer are covered here; the
 * DB-integration rows (real FK violation, real deleted row) are covered by
 * src/__tests__/e2e/auth.test.ts.
 */
describe('verifySession — deleted/missing user (S-2)', () => {
  it('boundary/hostile: returns null for a validly-signed token whose user row is gone', async () => {
    const { createSession, verifySession } = await import('@/lib/session');

    const token = await createSession('nullifier-deleted', 'was-a-real-user');
    mocks.usersFindFirst.mockResolvedValueOnce(undefined); // row truncated/deleted after the JWT was issued

    const payload = await verifySession(token);
    expect(payload).toBeNull();
  });

  it('contract-invocation: queries users.findFirst for a signature-valid token (spy would break if the lookup is removed)', async () => {
    const { createSession, verifySession } = await import('@/lib/session');

    const token = await createSession('nullifier-present', 'still-here');
    await verifySession(token);

    expect(mocks.usersFindFirst).toHaveBeenCalledTimes(1);
  });

  it('contract-invocation: does NOT query the db for a signature-invalid token (short-circuits before the DB round trip)', async () => {
    const { verifySession } = await import('@/lib/session');

    const payload = await verifySession('not.a.validtoken');
    expect(payload).toBeNull();
    expect(mocks.usersFindFirst).not.toHaveBeenCalled();
  });

  it('empty/whitespace/null/undefined userId are each rejected as separate cases, without a DB round trip for the structurally-empty ones', async () => {
    const { SignJWT } = await import('jose');
    const { verifySession } = await import('@/lib/session');
    const secret = new TextEncoder().encode(process.env.COMMUNITY_JWT_SECRET);

    const sign = (payload: Record<string, unknown>) =>
      new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('7d').sign(secret);

    // undefined — userId key omitted entirely
    const undefToken = await sign({ nickname: 'x' });
    expect(await verifySession(undefToken)).toBeNull();

    // null — userId explicitly null
    const nullToken = await sign({ userId: null, nickname: 'x' });
    expect(await verifySession(nullToken)).toBeNull();

    // empty string
    const emptyToken = await sign({ userId: '', nickname: 'x' });
    expect(await verifySession(emptyToken)).toBeNull();

    // None of the three structurally-empty cases above should have reached the DB.
    expect(mocks.usersFindFirst).not.toHaveBeenCalled();

    // whitespace-only IS a non-empty string, so it DOES reach the DB — and is
    // rejected there because no such row exists (simulated via the mock).
    mocks.usersFindFirst.mockResolvedValueOnce(undefined);
    const whitespaceToken = await sign({ userId: '   ', nickname: 'x' });
    expect(await verifySession(whitespaceToken)).toBeNull();
    expect(mocks.usersFindFirst).toHaveBeenCalledTimes(1);
  });

  it('UTF-8: a Korean/emoji userId is looked up and rejected like any other missing row, without crashing', async () => {
    const { createSession, verifySession } = await import('@/lib/session');

    const token = await createSession('닉네임-사용자-🎉', 'utf8-user');
    mocks.usersFindFirst.mockResolvedValueOnce(undefined);

    const payload = await verifySession(token);
    expect(payload).toBeNull();
  });

  it('very large: a 10,000-char userId is looked up and rejected without crashing', async () => {
    const { createSession, verifySession } = await import('@/lib/session');

    const hugeId = 'x'.repeat(10_000);
    const token = await createSession(hugeId, 'huge-id-user');
    mocks.usersFindFirst.mockResolvedValueOnce(undefined);

    const payload = await verifySession(token);
    expect(payload).toBeNull();
  });

  it('external dependency failure: a DB error during the users lookup fails CLOSED (null), never throws, never surfaces driver text', async () => {
    const { createSession, verifySession } = await import('@/lib/session');

    const token = await createSession('nullifier-present', 'still-here');
    mocks.usersFindFirst.mockRejectedValueOnce(
      new Error('insert or update on table "topics" violates foreign key constraint "topics_creator_id_users_id_fk"')
    );

    await expect(verifySession(token)).resolves.toBeNull();
  });

  it('result integrity: a still-existing user is unaffected — payload comes back exactly as signed', async () => {
    const { createSession, verifySession } = await import('@/lib/session');

    const token = await createSession('nullifier-present', 'still-here');
    // beforeEach default already mocks "found"; assert explicitly for clarity.
    mocks.usersFindFirst.mockResolvedValueOnce({ id: 'nullifier-present', nickname: 'still-here' });

    const payload = await verifySession(token);
    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe('nullifier-present');
    expect(payload!.nickname).toBe('still-here');
  });
});
