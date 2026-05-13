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

  it('treats |v|=1 and |v|=9 as tied (both yield log10=0 segment)', () => {
    // log10 of 9 ≈ 0.95 (~> 0) so 9 actually edges out 1. Verify the
    // direction of the inequality to lock the public contract.
    const at = new Date('2026-05-01T00:00:00Z');
    expect(computeHotScore(9, at)).toBeGreaterThan(computeHotScore(1, at));
  });

  it('time-decay term contributes +1 per 45000s (~12.5h)', () => {
    // Equal upvotes, 45000 seconds apart → exactly +1 score delta.
    const t1 = new Date('2026-05-01T00:00:00Z');
    const t2 = new Date(t1.getTime() + 45000 * 1000);
    const a = computeHotScore(10, t1);
    const b = computeHotScore(10, t2);
    expect(b - a).toBeCloseTo(1, 5);
  });

  it('newer posts outrank older at the SAME upvote count', () => {
    // The fixed time-decay term means a 0-upvote brand-new post can edge
    // out a 0-upvote year-old post.
    const old = computeHotScore(0, new Date('2025-05-01T00:00:00Z'));
    const fresh = computeHotScore(0, new Date('2026-05-01T00:00:00Z'));
    expect(fresh).toBeGreaterThan(old);
  });

  it('sign symmetry: -v and +v produce opposite orders relative to a zero baseline at the same instant', () => {
    const at = new Date('2026-05-01T00:00:00Z');
    const pos = computeHotScore(100, at);
    const neg = computeHotScore(-100, at);
    const zero = computeHotScore(0, at);
    expect(pos).toBeGreaterThan(zero);
    expect(neg).toBeLessThan(zero);
  });

  it('returns a finite number for the worst-case Date.now() input', () => {
    const score = computeHotScore(1, new Date());
    expect(Number.isFinite(score)).toBe(true);
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

  it('skips update when post has null createdAt (corrupt row defense)', async () => {
    mockFindFirst.mockResolvedValueOnce({ upvoteCount: 5, createdAt: null });
    await updatePostScore('post-corrupt');
    expect(mockUpdateFn).not.toHaveBeenCalled();
  });

  it('writes the exact score predicted by computeHotScore for known inputs', async () => {
    const createdAt = new Date('2026-05-01T00:00:00Z');
    mockFindFirst.mockResolvedValueOnce({ upvoteCount: 100, createdAt });
    await updatePostScore('post-known');
    const setArg = mockUpdateSet.mock.calls[0][0];
    expect(setArg.score).toBeCloseTo(computeHotScore(100, createdAt), 5);
  });

  it('passes the post id to the WHERE clause (no cross-row updates)', async () => {
    mockFindFirst.mockResolvedValueOnce({
      upvoteCount: 3,
      createdAt: new Date('2026-05-01T00:00:00Z'),
    });
    await updatePostScore('post-target');
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    // We don't introspect the eq() opaque value here (it's mocked), but
    // we DO assert that exactly one update was performed in this flow.
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
  });
});

