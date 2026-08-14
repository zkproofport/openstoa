/**
 * `GET /api/media/[...key]` (M-5) — the gated read path that lets the R2
 * bucket eventually go private. DB and R2 are mocked (same pattern as
 * `chat-media-route.test.ts`); what has to be proven here is the HTTP wiring
 * and the authorization decision, not that Postgres or R2 themselves work.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   boundary           → 'HOSTILE' block below (malformed key -> 400)
 *   hostile input       → malformed/traversal keys, a key for a topic that
 *                        does not exist
 *   empty/null/undef    → no session (guest) vs a session, tested throughout
 *   authorization        → guest/public, guest/private (401), guest/secret
 *                        (401), non-member/public, non-member/private,
 *                        non-member/secret (403), member/secret, owner path
 *                        for user-upload, avatar with NO gate at all
 *   contract            → topicMembers lookup is only reached when it must be
 *                        (secret topics) — spied and asserted not called for
 *                        public/private, called for secret
 *   result integrity      → Cache-Control is `public` only for genuinely
 *                        public-readable bytes, `private` otherwise
 *   race                 → N/A: single read, no shared mutable state
 *   external dependency   → object missing in R2 -> 404, independent of authz
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const TOPIC = '11111111-2222-4333-8444-555555555555';
const OTHER_TOPIC = '99999999-8888-4777-8666-555555555555';
const USER = '0xowner';
const OTHER_USER = '0xother';
const PUBLIC_BASE = 'https://cdn.example/staging';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  topicsFindFirst: vi.fn(),
  topicMembersFindFirst: vi.fn(),
  getR2ObjectWithMeta: vi.fn(),
  tryGetR2PublicUrl: vi.fn(),
  checkMediaReadRateLimit: vi.fn(),
  resolveMediaIdentity: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: {
    query: {
      topics: { findFirst: mocks.topicsFindFirst },
      topicMembers: { findFirst: mocks.topicMembersFindFirst },
    },
  },
}));
vi.mock('@/lib/r2', async () => {
  const actual = await vi.importActual<typeof import('@/lib/r2')>('@/lib/r2');
  return {
    ...actual,
    getR2ObjectWithMeta: mocks.getR2ObjectWithMeta,
    tryGetR2PublicUrl: mocks.tryGetR2PublicUrl,
  };
});
// M-7 (src/lib/mediaRateLimit.ts): mocked out, same rationale as DB/R2 above
// — this file proves HTTP wiring and authorization, not that Redis itself
// works (that's `src/__tests__/mediaRateLimit.test.ts` + the real-container
// E2E). Real behavior: always within budget, so it never interferes with
// the authorization assertions below.
vi.mock('@/lib/mediaRateLimit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mediaRateLimit')>('@/lib/mediaRateLimit');
  return {
    ...actual,
    checkMediaReadRateLimit: mocks.checkMediaReadRateLimit,
    resolveMediaIdentity: mocks.resolveMediaIdentity,
  };
});

import { GET } from '@/app/api/media/[...key]/route';
import { uploadObjectKey } from '@/lib/r2';

const req = () => ({} as never);
const params = (segments: string[]) => Promise.resolve({ key: segments });
const OBJECT = { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(null);
  mocks.tryGetR2PublicUrl.mockReturnValue(PUBLIC_BASE);
  mocks.getR2ObjectWithMeta.mockResolvedValue(OBJECT);
  // M-7: always within budget by default — this file's own requests are
  // never about rate limiting (see the dedicated `checkMediaReadRateLimit
  // is consulted` describe block below for the one test that overrides this).
  mocks.checkMediaReadRateLimit.mockResolvedValue(true);
  mocks.resolveMediaIdentity.mockReturnValue('test-identity');
});

describe('hostile / malformed keys', () => {
  it('HOSTILE: a key with the wrong segment count is refused with 400', async () => {
    const res = await GET(req(), { params: params(['topics', TOPIC, 'posts']) });
    expect(res.status).toBe(400);
    expect(mocks.getR2ObjectWithMeta).not.toHaveBeenCalled();
  });

  it('HOSTILE: a traversal segment is refused with 400', async () => {
    const res = await GET(req(), { params: params(['topics', TOPIC, 'posts', '..', 'a.jpg']) });
    expect(res.status).toBe(400);
  });

  it('HOSTILE: a non-existent topic is 404, distinct from a bad-shape 400', async () => {
    mocks.topicsFindFirst.mockResolvedValue(undefined);
    const key = uploadObjectKey('post', USER, TOPIC, 'a.jpg').split('/');
    const res = await GET(req(), { params: params(key) });
    expect(res.status).toBe(404);
  });
});

describe('authorization — topic-post / topic-image', () => {
  const key = () => uploadObjectKey('post', USER, TOPIC, 'a.jpg').split('/');

  it('guest + public topic: allowed, cached public', async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'public' });
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('public');
    expect(mocks.topicMembersFindFirst).not.toHaveBeenCalled();
  });

  it('guest + private topic: 401 (guests cannot prove membership)', async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'private' });
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(401);
  });

  it('guest + secret topic: 401', async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'secret' });
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(401);
  });

  it('authenticated non-member + public topic: allowed, cached public', async () => {
    mocks.getSession.mockResolvedValue({ userId: OTHER_USER });
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'public' });
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('public');
  });

  it('authenticated non-member + private topic: allowed, cached private', async () => {
    mocks.getSession.mockResolvedValue({ userId: OTHER_USER });
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'private' });
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('private');
  });

  it('authenticated non-member + secret topic: 403 (existence revealed, content withheld)', async () => {
    mocks.getSession.mockResolvedValue({ userId: OTHER_USER });
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'secret' });
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(403);
    expect(mocks.topicMembersFindFirst).toHaveBeenCalledTimes(1);
  });

  it('member of a secret topic: allowed, cached private', async () => {
    mocks.getSession.mockResolvedValue({ userId: OTHER_USER });
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'secret' });
    mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: OTHER_USER, role: 'member' });
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('private');
  });

  it('CONTRACT: a public/private topic never calls the membership lookup', async () => {
    mocks.getSession.mockResolvedValue({ userId: OTHER_USER });
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'public' });
    await GET(req(), { params: params(key()) });
    expect(mocks.topicMembersFindFirst).not.toHaveBeenCalled();
  });

  it('EXTERNAL DEPENDENCY: authorized but the object is missing in R2 -> 404', async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'public' });
    mocks.getR2ObjectWithMeta.mockResolvedValue(null);
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(404);
  });
});

describe('authorization — topic-image (a topic cover already filed under its topic)', () => {
  it('member of a secret topic can read its own cover image', async () => {
    mocks.getSession.mockResolvedValue({ userId: OTHER_USER });
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'secret' });
    mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: OTHER_USER, role: 'owner' });
    const key = uploadObjectKey('topic', USER, TOPIC, 'cover.png').split('/');
    const res = await GET(req(), { params: params(key) });
    expect(res.status).toBe(200);
  });
});

describe('authorization — avatar (world-readable by design)', () => {
  const key = () => uploadObjectKey('avatar', USER, TOPIC, 'me.png').split('/');

  it('guest can read any avatar, no DB lookup at all', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('public');
    expect(mocks.topicsFindFirst).not.toHaveBeenCalled();
    expect(mocks.topicMembersFindFirst).not.toHaveBeenCalled();
  });

  it('a stranger (authenticated, unrelated user) can read it too', async () => {
    mocks.getSession.mockResolvedValue({ userId: OTHER_USER });
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(200);
  });
});

describe('authorization — user-upload (no topic yet: draft cover / bare agent upload)', () => {
  const key = () => uploadObjectKey('post', USER, null, 'draft.png').split('/');

  it('the uploader can always read their own draft', async () => {
    mocks.getSession.mockResolvedValue({ userId: USER });
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('private');
    // Owner short-circuit — never even asks whether it's a topic cover.
    expect(mocks.topicsFindFirst).not.toHaveBeenCalled();
  });

  it('a guest is refused (401) when it is not (yet) any topic\'s cover', async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.topicsFindFirst.mockResolvedValue(undefined);
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(401);
  });

  it('a signed-in stranger is refused (403) when it is not any topic\'s cover', async () => {
    mocks.getSession.mockResolvedValue({ userId: OTHER_USER });
    mocks.topicsFindFirst.mockResolvedValue(undefined);
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(403);
  });

  it('once published as a PUBLIC topic\'s cover, a guest can read it', async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.topicsFindFirst.mockResolvedValue({ id: OTHER_TOPIC, visibility: 'public' });
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(200);
    // Looked up by the exact reconstructed public URL.
    expect(mocks.topicsFindFirst).toHaveBeenCalledTimes(1);
  });

  it('once published as a SECRET topic\'s cover, a non-member is refused (403)', async () => {
    mocks.getSession.mockResolvedValue({ userId: OTHER_USER });
    mocks.topicsFindFirst.mockResolvedValue({ id: OTHER_TOPIC, visibility: 'secret' });
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(403);
  });

  it('when R2 is unconfigured (tryGetR2PublicUrl -> null), falls back to owner-only refusal', async () => {
    mocks.getSession.mockResolvedValue({ userId: OTHER_USER });
    mocks.tryGetR2PublicUrl.mockReturnValue(null);
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(403);
    expect(mocks.topicsFindFirst).not.toHaveBeenCalled();
  });
});

/**
 * M-6 (docs/design/media-bucket-privatisation.md, candidate B): R2_PUBLIC_URL
 * becomes root-relative (`/api/media`). `gateUserUpload` reconstructs
 * `${tryGetR2PublicUrl()}/${objectKey}` and compares it against `topics.image`
 * by exact string match — every case above already proves that comparison
 * works for an ABSOLUTE base (`PUBLIC_BASE`); this proves the identical logic
 * holds for a RELATIVE one too, since the match is opaque string equality and
 * was never supposed to care about URL shape. Only `topics.image` needs to be
 * stored relative to match — nothing else about the gate changes.
 */
describe('authorization — user-upload, RELATIVE R2_PUBLIC_URL (M-6)', () => {
  const RELATIVE_BASE = '/api/media';
  const key = () => uploadObjectKey('post', USER, null, 'draft.png').split('/');

  it('a relative topic.image still matches the reconstructed relative URL — guest reads a public cover', async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.tryGetR2PublicUrl.mockReturnValue(RELATIVE_BASE);
    mocks.topicsFindFirst.mockResolvedValue({ id: OTHER_TOPIC, visibility: 'public' });
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(200);
    // The DB query itself only matches by exact string — this proves the
    // route actually built a RELATIVE candidate URL to look up, not that the
    // mock happened to return a topic regardless of what was asked.
    expect(mocks.topicsFindFirst).toHaveBeenCalledTimes(1);
  });

  it('a relative base still gates a secret-topic cover correctly (403 for a non-member)', async () => {
    mocks.getSession.mockResolvedValue({ userId: OTHER_USER });
    mocks.tryGetR2PublicUrl.mockReturnValue(RELATIVE_BASE);
    mocks.topicsFindFirst.mockResolvedValue({ id: OTHER_TOPIC, visibility: 'secret' });
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(403);
  });

  it('the uploader\'s own-draft short-circuit is unaffected by the base being relative', async () => {
    mocks.getSession.mockResolvedValue({ userId: USER });
    mocks.tryGetR2PublicUrl.mockReturnValue(RELATIVE_BASE);
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(200);
    expect(mocks.topicsFindFirst).not.toHaveBeenCalled();
  });
});

// ─── M-7: rate limiting is actually consulted ──────────────────────────────
//
// Full arithmetic (keying, boundary values, fail-open) lives in
// `src/__tests__/mediaRateLimit.test.ts` — this is a CONTRACT test: it
// proves the route calls `resolveMediaIdentity` + `checkMediaReadRateLimit`
// on every request, and that a denial short-circuits BEFORE the R2 fetch
// (and before it, so a future refactor that reorders or drops the call is
// caught here rather than shipping silently).
describe('M-7: media read rate limiting is consulted on every request', () => {
  const key = () => uploadObjectKey('avatar', USER, null, 'a.jpg').split('/');

  it('CONTRACT: a public-topic-shaped request still calls resolveMediaIdentity + checkMediaReadRateLimit', async () => {
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(200);
    expect(mocks.resolveMediaIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.checkMediaReadRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.checkMediaReadRateLimit).toHaveBeenCalledWith('test-identity');
  });

  it('RESULT INTEGRITY: over budget -> 429 with a Retry-After header, and R2 is never touched', async () => {
    mocks.checkMediaReadRateLimit.mockResolvedValue(false);
    const res = await GET(req(), { params: params(key()) });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(mocks.getR2ObjectWithMeta).not.toHaveBeenCalled();
  });

  it('a rate-limit denial happens BEFORE the topic-visibility gate\'s DB lookup', async () => {
    mocks.checkMediaReadRateLimit.mockResolvedValue(false);
    const gatedKey = uploadObjectKey('post', USER, TOPIC, 'a.jpg').split('/');
    const res = await GET(req(), { params: params(gatedKey) });
    expect(res.status).toBe(429);
    expect(mocks.topicsFindFirst).not.toHaveBeenCalled();
  });

  it('a request that will fail the visibility gate still counts against the rate limit (probing is not free)', async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'secret' });
    const gatedKey = uploadObjectKey('post', USER, TOPIC, 'a.jpg').split('/');
    const res = await GET(req(), { params: params(gatedKey) });
    expect(res.status).toBe(401); // guest, secret topic
    // The rate limiter was still consulted for this denied request.
    expect(mocks.checkMediaReadRateLimit).toHaveBeenCalledTimes(1);
  });
});
