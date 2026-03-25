import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const mockPublisher = vi.hoisted(() => ({
  publish: vi.fn().mockResolvedValue(1),
  hset: vi.fn().mockResolvedValue(1),
  hdel: vi.fn().mockResolvedValue(1),
  hgetall: vi.fn().mockResolvedValue({}),
  hget: vi.fn(),
  on: vi.fn(),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => mockPublisher),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  publishChatMessage,
  addPresence,
  removePresence,
  getPresence,
  refreshPresence,
  type ChatMessagePayload,
} from '@/lib/chat';

beforeAll(() => {
  process.env.REDIS_URL = 'redis://localhost:6379';
});

beforeEach(() => {
  vi.clearAllMocks();
});

const makePayload = (overrides?: Partial<ChatMessagePayload>): ChatMessagePayload => ({
  id: 'msg-1',
  topicId: 'topic-abc',
  userId: 'user-1',
  nickname: 'alice',
  profileImage: null,
  message: 'hello',
  type: 'message',
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('publishChatMessage', () => {
  it('publishes to the correct channel key', async () => {
    const payload = makePayload({ topicId: 'topic-123' });
    await publishChatMessage('topic-123', payload);

    expect(mockPublisher.publish).toHaveBeenCalledWith(
      'chat:topic:topic-123',
      JSON.stringify(payload),
    );
  });

  it('publishes a JSON-serialised payload', async () => {
    const payload = makePayload();
    await publishChatMessage('topic-abc', payload);

    const [, body] = mockPublisher.publish.mock.calls[0];
    expect(() => JSON.parse(body)).not.toThrow();
    expect(JSON.parse(body)).toMatchObject({ id: 'msg-1', message: 'hello' });
  });
});

describe('addPresence', () => {
  it('stores a presence entry under the correct key', async () => {
    await addPresence('topic-xyz', 'user-1', 'alice', null);

    expect(mockPublisher.hset).toHaveBeenCalledWith(
      'chat:presence:topic-xyz',
      'user-1',
      expect.stringContaining('"nickname":"alice"'),
    );
  });

  it('uses chat:presence:{topicId} key format', async () => {
    await addPresence('my-topic', 'u1', 'bob');
    const [key] = mockPublisher.hset.mock.calls[0];
    expect(key).toBe('chat:presence:my-topic');
  });

  it('stores a connectedAt timestamp', async () => {
    await addPresence('t1', 'u1', 'carol');
    const [, , raw] = mockPublisher.hset.mock.calls[0];
    const entry = JSON.parse(raw);
    expect(entry.connectedAt).toBeTruthy();
    expect(new Date(entry.connectedAt).toISOString()).toBe(entry.connectedAt);
  });
});

describe('removePresence', () => {
  it('deletes the user field from the presence hash', async () => {
    await removePresence('topic-abc', 'user-1');

    expect(mockPublisher.hdel).toHaveBeenCalledWith('chat:presence:topic-abc', 'user-1');
  });
});

describe('getPresence', () => {
  it('returns an empty array when no entries exist', async () => {
    mockPublisher.hgetall.mockResolvedValueOnce({});
    const result = await getPresence('topic-abc');
    expect(result).toEqual([]);
  });

  it('returns parsed presence entries', async () => {
    const entry = { nickname: 'alice', profileImage: null, connectedAt: new Date().toISOString() };
    mockPublisher.hgetall.mockResolvedValueOnce({ 'user-1': JSON.stringify(entry) });

    const result = await getPresence('topic-abc');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ userId: 'user-1', nickname: 'alice' });
  });

  it('prunes stale entries (connectedAt older than 5 minutes)', async () => {
    const freshEntry = {
      nickname: 'alice',
      connectedAt: new Date().toISOString(),
    };
    const staleEntry = {
      nickname: 'bob',
      connectedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(), // 6 minutes ago
    };
    mockPublisher.hgetall.mockResolvedValueOnce({
      'user-fresh': JSON.stringify(freshEntry),
      'user-stale': JSON.stringify(staleEntry),
    });

    const result = await getPresence('topic-abc');

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe('user-fresh');
    expect(mockPublisher.hdel).toHaveBeenCalledWith(
      'chat:presence:topic-abc',
      'user-stale',
    );
  });

  it('returns empty array when hgetall returns null', async () => {
    mockPublisher.hgetall.mockResolvedValueOnce(null);
    const result = await getPresence('topic-abc');
    expect(result).toEqual([]);
  });
});

describe('refreshPresence', () => {
  it('updates connectedAt timestamp for an existing user', async () => {
    const existing = { nickname: 'alice', connectedAt: new Date(Date.now() - 60000).toISOString() };
    mockPublisher.hget.mockResolvedValueOnce(JSON.stringify(existing));

    await refreshPresence('topic-abc', 'user-1');

    expect(mockPublisher.hset).toHaveBeenCalledWith(
      'chat:presence:topic-abc',
      'user-1',
      expect.stringContaining('"connectedAt"'),
    );
    const [, , raw] = mockPublisher.hset.mock.calls[0];
    const updated = JSON.parse(raw);
    expect(new Date(updated.connectedAt).getTime()).toBeGreaterThan(
      new Date(existing.connectedAt).getTime(),
    );
  });

  it('does nothing when user is not in presence hash', async () => {
    mockPublisher.hget.mockResolvedValueOnce(null);
    await refreshPresence('topic-abc', 'user-ghost');
    expect(mockPublisher.hset).not.toHaveBeenCalled();
  });
});
