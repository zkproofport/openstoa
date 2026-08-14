import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * `GET /api/topics/[topicId]/chat/subscribe` is SSE (Content-Type
 * `text/event-stream`), unlike every other guarded route which returns
 * JSON. The team lead's concern: does the malformed-topicId guard actually
 * deliver an HTTP 400 status, or does it get swallowed into a stream the
 * client reads as "connected, no events"?
 *
 * Answer, proven structurally here rather than merely read from the source:
 * the guard is a plain early `return new Response(...)` BEFORE the
 * `ReadableStream` is ever constructed (see route.ts — the stream is built
 * only after the membership check that follows). A route handler's return
 * value IS the HTTP response Next.js sends; short-circuiting before the
 * stream means there is no stream at all for this path, structurally, not
 * merely "the client won't see events" — an EventSource client seeing a
 * non-200 / non-`text/event-stream` initial response is defined by spec to
 * fire an error, not to sit "connected" forever.
 */
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/db', () => ({
  db: { query: { topicMembers: { findFirst: vi.fn() }, users: { findFirst: vi.fn() } } },
}));
vi.mock('@/lib/redis', () => ({ getRedis: vi.fn() }));
vi.mock('ioredis', () => ({ default: vi.fn() }));

function req(topicId: string) {
  return new NextRequest(`http://localhost:3200/api/topics/${topicId}/chat/subscribe`);
}

describe('GET /api/topics/[topicId]/chat/subscribe — malformed-id guard delivers a real HTTP status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ userId: 'user-1', nickname: 'alice' });
  });

  it('a malformed topicId returns a plain Response, status 400, application/json — never text/event-stream', async () => {
    const { GET } = await import('@/app/api/topics/[topicId]/chat/subscribe/route');

    const res = await GET(req('not-a-uuid'), { params: Promise.resolve({ topicId: 'not-a-uuid' }) });

    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Content-Type')).not.toContain('text/event-stream');
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid topicId' });
    // A real Response body is a one-shot ReadableStream under the hood in the
    // fetch spec, but `.json()` resolving (rather than hanging) proves this
    // is a normal, complete HTTP response — not chat/subscribe's own SSE
    // ReadableStream, which never resolves .json() and stays open.
  });

  it('control: an unauthenticated request still gets its existing 401 (guard placement does not change that)', async () => {
    mocks.getSession.mockResolvedValue(null);
    const { GET } = await import('@/app/api/topics/[topicId]/chat/subscribe/route');

    const res = await GET(req('not-a-uuid'), { params: Promise.resolve({ topicId: 'not-a-uuid' }) });
    // Auth is checked BEFORE the format guard in this file, so an unauthenticated
    // caller sees 401 regardless of id shape — documented deliberately in the
    // sweep report, not an accident of insertion order.
    expect(res.status).toBe(401);
  });
});
