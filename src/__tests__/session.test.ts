import { describe, it, expect, vi, beforeAll } from 'vitest';

// Set env before importing module
beforeAll(() => {
  process.env.COMMUNITY_JWT_SECRET = 'test-secret-key-for-jwt-signing-minimum-length';
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
});
