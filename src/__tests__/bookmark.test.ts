import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      bookmarks: { findFirst: vi.fn() },
      posts: { findFirst: vi.fn() },
      topicMembers: { findFirst: vi.fn() },
    },
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeGetRequest(postId: string) {
  return new NextRequest(`http://localhost:3200/api/posts/${postId}/bookmark`, {
    method: 'GET',
  });
}

function makePostRequest(postId: string) {
  return new NextRequest(`http://localhost:3200/api/posts/${postId}/bookmark`, {
    method: 'POST',
  });
}

describe('GET /api/posts/[postId]/bookmark', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns 401 when not authenticated', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue(null);

    const { GET } = await import('@/app/api/posts/[postId]/bookmark/route');
    const res = await GET(
      makeGetRequest('post-1'),
      { params: Promise.resolve({ postId: 'post-1' }) },
    );

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Not authenticated');
  });

  it('returns bookmarked: false when bookmark does not exist', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { db } = await import('@/lib/db');
    vi.mocked(db.query.bookmarks.findFirst).mockResolvedValue(undefined);

    const { GET } = await import('@/app/api/posts/[postId]/bookmark/route');
    const res = await GET(
      makeGetRequest('post-1'),
      { params: Promise.resolve({ postId: 'post-1' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.bookmarked).toBe(false);
  });

  it('returns bookmarked: true when bookmark exists', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { db } = await import('@/lib/db');
    vi.mocked(db.query.bookmarks.findFirst).mockResolvedValue({
      userId: 'user-1',
      postId: 'post-1',
      createdAt: new Date(),
    } as never);

    const { GET } = await import('@/app/api/posts/[postId]/bookmark/route');
    const res = await GET(
      makeGetRequest('post-1'),
      { params: Promise.resolve({ postId: 'post-1' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.bookmarked).toBe(true);
  });
});

describe('POST /api/posts/[postId]/bookmark', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns 401 when not authenticated', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue(null);

    const { POST } = await import('@/app/api/posts/[postId]/bookmark/route');
    const res = await POST(
      makePostRequest('post-1'),
      { params: Promise.resolve({ postId: 'post-1' }) },
    );

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Not authenticated');
  });

  it('returns bookmarked: true when bookmark did not exist (adds bookmark)', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({ id: 'post-1', topicId: 'topic-1' } as never);
    vi.mocked(db.query.topicMembers.findFirst).mockResolvedValue({ topicId: 'topic-1', userId: 'user-1', role: 'member' } as never);
    vi.mocked(db.query.bookmarks.findFirst).mockResolvedValue(undefined);

    const { POST } = await import('@/app/api/posts/[postId]/bookmark/route');
    const res = await POST(
      makePostRequest('post-1'),
      { params: Promise.resolve({ postId: 'post-1' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.bookmarked).toBe(true);
  });

  it('returns bookmarked: false when bookmark existed (removes bookmark)', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({ id: 'post-1', topicId: 'topic-1' } as never);
    vi.mocked(db.query.topicMembers.findFirst).mockResolvedValue({ topicId: 'topic-1', userId: 'user-1', role: 'member' } as never);
    vi.mocked(db.query.bookmarks.findFirst).mockResolvedValue({
      userId: 'user-1',
      postId: 'post-1',
      createdAt: new Date(),
    } as never);

    const { POST } = await import('@/app/api/posts/[postId]/bookmark/route');
    const res = await POST(
      makePostRequest('post-1'),
      { params: Promise.resolve({ postId: 'post-1' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.bookmarked).toBe(false);
  });
});
