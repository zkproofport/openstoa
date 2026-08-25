import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/postReadable', () => ({
  /*
   * The authorisation is a dependency here, not the subject.
   *
   * This file is about whether the route toggles and re-scores; the rule for
   * WHO may act on a post lives in `canActOnPost` and is proved end to end in
   * `src/__tests__/e2e/acting-on-a-post-you-cannot-read.test.ts`. Mocking it
   * keeps this file's subject intact — and the refusal case below is what
   * stops the mock from hiding the guard's removal.
   */
  canActOnPost: vi.fn().mockResolvedValue(true),
  NOT_A_MEMBER: 'Not a member of this topic',
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
      makeGetRequest('11111111-1111-1111-1111-111111111111'),
      { params: Promise.resolve({ postId: '11111111-1111-1111-1111-111111111111' }) },
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
      makeGetRequest('11111111-1111-1111-1111-111111111111'),
      { params: Promise.resolve({ postId: '11111111-1111-1111-1111-111111111111' }) },
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
      postId: '11111111-1111-1111-1111-111111111111',
      createdAt: new Date(),
    } as never);

    const { GET } = await import('@/app/api/posts/[postId]/bookmark/route');
    const res = await GET(
      makeGetRequest('11111111-1111-1111-1111-111111111111'),
      { params: Promise.resolve({ postId: '11111111-1111-1111-1111-111111111111' }) },
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
      makePostRequest('11111111-1111-1111-1111-111111111111'),
      { params: Promise.resolve({ postId: '11111111-1111-1111-1111-111111111111' }) },
    );

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Not authenticated');
  });

  it('returns bookmarked: true when bookmark did not exist (adds bookmark)', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111', topicId: 'topic-1' } as never);
    vi.mocked(db.query.topicMembers.findFirst).mockResolvedValue({ topicId: 'topic-1', userId: 'user-1', role: 'member' } as never);
    vi.mocked(db.query.bookmarks.findFirst).mockResolvedValue(undefined);

    const { POST } = await import('@/app/api/posts/[postId]/bookmark/route');
    const res = await POST(
      makePostRequest('11111111-1111-1111-1111-111111111111'),
      { params: Promise.resolve({ postId: '11111111-1111-1111-1111-111111111111' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.bookmarked).toBe(true);
  });

  it('returns bookmarked: false when bookmark existed (removes bookmark)', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111', topicId: 'topic-1' } as never);
    vi.mocked(db.query.topicMembers.findFirst).mockResolvedValue({ topicId: 'topic-1', userId: 'user-1', role: 'member' } as never);
    vi.mocked(db.query.bookmarks.findFirst).mockResolvedValue({
      userId: 'user-1',
      postId: '11111111-1111-1111-1111-111111111111',
      createdAt: new Date(),
    } as never);

    const { POST } = await import('@/app/api/posts/[postId]/bookmark/route');
    const res = await POST(
      makePostRequest('11111111-1111-1111-1111-111111111111'),
      { params: Promise.resolve({ postId: '11111111-1111-1111-1111-111111111111' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.bookmarked).toBe(false);
  });

  it('AUTHZ: refuses when the caller may not act on the post', async () => {
    /*
     * The guard this file would otherwise let anyone delete. With
     * `canActOnPost` mocked to true for every other case, removing the call
     * from the route would leave every test here green — and a signed-in
     * stranger could react to a post inside somebody's private topic, which is
     * what was actually happening before it existed.
     */
    const { canActOnPost } = await import('@/lib/postReadable');
    vi.mocked(canActOnPost).mockResolvedValueOnce(false);

    const { POST } = await import('@/app/api/posts/[postId]/bookmark/route');
    const res = await POST(
      makePostRequest('11111111-1111-1111-1111-111111111111'),
      { params: Promise.resolve({ postId: '11111111-1111-1111-1111-111111111111' }) },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Not a member of this topic');
  });
});
