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

  it('should store challenge in Redis with TTL', async () => {
    const result = await createChallenge();

    expect(mockRedis.set).toHaveBeenCalledWith(
      `community:challenge:${result.challengeId}`,
      '1',
      'EX',
      300,
    );
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

  it('should return true for a valid challenge', async () => {
    mockRedis.eval.mockResolvedValue('1');

    const result = await consumeChallenge('test-challenge-id');

    expect(result).toBe(true);
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get'"),
      1,
      'community:challenge:test-challenge-id',
    );
  });

  it('should return false for an expired/missing challenge', async () => {
    mockRedis.eval.mockResolvedValue(null);

    const result = await consumeChallenge('expired-challenge-id');

    expect(result).toBe(false);
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get'"),
      1,
      'community:challenge:expired-challenge-id',
    );
  });

  it('should return false on second consumption (replay prevention)', async () => {
    // First call: challenge exists, atomic get+del returns value
    mockRedis.eval.mockResolvedValueOnce('1');
    // Second call: challenge already consumed, returns null
    mockRedis.eval.mockResolvedValueOnce(null);

    const first = await consumeChallenge('one-time-challenge');
    expect(first).toBe(true);

    const second = await consumeChallenge('one-time-challenge');
    expect(second).toBe(false);
  });
});
