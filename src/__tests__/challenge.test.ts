import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRedis = vi.hoisted(() => ({
  set: vi.fn().mockResolvedValue('OK'),
  get: vi.fn(),
  del: vi.fn().mockResolvedValue(1),
  eval: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  redis: mockRedis,
}));

import { createChallenge, consumeChallenge } from '@/lib/challenge';

describe('createChallenge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return a challengeId, scope, and expiresIn', async () => {
    const result = await createChallenge();

    expect(result.challengeId).toBeTruthy();
    expect(typeof result.challengeId).toBe('string');
    expect(result.scope).toBe('zkproofport-community');
    expect(result.expiresIn).toBe(300);
  });

  it('should store challenge in Redis with TTL (timestamp value)', async () => {
    const before = Math.floor(Date.now() / 1000);
    const result = await createChallenge();
    const after = Math.floor(Date.now() / 1000);

    expect(mockRedis.set).toHaveBeenCalledWith(
      `community:challenge:${result.challengeId}`,
      expect.any(String),
      'EX',
      300,
    );

    // Verify stored value is a valid unix timestamp
    const storedValue = Number(mockRedis.set.mock.calls[0][1]);
    expect(storedValue).toBeGreaterThanOrEqual(before);
    expect(storedValue).toBeLessThanOrEqual(after);
  });

  it('should generate unique challengeIds', async () => {
    const result1 = await createChallenge();
    const result2 = await createChallenge();

    expect(result1.challengeId).not.toBe(result2.challengeId);
  });

  it('should return a valid UUID format', async () => {
    const result = await createChallenge();
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(result.challengeId).toMatch(uuidRegex);
  });
});

describe('consumeChallenge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return timestamp (number) for a valid challenge', async () => {
    mockRedis.eval.mockResolvedValue('1712345678');

    const result = await consumeChallenge('test-challenge-id');

    expect(result).toBe(1712345678);
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get'"),
      1,
      'community:challenge:test-challenge-id',
    );
  });

  it('should return null for an expired/missing challenge', async () => {
    mockRedis.eval.mockResolvedValue(null);

    const result = await consumeChallenge('expired-challenge-id');

    expect(result).toBeNull();
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get'"),
      1,
      'community:challenge:expired-challenge-id',
    );
  });

  it('should return null on second consumption (replay prevention)', async () => {
    // First call: challenge exists, atomic get+del returns timestamp
    mockRedis.eval.mockResolvedValueOnce('1712345678');
    // Second call: challenge already consumed, returns null
    mockRedis.eval.mockResolvedValueOnce(null);

    const first = await consumeChallenge('one-time-challenge');
    expect(first).toBe(1712345678);

    const second = await consumeChallenge('one-time-challenge');
    expect(second).toBeNull();
  });

  it('should propagate Redis error in consumeChallenge', async () => {
    mockRedis.eval.mockRejectedValueOnce(new Error('Redis timeout'));
    await expect(consumeChallenge('test-id')).rejects.toThrow('Redis timeout');
  });

  it('should return null when Redis eval returns null (expired challenge)', async () => {
    mockRedis.eval.mockResolvedValue(null);
    const result = await consumeChallenge('very-old-challenge');
    expect(result).toBeNull();
  });

  it('should handle concurrent consumption attempts atomically', async () => {
    // First call wins
    mockRedis.eval.mockResolvedValueOnce('1712345678');
    // All subsequent calls lose (already consumed)
    mockRedis.eval.mockResolvedValue(null);

    const results = await Promise.all([
      consumeChallenge('race-challenge'),
      consumeChallenge('race-challenge'),
      consumeChallenge('race-challenge'),
    ]);

    const successes = results.filter(r => r !== null);
    expect(successes.length).toBe(1); // exactly one winner
  });

  it('should propagate Redis errors', async () => {
    mockRedis.eval.mockRejectedValue(new Error('Redis connection refused'));
    await expect(consumeChallenge('error-challenge')).rejects.toThrow('Redis connection refused');
  });
});

describe('createChallenge Redis errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should propagate Redis error in createChallenge', async () => {
    mockRedis.set.mockRejectedValueOnce(new Error('Redis connection lost'));
    await expect(createChallenge()).rejects.toThrow('Redis connection lost');
  });
});
