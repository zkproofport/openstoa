import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * AI capability = API-key scope ONLY (design §7, consolidated onto API keys
 * 2026-07-30). The old account-wide `ai_permissions` grant has been retired:
 *
 *   1. `requireAiCapability` (`src/lib/aiPermissions.ts`) — fail-closed, reads
 *      ONLY `session.apiKeyCmd`. An isAI session with no key scope is denied,
 *      never a fallback to an account-wide grant (there isn't one any more).
 *   2. `GET/PUT /api/profile/ai-permissions` — retired to 410 on every call
 *      (still 401 first if unauthenticated). Nothing reads `ai_permissions`
 *      for authorization any more.
 *   3. Route wiring — the isAI-capability gate is still called on every
 *      guarded route with the right cmd (contract test, `requireAiCapability`
 *      mocked here so we isolate the HTTP layer).
 *
 * Per-key scope creation/edit/revoke is covered in apiKeys.test.ts (db layer)
 * and apiKeys-routes.test.ts (HTTP layer + the requireAiCapability
 * apiKeyCmd short-circuit against a real guarded route).
 */

// ───────────────────────────────────────────────────────────────────────────
// Shared mocks
// ───────────────────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  incr: vi.fn().mockResolvedValue(1),
  expire: vi.fn(),
  publish: vi.fn().mockResolvedValue(1),
  topicMembersFindFirst: vi.fn(),
  usersFindFirst: vi.fn(),
  postsFindFirst: vi.fn(),
  topicsFindFirst: vi.fn(),
  insertReturning: vi.fn(),
  // aiPermissions module mock (route-wiring layer only)
  requireAiCapability: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/redis', () => ({
  getRedis: () => ({ incr: mocks.incr, expire: mocks.expire, publish: mocks.publish }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/push', () => ({
  dispatchDummyForMessage: vi.fn().mockResolvedValue(undefined),
  dispatchCiphertextForMessage: vi.fn().mockResolvedValue(undefined),
  getPushProvider: () => null,
  getPushMode: () => 'content-free',
}));
// Deliberately NO `aiPermissions` entry in `db.query` — proves the real gate
// never touches the db at all any more (see section 1 below).
vi.mock('@/lib/db', () => ({
  db: {
    query: {
      topicMembers: { findFirst: mocks.topicMembersFindFirst },
      users: { findFirst: mocks.usersFindFirst },
      posts: { findFirst: mocks.postsFindFirst },
      topics: { findFirst: mocks.topicsFindFirst },
    },
    insert: () => ({ values: () => ({ returning: mocks.insertReturning }) }),
  },
}));

// ───────────────────────────────────────────────────────────────────────────
// 1. REAL requireAiCapability gate — fail-closed, key-only (db mocked above
//    WITHOUT an aiPermissions query, so any lingering db fallback would throw)
// ───────────────────────────────────────────────────────────────────────────
describe('requireAiCapability — the real gate (authz / hostile / fail-closed)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('non-AI session passes with NO capability lookup (humans unaffected)', async () => {
    const real = await vi.importActual<typeof import('@/lib/aiPermissions')>('@/lib/aiPermissions');
    const { db } = await import('@/lib/db');
    const res = await real.requireAiCapability(db as never, { userId: 'human', isAI: false }, '/openstoa/chat/send');
    expect(res).toBeNull();
  });

  it('isAI session WITH the cmd in apiKeyCmd passes (null)', async () => {
    const real = await vi.importActual<typeof import('@/lib/aiPermissions')>('@/lib/aiPermissions');
    const { db } = await import('@/lib/db');
    const res = await real.requireAiCapability(db as never, { userId: 'bot', isAI: true, apiKeyCmd: ['/openstoa/chat/send'] }, '/openstoa/chat/send');
    expect(res).toBeNull();
  });

  it('isAI session WITHOUT the cmd in apiKeyCmd → 403', async () => {
    const real = await vi.importActual<typeof import('@/lib/aiPermissions')>('@/lib/aiPermissions');
    const { db } = await import('@/lib/db');
    const res = await real.requireAiCapability(db as never, { userId: 'bot', isAI: true, apiKeyCmd: ['/openstoa/post/read'] }, '/openstoa/chat/send');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('isAI session with an EMPTY apiKeyCmd → 403 (safe default, no silent allow)', async () => {
    const real = await vi.importActual<typeof import('@/lib/aiPermissions')>('@/lib/aiPermissions');
    const { db } = await import('@/lib/db');
    const res = await real.requireAiCapability(db as never, { userId: 'bot', isAI: true, apiKeyCmd: [] }, '/openstoa/topic/join');
    expect(res!.status).toBe(403);
  });

  it('FAIL-CLOSED: isAI session with NO apiKeyCmd at ALL (bare JWT, no API key) → 403, never an implicit allow', async () => {
    // This is the exact shape of a dev-login or verify/ai JWT session — isAI
    // true, but no apiKeyId/apiKeyCmd because it never went through an API
    // key. Must be denied outright; there is no account-wide grant to fall
    // back to any more.
    const real = await vi.importActual<typeof import('@/lib/aiPermissions')>('@/lib/aiPermissions');
    const { db } = await import('@/lib/db');
    const res = await real.requireAiCapability(db as never, { userId: 'bot', isAI: true }, '/openstoa/topic/join');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('the gate never touches the db (no ai_permissions lookup exists any more)', async () => {
    // db.query in the mock above has no `aiPermissions` key at all — if the
    // gate still tried `db.query.aiPermissions.findFirst(...)` this would
    // throw "Cannot read properties of undefined" instead of resolving.
    const real = await vi.importActual<typeof import('@/lib/aiPermissions')>('@/lib/aiPermissions');
    const { db } = await import('@/lib/db');
    await expect(real.requireAiCapability(db as never, { userId: 'bot', isAI: true }, '/openstoa/chat/send')).resolves.not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Retired /api/profile/ai-permissions — always 410 (401 first if unauthed)
// ───────────────────────────────────────────────────────────────────────────
import { GET as aiPermsGET, PUT as aiPermsPUT } from '@/app/api/profile/ai-permissions/route';

const req = (body: unknown, query = '') =>
  ({ json: async () => body, url: `http://x/api/x${query}`, cookies: { get: () => undefined }, headers: { get: () => null } }) as never;

const human = { userId: 'human1', nickname: 'h', isAI: false };

describe('GET /api/profile/ai-permissions — retired', () => {
  beforeEach(() => vi.clearAllMocks());
  it('401 when unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await aiPermsGET(req(null));
    expect(res.status).toBe(401);
  });
  it('410 for an authenticated caller — endpoint is retired, never returns a live config', async () => {
    mocks.getSession.mockResolvedValue(human);
    const res = await aiPermsGET(req(null));
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.migrateTo).toBeDefined();
  });
});

describe('PUT /api/profile/ai-permissions — retired', () => {
  beforeEach(() => vi.clearAllMocks());
  it('401 when unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await aiPermsPUT(req({ cmd: [], historyGrant: 'none' }));
    expect(res.status).toBe(401);
  });
  it('410 for an authenticated caller — writes are rejected, not silently accepted (would be misleading)', async () => {
    mocks.getSession.mockResolvedValue(human);
    const res = await aiPermsPUT(req({ cmd: ['/openstoa/chat/send'], historyGrant: 'full' }));
    expect(res.status).toBe(410);
  });
  it('410 even for a hostile/garbage body — the route never parses cmd/historyGrant any more', async () => {
    mocks.getSession.mockResolvedValue(human);
    const res = await aiPermsPUT(req({ cmd: ['/root/delete'], historyGrant: 'DROP TABLE users;--' }));
    expect(res.status).toBe(410);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Route wiring (aiPermissions module mocked — HTTP contract only)
// ───────────────────────────────────────────────────────────────────────────
vi.mock('@/lib/aiPermissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aiPermissions')>();
  return {
    ...actual,
    requireAiCapability: mocks.requireAiCapability,
  };
});

import { NextResponse } from 'next/server';
import { POST as chatPOST, GET as chatGET } from '@/app/api/topics/[topicId]/chat/route';
import { GET as archiveGET } from '@/app/api/topics/[topicId]/archive/route';
import { GET as takGET } from '@/app/api/topics/[topicId]/tak/bundles/route';
import { POST as joinPOST } from '@/app/api/topics/[topicId]/join/route';
import { DELETE as membersDELETE } from '@/app/api/topics/[topicId]/members/route';
import { POST as postsPOST } from '@/app/api/topics/[topicId]/posts/route';
import { PATCH as postPATCH, DELETE as postDELETE } from '@/app/api/posts/[postId]/route';
import { POST as commentsPOST } from '@/app/api/posts/[postId]/comments/route';
import { PUT as nicknamePUT } from '@/app/api/profile/nickname/route';

const TOPIC = '00000000-0000-0000-0000-000000000001';
const POST = '00000000-0000-0000-0000-0000000000bb';
const tParams = () => Promise.resolve({ topicId: TOPIC });
const pParams = () => Promise.resolve({ postId: POST });
const b64 = (s: string) => Buffer.from(s).toString('base64');

const ai = { userId: 'bot1', nickname: 'b', isAI: true, apiKeyId: 'k1', apiKeyCmd: ['/openstoa/chat/send'] };
const FORBIDDEN = () => NextResponse.json({ error: 'AI capability required' }, { status: 403 });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.incr.mockResolvedValue(1);
  // Default: gate allows (returns null). Individual tests override to 403.
  mocks.requireAiCapability.mockResolvedValue(null);
});

describe('isAI capability gate is wired on every guarded route (contract)', () => {
  beforeEach(() => {
    mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: 'x', role: 'member' });
    mocks.usersFindFirst.mockResolvedValue({ id: 'x', nickname: 'n', profileImage: null });
    mocks.postsFindFirst.mockResolvedValue({ id: POST, topicId: TOPIC });
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'public', proofType: 'none' });
    mocks.insertReturning.mockResolvedValue([
      { id: 'm1', topicId: TOPIC, userId: 'bot1', ciphertext: Buffer.from('c'), epoch: 0, takVersion: null, type: 'message', isAI: true, createdAt: new Date() },
    ]);
    mocks.getSession.mockResolvedValue(ai);
  });

  const cases: Array<[string, () => Promise<Response>, string]> = [
    ['chat POST → chat/send', () => chatPOST(req({ ciphertext: b64('c'), epoch: 0 }), { params: tParams() }), '/openstoa/chat/send'],
    ['chat GET → chat/read', () => chatGET(req(null), { params: tParams() }), '/openstoa/chat/read'],
    ['archive GET → chat/read', () => archiveGET(req(null), { params: tParams() }), '/openstoa/chat/read'],
    ['tak GET → chat/read', () => takGET(req(null, '?deviceId=d1'), { params: tParams() }), '/openstoa/chat/read'],
    ['join POST → topic/join', () => joinPOST(req({}), { params: tParams() }), '/openstoa/topic/join'],
    ['members DELETE → topic/leave', () => membersDELETE(req({ userId: 'other' }), { params: tParams() }), '/openstoa/topic/leave'],
    ['posts POST → post/write', () => postsPOST(req({ title: 't', content: 'c' }), { params: tParams() }), '/openstoa/post/write'],
    ['post PATCH → post/write', () => postPATCH(req({ title: 't' }), { params: pParams() }), '/openstoa/post/write'],
    ['post DELETE → post/delete', () => postDELETE(req(null), { params: pParams() }), '/openstoa/post/delete'],
    ['comments POST → comment/write', () => commentsPOST(req({ content: 'c' }), { params: pParams() }), '/openstoa/comment/write'],
    ['nickname PUT → profile/edit', () => nicknamePUT(req({ nickname: 'newname' })), '/openstoa/profile/edit'],
  ];

  for (const [label, call, cmd] of cases) {
    it(`403 when the gate blocks the AI caller — ${label}`, async () => {
      mocks.requireAiCapability.mockResolvedValue(FORBIDDEN());
      const res = await call();
      expect(res.status).toBe(403);
      // Contract: the route asked the gate for exactly this cmd.
      expect(mocks.requireAiCapability).toHaveBeenCalledWith(expect.anything(), ai, cmd);
    });
  }

  it('chat POST proceeds (201) when the gate allows the AI caller', async () => {
    mocks.requireAiCapability.mockResolvedValue(null);
    const res = await chatPOST(req({ ciphertext: b64('c'), epoch: 0 }), { params: tParams() });
    expect(res.status).toBe(201);
  });

  it('humans still flow through the gate helper, which no-ops for them', async () => {
    // The real gate no-ops for non-AI (proven in section 1); routes call it
    // unconditionally, so a human chat send still returns 201.
    mocks.getSession.mockResolvedValue(human);
    mocks.requireAiCapability.mockResolvedValue(null);
    const res = await chatPOST(req({ ciphertext: b64('c'), epoch: 0 }), { params: tParams() });
    expect(res.status).toBe(201);
  });
});
