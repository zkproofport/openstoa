import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      votes: { findFirst: vi.fn() },
      posts: { findFirst: vi.fn() },
      topicMembers: { findFirst: vi.fn() },
    },
    delete: vi.fn().mockReturnValue({ where: vi.fn() }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ upvoteCount: 1 }]),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/postScore', () => ({
  updatePostScore: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/topicScore', () => ({
  updateTopicScore: vi.fn().mockResolvedValue(undefined),
}));

function makeRequest(postId: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3200/api/posts/${postId}/vote`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/posts/[postId]/vote', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns 401 when not authenticated', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue(null);

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('99999999-9999-9999-9999-999999999999', { value: 1 }),
      { params: Promise.resolve({ postId: '99999999-9999-9999-9999-999999999999' }) },
    );

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 400 when vote value is 0', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('99999999-9999-9999-9999-999999999999', { value: 0 }),
      { params: Promise.resolve({ postId: '99999999-9999-9999-9999-999999999999' }) },
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Value must be 1 or -1');
  });

  it('returns 400 when vote value is 2', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('99999999-9999-9999-9999-999999999999', { value: 2 }),
      { params: Promise.resolve({ postId: '99999999-9999-9999-9999-999999999999' }) },
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Value must be 1 or -1');
  });

  it('returns 400 when vote value is not 1 or -1 (string)', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('99999999-9999-9999-9999-999999999999', { value: 'up' }),
      { params: Promise.resolve({ postId: '99999999-9999-9999-9999-999999999999' }) },
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Value must be 1 or -1');
  });

  it('returns 404 when post does not exist', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue(undefined);

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('88888888-8888-8888-8888-888888888888', { value: 1 }),
      { params: Promise.resolve({ postId: '88888888-8888-8888-8888-888888888888' }) },
    );

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('Post not found');
  });

  it('allows non-members to vote on visible posts (Reddit-style)', async () => {
    // Membership is NOT required to vote — any authenticated user can
    // upvote/downvote a post they can see in the feed. Posting and
    // commenting still require membership (enforced by other endpoints).
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      topicId: 'topic-1',
      upvoteCount: 0,
    } as never);
    vi.mocked(db.query.votes.findFirst).mockResolvedValue(undefined);
    vi.mocked(db.query.topicMembers.findFirst).mockResolvedValue(undefined);

    const insertReturning = vi.fn().mockResolvedValue([{ id: 'vote-1' }]);
    const insertValues = vi.fn().mockReturnValue({ returning: insertReturning, then: (cb: any) => cb({}) });
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as never);

    const updateReturning = vi.fn().mockResolvedValue([{ upvoteCount: 1 }]);
    const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    vi.mocked(db.update).mockReturnValue({ set: updateSet } as never);

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('11111111-1111-1111-1111-111111111111', { value: 1 }),
      { params: Promise.resolve({ postId: '11111111-1111-1111-1111-111111111111' }) },
    );

    expect(res.status).toBe(200);
  });

  it('returns 200 with upvoteCount when new vote is cast', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      topicId: 'topic-1',
      upvoteCount: 0,
    } as never);
    vi.mocked(db.query.topicMembers.findFirst).mockResolvedValue({
      topicId: 'topic-1',
      userId: 'user-1',
      joinedAt: new Date(),
    } as never);
    vi.mocked(db.query.votes.findFirst).mockResolvedValue(undefined);

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('11111111-1111-1111-1111-111111111111', { value: 1 }),
      { params: Promise.resolve({ postId: '11111111-1111-1111-1111-111111111111' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.vote).toEqual({ value: 1 });
    expect(json.upvoteCount).toBeDefined();
  });

  // ── Score / topic activity bump invocation contract ──────────────────
  //
  // The vote route is the single source for sort=hot scoring. These tests
  // pin down that EVERY vote branch (new, toggle off, swap sign) triggers
  // both updatePostScore (post-level score) and updateTopicScore (topic-
  // level lastActivityAt + score). Removing either call must fail tests.

  it('new vote invokes updatePostScore AND updateTopicScore (with the post topic id)', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111', topicId: 'topic-1', upvoteCount: 0,
    } as never);
    vi.mocked(db.query.votes.findFirst).mockResolvedValue(undefined);

    const { updatePostScore } = await import('@/lib/postScore');
    const { updateTopicScore } = await import('@/lib/topicScore');
    vi.mocked(updatePostScore).mockClear();
    vi.mocked(updateTopicScore).mockClear();

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('11111111-1111-1111-1111-111111111111', { value: 1 }),
      { params: Promise.resolve({ postId: '11111111-1111-1111-1111-111111111111' }) },
    );

    expect(res.status).toBe(200);
    // Fire-and-forget but called synchronously inside the handler before
    // the response is returned, so the spy should already be hit.
    expect(updatePostScore).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
    expect(updateTopicScore).toHaveBeenCalledWith('topic-1');
  });

  it('vote toggle-off (same value re-sent) still invokes score updates', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({
      id: '22222222-2222-2222-2222-222222222222', topicId: 'topic-2', upvoteCount: 1,
    } as never);
    vi.mocked(db.query.votes.findFirst).mockResolvedValue({ value: 1 } as never);

    const { updatePostScore } = await import('@/lib/postScore');
    const { updateTopicScore } = await import('@/lib/topicScore');
    vi.mocked(updatePostScore).mockClear();
    vi.mocked(updateTopicScore).mockClear();

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('22222222-2222-2222-2222-222222222222', { value: 1 }),
      { params: Promise.resolve({ postId: '22222222-2222-2222-2222-222222222222' }) },
    );

    expect(res.status).toBe(200);
    expect(updatePostScore).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222');
    expect(updateTopicScore).toHaveBeenCalledWith('topic-2');
  });

  it('vote sign-swap (+1 -> -1) still invokes score updates', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({
      id: '33333333-3333-3333-3333-333333333333', topicId: 'topic-3', upvoteCount: 1,
    } as never);
    vi.mocked(db.query.votes.findFirst).mockResolvedValue({ value: 1 } as never);

    const { updatePostScore } = await import('@/lib/postScore');
    const { updateTopicScore } = await import('@/lib/topicScore');
    vi.mocked(updatePostScore).mockClear();
    vi.mocked(updateTopicScore).mockClear();

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('33333333-3333-3333-3333-333333333333', { value: -1 }),
      { params: Promise.resolve({ postId: '33333333-3333-3333-3333-333333333333' }) },
    );

    expect(res.status).toBe(200);
    expect(updatePostScore).toHaveBeenCalledWith('33333333-3333-3333-3333-333333333333');
    expect(updateTopicScore).toHaveBeenCalledWith('topic-3');
  });

  it('score update failure is swallowed (fire-and-forget contract)', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({
      id: '44444444-4444-4444-4444-444444444444', topicId: 'topic-4', upvoteCount: 0,
    } as never);
    vi.mocked(db.query.votes.findFirst).mockResolvedValue(undefined);

    const { updatePostScore } = await import('@/lib/postScore');
    vi.mocked(updatePostScore).mockRejectedValueOnce(new Error('boom'));

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('44444444-4444-4444-4444-444444444444', { value: 1 }),
      { params: Promise.resolve({ postId: '44444444-4444-4444-4444-444444444444' }) },
    );

    // The user-facing vote action must still succeed even if score
    // recompute fails. The catch handler logs and moves on.
    expect(res.status).toBe(200);
  });
});
