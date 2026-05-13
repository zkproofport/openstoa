import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUpdateWhere, mockUpdateSet, mockUpdateFn, mockFindFirst } = vi.hoisted(() => ({
  mockUpdateWhere: vi.fn().mockResolvedValue(undefined),
  mockUpdateSet: vi.fn(),
  mockUpdateFn: vi.fn(),
  mockFindFirst: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    query: { posts: { findFirst: mockFindFirst } },
    update: mockUpdateFn,
  },
}));

vi.mock('@/lib/db/schema', () => ({
  posts: { id: 'id', score: 'score' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

import { computeHotScore, updatePostScore } from '@/lib/postScore';

describe('computeHotScore', () => {
  it('returns higher score for newer posts at equal upvotes', () => {
    const older = computeHotScore(10, new Date('2026-01-01T00:00:00Z'));
    const newer = computeHotScore(10, new Date('2026-05-01T00:00:00Z'));
    expect(newer).toBeGreaterThan(older);
  });

  it('returns higher score for more upvotes at the same time', () => {
    const at = new Date('2026-05-01T00:00:00Z');
    const less = computeHotScore(5, at);
    const more = computeHotScore(500, at);
    expect(more).toBeGreaterThan(less);
  });

  it('rewards votes once they cross the log10 threshold', () => {
    const at = new Date('2026-05-01T00:00:00Z');
    // log10(max(|v|,1)) is 0 for |v| in [0,1], so 0 and 1 share the same
    // score. Reddit's hot intentionally rewards votes at the order-of-
    // magnitude boundary (10, 100, ...) so we assert ≥10 upvotes wins.
    const tied = computeHotScore(0, at);
    const meaningful = computeHotScore(10, at);
    expect(meaningful).toBeGreaterThan(tied);
  });

  it('returns negative score for net-downvoted posts', () => {
    const at = new Date('2000-01-01T00:00:00Z');
    expect(computeHotScore(-100, at)).toBeLessThan(0);
  });
});

describe('updatePostScore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateFn.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);
  });

  it('skips update when post is missing', async () => {
    mockFindFirst.mockResolvedValueOnce(undefined);
    await updatePostScore('missing');
    expect(mockUpdateFn).not.toHaveBeenCalled();
  });

  it('writes recomputed score for an existing post', async () => {
    mockFindFirst.mockResolvedValueOnce({
      upvoteCount: 7,
      createdAt: new Date('2026-05-01T00:00:00Z'),
    });
    await updatePostScore('post-1');
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    const setArg = mockUpdateSet.mock.calls[0][0];
    expect(typeof setArg.score).toBe('number');
    expect(Number.isFinite(setArg.score)).toBe(true);
  });
});

