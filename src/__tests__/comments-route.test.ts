import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      posts: { findFirst: vi.fn() },
      topicMembers: { findFirst: vi.fn() },
      topics: { findFirst: vi.fn() },
      users: { findFirst: vi.fn() },
    },
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'comment-1', content: 'hello' }]),
      }),
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/verification-cache', () => ({
  getUserBadges: vi.fn().mockResolvedValue([]),
  filterBadgesByTopicProofType: vi.fn().mockReturnValue([]),
}));

vi.mock('@/lib/topicScore', () => ({
  updateTopicScore: vi.fn().mockResolvedValue(undefined),
}));

function makeRequest(postId: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3200/api/posts/${postId}/comments`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function runRoute(postId: string, body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/posts/[postId]/comments/route');
  return POST(
    makeRequest(postId, body),
    { params: Promise.resolve({ postId }) },
  );
}

describe('POST /api/posts/[postId]/comments', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns 401 when not authenticated', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await runRoute('11111111-1111-1111-1111-111111111111', { content: 'hi' });
    expect(res.status).toBe(401);
  });

  it('returns 404 when post does not exist', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });
    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue(undefined);

    const res = await runRoute('77777777-7777-7777-7777-777777777777', { content: 'hi' });
    expect(res.status).toBe(404);
  });

  it('returns 403 when user is not a member of the topic (commenting requires membership)', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });
    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111', topicId: 'topic-1' } as never);
    vi.mocked(db.query.topicMembers.findFirst).mockResolvedValue(undefined);

    const res = await runRoute('11111111-1111-1111-1111-111111111111', { content: 'hi' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when content is missing', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });
    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111', topicId: 'topic-1' } as never);
    vi.mocked(db.query.topicMembers.findFirst).mockResolvedValue({} as never);

    const res = await runRoute('11111111-1111-1111-1111-111111111111', {});
    expect(res.status).toBe(400);
  });

  it('returns 400 when content exceeds 10,000 chars (server-side cap)', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });
    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111', topicId: 'topic-1' } as never);
    vi.mocked(db.query.topicMembers.findFirst).mockResolvedValue({} as never);

    const tooLong = 'a'.repeat(10_001);
    const res = await runRoute('11111111-1111-1111-1111-111111111111', { content: tooLong });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/comment/i);
  });

  it('accepts exactly 10,000 chars (boundary at the cap)', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });
    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111', topicId: 'topic-1' } as never);
    vi.mocked(db.query.topicMembers.findFirst).mockResolvedValue({} as never);
    vi.mocked(db.query.topics.findFirst).mockResolvedValue({ proofType: 'none' } as never);
    vi.mocked(db.query.users.findFirst).mockResolvedValue({ nickname: 'alice', profileImage: null } as never);

    const atCap = 'a'.repeat(10_000);
    const res = await runRoute('11111111-1111-1111-1111-111111111111', { content: atCap });
    expect(res.status).toBe(201);
  });

  // ── Contract invocation: updateTopicScore must be fired on every successful comment ──
  it('invokes updateTopicScore(post.topicId) after a successful comment (regression guard)', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });
    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({ id: '55555555-5555-5555-5555-555555555555', topicId: 'topic-X' } as never);
    vi.mocked(db.query.topicMembers.findFirst).mockResolvedValue({} as never);
    vi.mocked(db.query.topics.findFirst).mockResolvedValue({ proofType: 'none' } as never);
    vi.mocked(db.query.users.findFirst).mockResolvedValue({ nickname: 'alice', profileImage: null } as never);
    const { updateTopicScore } = await import('@/lib/topicScore');
    vi.mocked(updateTopicScore).mockClear();

    const res = await runRoute('55555555-5555-5555-5555-555555555555', { content: 'hi' });
    expect(res.status).toBe(201);
    expect(updateTopicScore).toHaveBeenCalledWith('topic-X');
  });

  it('still returns 201 even if updateTopicScore throws (fire-and-forget contract)', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });
    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111', topicId: 'topic-1' } as never);
    vi.mocked(db.query.topicMembers.findFirst).mockResolvedValue({} as never);
    vi.mocked(db.query.topics.findFirst).mockResolvedValue({ proofType: 'none' } as never);
    vi.mocked(db.query.users.findFirst).mockResolvedValue({ nickname: 'alice', profileImage: null } as never);
    const { updateTopicScore } = await import('@/lib/topicScore');
    vi.mocked(updateTopicScore).mockRejectedValueOnce(new Error('boom'));

    const res = await runRoute('11111111-1111-1111-1111-111111111111', { content: 'hi' });
    expect(res.status).toBe(201);
  });
});
