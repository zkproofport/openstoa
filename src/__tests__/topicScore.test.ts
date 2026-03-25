import { describe, it, expect, vi, beforeEach } from 'vitest';

let selectCallCount = 0;

const mockDbSelectResult = (rows: object[]) => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(rows),
  }),
});

const { mockFindFirst, mockSelectFn, mockUpdateWhere, mockUpdateSet, mockUpdateFn } = vi.hoisted(() => {
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdateFn = vi.fn().mockReturnValue({ set: mockUpdateSet });
  const mockFindFirst = vi.fn();
  const mockSelectFn = vi.fn();
  return { mockFindFirst, mockSelectFn, mockUpdateWhere, mockUpdateSet, mockUpdateFn };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: mockSelectFn,
    query: {
      topics: {
        findFirst: mockFindFirst,
      },
    },
    update: mockUpdateFn,
  },
}));

vi.mock('@/lib/db/schema', () => ({
  topics: { id: 'id', createdAt: 'createdAt', score: 'score', lastActivityAt: 'lastActivityAt' },
  posts: { topicId: 'topicId', createdAt: 'createdAt' },
  topicMembers: { topicId: 'topicId' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  sql: vi.fn(),
}));

import { updateTopicScore } from '@/lib/topicScore';

beforeEach(() => {
  vi.clearAllMocks();
  selectCallCount = 0;

  mockSelectFn.mockImplementation(() => {
    selectCallCount++;
    if (selectCallCount === 1) {
      return mockDbSelectResult([{ count: 4 }]);
    }
    return mockDbSelectResult([{ count: 6 }]);
  });

  mockUpdateFn.mockReturnValue({ set: mockUpdateSet });
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockResolvedValue(undefined);
});

describe('updateTopicScore', () => {
  it('returns early when topic is not found', async () => {
    mockFindFirst.mockResolvedValueOnce(undefined);

    await updateTopicScore('topic-missing');

    expect(mockUpdateFn).not.toHaveBeenCalled();
  });

  it('calculates score and updates the topic when it exists', async () => {
    const createdAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    mockFindFirst.mockResolvedValueOnce({ id: 'topic-1', createdAt });

    await updateTopicScore('topic-1');

    expect(mockUpdateFn).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);

    const setArg = mockUpdateSet.mock.calls[0][0];
    expect(typeof setArg.score).toBe('number');
    expect(setArg.score).toBeGreaterThan(0);
    expect(setArg.lastActivityAt).toBeInstanceOf(Date);
  });

  it('computes score using (memberCount * 2) + (recentPosts * 3) + (1 / timeDecay) * 10', async () => {
    const now = Date.now();
    const ageDays = 3;
    const createdAt = new Date(now - ageDays * 24 * 60 * 60 * 1000);
    mockFindFirst.mockResolvedValueOnce({ id: 'topic-1', createdAt });

    await updateTopicScore('topic-1');

    const setArg = mockUpdateSet.mock.calls[0][0];
    const timeDecay = Math.log2(ageDays + 2);
    const expectedScore = (6 * 2) + (4 * 3) + (1 / timeDecay) * 10;

    expect(setArg.score).toBeCloseTo(expectedScore, 5);
  });
});
