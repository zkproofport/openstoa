/**
 * Push preference HTTP-contract tests — `GET/PATCH /api/push/preferences`
 * (global switch, P-M) and `GET/PATCH /api/topics/{topicId}/push` (per-topic
 * mute, P-S). Mirrors apiKeys-routes.test.ts: `@/lib/session`, `@/lib/redis`
 * and the DB-touching half of `@/lib/pushPrefs` are mocked so this file
 * isolates the HTTP layer; the SQL itself is exercised for real against a local
 * Postgres in pushPrefs.test.ts.
 *
 * Edge-case matrix rows covered here:
 *   authz        — unauthenticated (401), authenticated non-member (403),
 *                  member (200), unknown topic (404)
 *   empty/null   — missing body, non-object body, missing field, null field
 *   hostile      — wildcard / SQL-shape / HTML / control-char / UTF-8 topicId
 *   large        — 100 KB topicId rejected with 400, never reaching the DB
 *   boundary     — 35/36/37-char topic ids
 *   idempotency  — repeated PATCH returns changed=false
 *   integrity    — `willNotify` is `globalEnabled && !muted` in every combination
 *   contract     — the routes actually call the preference helpers (spies), so
 *                  deleting a call is caught
 *   rate limit   — 429 when the limiter says no
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  incr: vi.fn().mockResolvedValue(1),
  expire: vi.fn(),
  topicsFindFirst: vi.fn(),
  topicMembersFindFirst: vi.fn(),
  getPushPreferences: vi.fn(),
  setGlobalPushEnabled: vi.fn(),
  listMutedTopicIds: vi.fn(),
  getGlobalPushEnabled: vi.fn(),
  isTopicMuted: vi.fn(),
  setTopicMuted: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/redis', () => ({
  getRedis: () => ({ incr: mocks.incr, expire: mocks.expire }),
}));
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
// Keep `isUuid` + `PushPrefsValidationError` REAL — the routes' input guard is
// what is under test here; only the DB-touching helpers are faked.
vi.mock('@/lib/pushPrefs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pushPrefs')>();
  return {
    ...actual,
    getPushPreferences: mocks.getPushPreferences,
    setGlobalPushEnabled: mocks.setGlobalPushEnabled,
    listMutedTopicIds: mocks.listMutedTopicIds,
    getGlobalPushEnabled: mocks.getGlobalPushEnabled,
    isTopicMuted: mocks.isTopicMuted,
    setTopicMuted: mocks.setTopicMuted,
  };
});

import { GET as prefsGET, PATCH as prefsPATCH } from '@/app/api/push/preferences/route';
import { GET as topicGET, PATCH as topicPATCH } from '@/app/api/topics/[topicId]/push/route';

const USER = 'user-nullifier-1';
const TOPIC = '11111111-2222-4333-8444-555555555555';
const SESSION = { userId: USER, nickname: 'alice', verifiedAt: Date.now() };

function req(url: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3200${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

/** PATCH with a raw (possibly malformed) body string. */
function rawReq(url: string, method: string, raw: string): NextRequest {
  return new NextRequest(`http://localhost:3200${url}`, {
    method,
    body: raw,
    headers: { 'Content-Type': 'application/json' },
  });
}

const topicParams = (topicId: string) => ({ params: Promise.resolve({ topicId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.incr.mockResolvedValue(1);
  mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC });
  mocks.topicMembersFindFirst.mockResolvedValue({ userId: USER });
  mocks.getPushPreferences.mockResolvedValue({ enabled: true, mutedTopicIds: [] });
  mocks.setGlobalPushEnabled.mockImplementation(async (_db, _u, enabled: boolean) => enabled);
  mocks.listMutedTopicIds.mockResolvedValue([]);
  mocks.getGlobalPushEnabled.mockResolvedValue(true);
  mocks.isTopicMuted.mockResolvedValue(false);
  mocks.setTopicMuted.mockImplementation(async (_db, _u, _t, muted: boolean) => ({
    muted,
    changed: true,
  }));
});

// ---------------------------------------------------------------------------
// GET /api/push/preferences
// ---------------------------------------------------------------------------

describe('GET /api/push/preferences', () => {
  it('401 when not authenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await prefsGET(req('/api/push/preferences'));
    expect(res.status).toBe(401);
    expect(mocks.getPushPreferences).not.toHaveBeenCalled();
  });

  it('returns the permissive defaults for a user with no rows', async () => {
    const res = await prefsGET(req('/api/push/preferences'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, mutedTopicIds: [] });
  });

  it('CONTRACT: reads preferences scoped to the SESSION user (no user parameter)', async () => {
    await prefsGET(req('/api/push/preferences'));
    expect(mocks.getPushPreferences).toHaveBeenCalledTimes(1);
    expect(mocks.getPushPreferences.mock.calls[0][1]).toBe(USER);
  });

  it('429 when the rate limiter is exhausted', async () => {
    mocks.incr.mockResolvedValue(61);
    const res = await prefsGET(req('/api/push/preferences'));
    expect(res.status).toBe(429);
    expect(mocks.getPushPreferences).not.toHaveBeenCalled();
  });

  it('500 with a message when the store throws (no unhandled rejection)', async () => {
    mocks.getPushPreferences.mockRejectedValue(new Error('db down'));
    const res = await prefsGET(req('/api/push/preferences'));
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/push/preferences
// ---------------------------------------------------------------------------

describe('PATCH /api/push/preferences', () => {
  it('401 when not authenticated — and never writes', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await prefsPATCH(req('/api/push/preferences', 'PATCH', { enabled: false }));
    expect(res.status).toBe(401);
    expect(mocks.setGlobalPushEnabled).not.toHaveBeenCalled();
  });

  it('turns the global switch off and echoes the STORED value', async () => {
    const res = await prefsPATCH(req('/api/push/preferences', 'PATCH', { enabled: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, mutedTopicIds: [] });
    expect(mocks.setGlobalPushEnabled).toHaveBeenCalledWith(expect.anything(), USER, false);
  });

  it('preserves per-topic mutes across a global toggle', async () => {
    mocks.listMutedTopicIds.mockResolvedValue([TOPIC]);
    const res = await prefsPATCH(req('/api/push/preferences', 'PATCH', { enabled: true }));
    expect(await res.json()).toEqual({ enabled: true, mutedTopicIds: [TOPIC] });
  });

  it('reports the DB value, not the requested one', async () => {
    mocks.setGlobalPushEnabled.mockResolvedValue(true); // DB refused the change
    const res = await prefsPATCH(req('/api/push/preferences', 'PATCH', { enabled: false }));
    expect((await res.json()).enabled).toBe(true);
  });

  it('400 for a missing body', async () => {
    const res = await prefsPATCH(req('/api/push/preferences', 'PATCH'));
    expect(res.status).toBe(400);
    expect(mocks.setGlobalPushEnabled).not.toHaveBeenCalled();
  });

  it('400 for malformed JSON', async () => {
    const res = await prefsPATCH(rawReq('/api/push/preferences', 'PATCH', '{not json'));
    expect(res.status).toBe(400);
  });

  it('400 for a JSON body that is not an object', async () => {
    for (const raw of ['"enabled"', '42', 'null', '[]']) {
      const res = await prefsPATCH(rawReq('/api/push/preferences', 'PATCH', raw));
      expect([400]).toContain(res.status);
    }
    expect(mocks.setGlobalPushEnabled).not.toHaveBeenCalled();
  });

  it('400 for a missing / null / undefined `enabled` — as SEPARATE cases', async () => {
    for (const body of [{}, { enabled: null }, { enabled: undefined }, { other: true }]) {
      const res = await prefsPATCH(req('/api/push/preferences', 'PATCH', body));
      expect(res.status).toBe(400);
    }
    expect(mocks.setGlobalPushEnabled).not.toHaveBeenCalled();
  });

  it('400 for a truthy/falsy NON-boolean — "false", 0, 1, "" are never coerced', async () => {
    for (const enabled of ['false', 'true', 0, 1, '', ' ', [], {}, 'off']) {
      const res = await prefsPATCH(req('/api/push/preferences', 'PATCH', { enabled }));
      expect(res.status).toBe(400);
    }
    expect(mocks.setGlobalPushEnabled).not.toHaveBeenCalled();
  });

  it('400 for a very large `enabled` payload (still not a boolean)', async () => {
    const res = await prefsPATCH(
      req('/api/push/preferences', 'PATCH', { enabled: 'x'.repeat(100_000) }),
    );
    expect(res.status).toBe(400);
  });

  it('is idempotent at the HTTP layer — same request twice, same response', async () => {
    const a = await prefsPATCH(req('/api/push/preferences', 'PATCH', { enabled: false }));
    const b = await prefsPATCH(req('/api/push/preferences', 'PATCH', { enabled: false }));
    expect(await a.json()).toEqual(await b.json());
  });

  it('429 when the rate limiter is exhausted — and never writes', async () => {
    mocks.incr.mockResolvedValue(61);
    const res = await prefsPATCH(req('/api/push/preferences', 'PATCH', { enabled: false }));
    expect(res.status).toBe(429);
    expect(mocks.setGlobalPushEnabled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/topics/{topicId}/push
// ---------------------------------------------------------------------------

describe('GET /api/topics/{topicId}/push', () => {
  it('401 when not authenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await topicGET(req(`/api/topics/${TOPIC}/push`), topicParams(TOPIC));
    expect(res.status).toBe(401);
  });

  it('403 for an authenticated NON-member', async () => {
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    const res = await topicGET(req(`/api/topics/${TOPIC}/push`), topicParams(TOPIC));
    expect(res.status).toBe(403);
    expect(mocks.isTopicMuted).not.toHaveBeenCalled();
  });

  it('404 for a well-formed uuid that is not a topic', async () => {
    mocks.topicsFindFirst.mockResolvedValue(undefined);
    const res = await topicGET(req(`/api/topics/${TOPIC}/push`), topicParams(TOPIC));
    expect(res.status).toBe(404);
    expect(mocks.topicMembersFindFirst).not.toHaveBeenCalled();
  });

  it('200 with the resolved state for a member', async () => {
    const res = await topicGET(req(`/api/topics/${TOPIC}/push`), topicParams(TOPIC));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      topicId: TOPIC,
      muted: false,
      globalEnabled: true,
      willNotify: true,
    });
  });

  it('INTEGRITY: willNotify === globalEnabled && !muted in all four combinations', async () => {
    for (const globalEnabled of [true, false]) {
      for (const muted of [true, false]) {
        mocks.getGlobalPushEnabled.mockResolvedValue(globalEnabled);
        mocks.isTopicMuted.mockResolvedValue(muted);
        const res = await topicGET(req(`/api/topics/${TOPIC}/push`), topicParams(TOPIC));
        expect(await res.json()).toEqual({
          topicId: TOPIC,
          muted,
          globalEnabled,
          willNotify: globalEnabled && !muted,
        });
      }
    }
  });

  it('400 for hostile / empty / non-uuid topic ids — before ANY db query', async () => {
    for (const bad of [
      '',
      '   ',
      '%',
      '_',
      '\\',
      `' OR '1'='1`,
      `'; DROP TABLE push_topic_mutes; --`,
      '<script>alert(1)</script>',
      '한국어토픽',
      '🔥',
      'null',
      'undefined',
      '00000000-0000-4000-8000-00000000000',   // 35 chars (max-1)
      TOPIC + 'a',                              // 37 chars (max+1)
    ]) {
      const res = await topicGET(req(`/api/topics/x/push`), topicParams(bad));
      expect(res.status).toBe(400);
    }
    expect(mocks.topicsFindFirst).not.toHaveBeenCalled();
    expect(mocks.isTopicMuted).not.toHaveBeenCalled();
  });

  it('400 for a 100 KB topicId without touching the database', async () => {
    const res = await topicGET(req('/api/topics/x/push'), topicParams('a'.repeat(100_000)));
    expect(res.status).toBe(400);
    expect(mocks.topicsFindFirst).not.toHaveBeenCalled();
  });

  it('429 when the rate limiter is exhausted', async () => {
    mocks.incr.mockResolvedValue(61);
    const res = await topicGET(req(`/api/topics/${TOPIC}/push`), topicParams(TOPIC));
    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/topics/{topicId}/push
// ---------------------------------------------------------------------------

describe('PATCH /api/topics/{topicId}/push', () => {
  const patch = (body: unknown, topicId = TOPIC) =>
    topicPATCH(req(`/api/topics/${topicId}/push`, 'PATCH', body), topicParams(topicId));

  it('401 when not authenticated — and never writes', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await patch({ muted: true });
    expect(res.status).toBe(401);
    expect(mocks.setTopicMuted).not.toHaveBeenCalled();
  });

  it('403 for an authenticated non-member — and never writes', async () => {
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    const res = await patch({ muted: true });
    expect(res.status).toBe(403);
    expect(mocks.setTopicMuted).not.toHaveBeenCalled();
  });

  it('404 for a non-existent topic — and never writes', async () => {
    mocks.topicsFindFirst.mockResolvedValue(undefined);
    const res = await patch({ muted: true });
    expect(res.status).toBe(404);
    expect(mocks.setTopicMuted).not.toHaveBeenCalled();
  });

  it('mutes for a member and returns the resolved state', async () => {
    const res = await patch({ muted: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      topicId: TOPIC,
      muted: true,
      changed: true,
      globalEnabled: true,
      willNotify: false,
    });
  });

  it('CONTRACT: the write is scoped to the session user and the path topic', async () => {
    await patch({ muted: true });
    expect(mocks.setTopicMuted).toHaveBeenCalledTimes(1);
    const [, userId, topicId, muted] = mocks.setTopicMuted.mock.calls[0];
    expect(userId).toBe(USER);
    expect(topicId).toBe(TOPIC);
    expect(muted).toBe(true);
  });

  it('IDEMPOTENCY: a redundant mute reports changed=false and still 200', async () => {
    mocks.setTopicMuted.mockResolvedValue({ muted: true, changed: false });
    const res = await patch({ muted: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ muted: true, changed: false });
  });

  it('IDEMPOTENCY: a redundant unmute reports changed=false and still 200', async () => {
    mocks.setTopicMuted.mockResolvedValue({ muted: false, changed: false });
    const res = await patch({ muted: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ muted: false, changed: false });
  });

  it('INTEGRITY: un-muting while globally OFF still reports willNotify=false', async () => {
    mocks.getGlobalPushEnabled.mockResolvedValue(false);
    mocks.setTopicMuted.mockResolvedValue({ muted: false, changed: true });
    const res = await patch({ muted: false });
    expect(await res.json()).toMatchObject({
      muted: false,
      globalEnabled: false,
      willNotify: false,
    });
  });

  it('400 for a missing / null / non-boolean `muted` — and never writes', async () => {
    for (const body of [{}, { muted: null }, { muted: 'true' }, { muted: 0 }, { muted: 1 }, { muted: [] }]) {
      const res = await patch(body);
      expect(res.status).toBe(400);
    }
    expect(mocks.setTopicMuted).not.toHaveBeenCalled();
  });

  it('400 for malformed JSON', async () => {
    const res = await topicPATCH(
      rawReq(`/api/topics/${TOPIC}/push`, 'PATCH', '{"muted": tru'),
      topicParams(TOPIC),
    );
    expect(res.status).toBe(400);
  });

  it('400 for hostile / oversized topic ids — before ANY db query or write', async () => {
    for (const bad of ['', '  ', '%', `'; DROP TABLE topics; --`, '<img src=x>', '🔥', 'a'.repeat(100_000)]) {
      const res = await patch({ muted: true }, bad);
      expect(res.status).toBe(400);
    }
    expect(mocks.topicsFindFirst).not.toHaveBeenCalled();
    expect(mocks.setTopicMuted).not.toHaveBeenCalled();
  });

  it('400 (not 500) when the store rejects the id as invalid', async () => {
    const { PushPrefsValidationError } = await import('@/lib/pushPrefs');
    mocks.setTopicMuted.mockRejectedValue(new PushPrefsValidationError('topicId must be a UUID'));
    const res = await patch({ muted: true });
    expect(res.status).toBe(400);
  });

  it('500 for an unexpected store failure', async () => {
    mocks.setTopicMuted.mockRejectedValue(new Error('connection terminated'));
    const res = await patch({ muted: true });
    expect(res.status).toBe(500);
  });

  it('429 when the rate limiter is exhausted — and never writes', async () => {
    mocks.incr.mockResolvedValue(61);
    const res = await patch({ muted: true });
    expect(res.status).toBe(429);
    expect(mocks.setTopicMuted).not.toHaveBeenCalled();
  });
});
