import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/session', () => ({
  getSessionFromCookies: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      votes: { findFirst: vi.fn() },
      posts: { findFirst: vi.fn() },
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
    const { getSessionFromCookies } = await import('@/lib/session');
    vi.mocked(getSessionFromCookies).mockResolvedValue(null);

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('test-post-id', { value: 1 }),
      { params: Promise.resolve({ postId: 'test-post-id' }) },
    );

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 400 when vote value is 0', async () => {
    const { getSessionFromCookies } = await import('@/lib/session');
    vi.mocked(getSessionFromCookies).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('test-post-id', { value: 0 }),
      { params: Promise.resolve({ postId: 'test-post-id' }) },
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Value must be 1 or -1');
  });

  it('returns 400 when vote value is 2', async () => {
    const { getSessionFromCookies } = await import('@/lib/session');
    vi.mocked(getSessionFromCookies).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('test-post-id', { value: 2 }),
      { params: Promise.resolve({ postId: 'test-post-id' }) },
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Value must be 1 or -1');
  });

  it('returns 400 when vote value is not 1 or -1 (string)', async () => {
    const { getSessionFromCookies } = await import('@/lib/session');
    vi.mocked(getSessionFromCookies).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('test-post-id', { value: 'up' }),
      { params: Promise.resolve({ postId: 'test-post-id' }) },
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Value must be 1 or -1');
  });

  it('returns 404 when post does not exist', async () => {
    const { getSessionFromCookies } = await import('@/lib/session');
    vi.mocked(getSessionFromCookies).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue(undefined);

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('nonexistent-post', { value: 1 }),
      { params: Promise.resolve({ postId: 'nonexistent-post' }) },
    );

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('Post not found');
  });

  it('returns 200 with upvoteCount when new vote is cast', async () => {
    const { getSessionFromCookies } = await import('@/lib/session');
    vi.mocked(getSessionFromCookies).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({
      id: 'post-1',
      upvoteCount: 0,
    } as never);
    vi.mocked(db.query.votes.findFirst).mockResolvedValue(undefined);

    const { POST } = await import('@/app/api/posts/[postId]/vote/route');
    const res = await POST(
      makeRequest('post-1', { value: 1 }),
      { params: Promise.resolve({ postId: 'post-1' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.vote).toEqual({ value: 1 });
    expect(json.upvoteCount).toBeDefined();
  });
});
