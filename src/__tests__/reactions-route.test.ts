import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      posts: { findFirst: vi.fn() },
      reactions: { findFirst: vi.fn() },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/topicScore', () => ({
  updateTopicScore: vi.fn().mockResolvedValue(undefined),
}));

function makeRequest(postId: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3200/api/posts/${postId}/reactions`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function runRoute(postId: string, body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/posts/[postId]/reactions/route');
  return POST(
    makeRequest(postId, body),
    { params: Promise.resolve({ postId }) },
  );
}

describe('POST /api/posts/[postId]/reactions', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns 401 when not authenticated', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await runRoute('post-1', { emoji: '🔥' });
    expect(res.status).toBe(401);
  });

  it('returns 400 for an unsupported emoji (only the curated 6 are allowed)', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });
    const res = await runRoute('post-1', { emoji: '💩' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when emoji is missing', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });
    const res = await runRoute('post-1', {});
    expect(res.status).toBe(400);
  });

  it('returns 404 when post does not exist', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });
    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue(undefined);
    const res = await runRoute('missing', { emoji: '🔥' });
    expect(res.status).toBe(404);
  });

  it('add path: returns { added: true } and invokes updateTopicScore', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });
    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({ id: 'post-X', topicId: 'topic-X' } as never);
    vi.mocked(db.query.reactions.findFirst).mockResolvedValue(undefined);
    const { updateTopicScore } = await import('@/lib/topicScore');
    vi.mocked(updateTopicScore).mockClear();

    const res = await runRoute('post-X', { emoji: '🔥' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: true });
    expect(updateTopicScore).toHaveBeenCalledWith('topic-X');
  });

  it('remove path (toggle off): returns { added: false } and STILL invokes updateTopicScore', async () => {
    // Toggling a reaction off is still an activity signal — the score
    // recalc must run.
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });
    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({ id: 'post-Y', topicId: 'topic-Y' } as never);
    vi.mocked(db.query.reactions.findFirst).mockResolvedValue({ emoji: '🔥' } as never);
    const { updateTopicScore } = await import('@/lib/topicScore');
    vi.mocked(updateTopicScore).mockClear();

    const res = await runRoute('post-Y', { emoji: '🔥' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: false });
    expect(updateTopicScore).toHaveBeenCalledWith('topic-Y');
  });

  it('still returns 200 even if updateTopicScore throws (fire-and-forget contract)', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });
    const { db } = await import('@/lib/db');
    vi.mocked(db.query.posts.findFirst).mockResolvedValue({ id: 'post-1', topicId: 'topic-1' } as never);
    vi.mocked(db.query.reactions.findFirst).mockResolvedValue(undefined);
    const { updateTopicScore } = await import('@/lib/topicScore');
    vi.mocked(updateTopicScore).mockRejectedValueOnce(new Error('boom'));

    const res = await runRoute('post-1', { emoji: '🔥' });
    expect(res.status).toBe(200);
  });
});
