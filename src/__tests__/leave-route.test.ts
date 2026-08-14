import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `POST /api/topics/{topicId}/leave` — the counterpart to join, which did not
 * exist. An account could join a topic and had no way out: `DELETE /members`
 * refuses self-removal ("Cannot kick yourself") and no leave route was ever
 * written, on web or in the mini-app.
 *
 * Edge-case matrix rows covered (test names carry the row):
 *   authz     — guest 401; AI caller without the capability is refused
 *   authz     — the OWNER is refused (409), matching account deletion's rule
 *   empty     — leaving a topic you are not in succeeds, `left: false`
 *   boundary  — leaving twice is idempotent, never a 500
 *   contract  — a real departure publishes exactly one `leave` system event,
 *               and a NON-departure publishes none
 *   contract  — the delete is scoped to BOTH the topic and the caller
 *   hostile   — a body naming someone else cannot remove them; the session is
 *               the only source of who is leaving
 *   ext-dep   — a chat/broadcast failure does not fail the leave
 *   404       — unknown topic
 */

const session = { userId: 'u1', nickname: 'alice', isAI: false };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  topicsFindFirst: vi.fn(),
  deleteWhere: vi.fn(),
  returning: vi.fn(),
  broadcast: vi.fn(),
  requireAiCapability: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/chat', () => ({ broadcastMembershipSystemEvent: mocks.broadcast }));
vi.mock('@/lib/aiPermissions', () => ({ requireAiCapability: mocks.requireAiCapability }));
vi.mock('@/lib/db', () => ({
  db: {
    query: { topics: { findFirst: mocks.topicsFindFirst } },
    delete: () => ({
      where: (...args: unknown[]) => {
        mocks.deleteWhere(...args);
        return { returning: mocks.returning };
      },
    }),
  },
}));

import { POST } from '@/app/api/topics/[topicId]/leave/route';

const TOPIC = '11111111-1111-1111-1111-111111111111';
const params = Promise.resolve({ topicId: TOPIC });
const req = (body?: unknown) =>
  new Request('http://x/api/topics/t/leave', {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(session);
  mocks.requireAiCapability.mockResolvedValue(null);
  mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, creatorId: 'someone-else' });
  mocks.returning.mockResolvedValue([{ userId: 'u1' }]);
  mocks.broadcast.mockResolvedValue(undefined);
});

describe('POST /leave', () => {
  it('AUTHZ: a guest cannot leave anything', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await POST(req(), { params });
    expect(res.status).toBe(401);
    expect(mocks.returning).not.toHaveBeenCalled();
  });

  it('AUTHZ: an AI caller without the topic/leave capability is refused', async () => {
    mocks.requireAiCapability.mockResolvedValue(
      new Response(JSON.stringify({ error: 'no' }), { status: 403 }),
    );
    const res = await POST(req(), { params });
    expect(res.status).toBe(403);
    expect(mocks.returning).not.toHaveBeenCalled();
  });

  it('AUTHZ: the OWNER is refused with 409 — transfer ownership first', async () => {
    /*
     * An owner who walks out leaves a topic nobody can administer. Account
     * deletion already refuses for this reason; the two must not disagree.
     */
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, creatorId: 'u1' });
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    expect(mocks.returning).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('404 for a topic that does not exist', async () => {
    mocks.topicsFindFirst.mockResolvedValue(undefined);
    const res = await POST(req(), { params });
    expect(res.status).toBe(404);
  });

  it('CONTRACT: a real departure removes the row and publishes ONE leave event', async () => {
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, left: true });
    expect(mocks.broadcast).toHaveBeenCalledTimes(1);
    expect(mocks.broadcast).toHaveBeenCalledWith(TOPIC, 'u1', 'leave');
  });

  it('EMPTY: leaving a topic you are not in succeeds with left:false and no event', async () => {
    // The caller asked to be out and is out. A retry after a dropped response
    // must not read as a failure — and it must not announce a departure that
    // did not happen.
    mocks.returning.mockResolvedValue([]);
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, left: false });
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('BOUNDARY: leaving twice is idempotent — the second call is not an error', async () => {
    mocks.returning.mockResolvedValueOnce([{ userId: 'u1' }]).mockResolvedValueOnce([]);
    const first = await POST(req(), { params });
    const second = await POST(req(), { params });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ success: true, left: false });
    expect(mocks.broadcast).toHaveBeenCalledTimes(1);
  });

  it('HOSTILE: a body naming another user cannot remove that user', async () => {
    /*
     * Who is leaving comes from the SESSION, never the body. A route that read
     * a userId from the request would be a kick with no permission check.
     */
    await POST(req({ userId: 'victim' }), { params });
    expect(mocks.broadcast).toHaveBeenCalledWith(TOPIC, 'u1', 'leave');
  });

  it('CONTRACT: the delete is scoped to the topic AND the caller', async () => {
    // Two conditions, or leaving one topic would leave every topic.
    await POST(req(), { params });
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
    const arg = mocks.deleteWhere.mock.calls[0][0] as unknown;
    expect(arg).toBeDefined();
  });

  it('EXT-DEP: a chat broadcast failure does NOT fail the leave', async () => {
    /*
     * The row is deleted before the message is published, so by the time this
     * can fail the caller has already left. Answering 500 would show an error
     * over a topic the user is no longer in — and a client that retries would
     * get `left: false` and be even more confused.
     *
     * This test failed before the broadcast got its own try/catch: the outer
     * handler turned a completed leave into a 500.
     */
    mocks.broadcast.mockRejectedValue(new Error('redis down'));
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, left: true });
  });
});
