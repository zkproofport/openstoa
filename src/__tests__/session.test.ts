import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

// Set env before importing module
beforeAll(() => {
  process.env.COMMUNITY_JWT_SECRET = 'test-secret-key-for-jwt-signing-minimum-length';
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
    // Should have exp claim (24h)
    expect(payload!.exp).toBeDefined();
    expect(payload!.iat).toBeDefined();
  });

  it('should return null for an expired token', async () => {
    vi.useFakeTimers();
    const { createSession, verifySession } = await import('@/lib/session');

    const now = new Date('2026-01-01T00:00:00Z');
    vi.setSystemTime(now);
    const token = await createSession('user-expired', 'expireduser');

    vi.setSystemTime(new Date(now.getTime() + 25 * 60 * 60 * 1000));
    const payload = await verifySession(token);
    expect(payload).toBeNull();
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

  it('should throw when COMMUNITY_JWT_SECRET is not set', async () => {
    const originalSecret = process.env.COMMUNITY_JWT_SECRET;
    delete process.env.COMMUNITY_JWT_SECRET;

    vi.resetModules();
    const { createSession } = await import('@/lib/session');
    await expect(createSession('user', 'nick')).rejects.toThrow('COMMUNITY_JWT_SECRET');

    process.env.COMMUNITY_JWT_SECRET = originalSecret;
  });
});
