import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Profile-level AI capability model — unit tests (design §7).
 *
 * Three layers, all DB-free:
 *   1. Pure validation + predicate in `src/lib/aiPermissions.ts`
 *      (validateAiPermissionInput / permissionAllows) — the edge-case matrix's
 *      boundary / hostile / empty / integrity rows.
 *   2. The REAL `requireAiCapability` gate (isAI short-circuit + capability
 *      lookup + 403), exercised against a mocked db.query.aiPermissions.
 *   3. Route wiring: the profile GET/PUT endpoints AND the isAI-capability gate
 *      on every guarded route (chat send/read, archive, tak, topic join/leave,
 *      post write/delete, comment write, profile edit). requireAiCapability is
 *      mocked here so we isolate the HTTP contract (that each route calls the
 *      gate with the right cmd and propagates its 403).
 */

// ───────────────────────────────────────────────────────────────────────────
// 1. Pure validation + predicate (no db, no mocks)
// ───────────────────────────────────────────────────────────────────────────
import {
  validateAiPermissionInput,
  permissionAllows,
  ALLOWED_CMDS,
  AiPermissionValidationError,
  MAX_CMD_COUNT,
  type AiPermissionRow,
} from '@/lib/aiPermissions';

describe('validateAiPermissionInput — cmd allowlist (boundary / empty / hostile)', () => {
  it('accepts an EMPTY cmd array (AI may do nothing — the safe default)', () => {
    const n = validateAiPermissionInput({ cmd: [], historyGrant: 'none' });
    expect(n.cmd).toEqual([]);
  });
  it('accepts a subset of ALLOWED_CMDS', () => {
    const n = validateAiPermissionInput({ cmd: ['/openstoa/chat/send', '/openstoa/post/read'], historyGrant: 'full' });
    expect(n.cmd).toEqual(['/openstoa/chat/send', '/openstoa/post/read']);
  });
  it('accepts the full ALLOWED_CMDS set', () => {
    const n = validateAiPermissionInput({ cmd: [...ALLOWED_CMDS], historyGrant: 'none' });
    expect(n.cmd).toEqual([...ALLOWED_CMDS]);
  });
  it('rejects a non-array cmd', () => {
    expect(() => validateAiPermissionInput({ cmd: '/openstoa/chat/send', historyGrant: 'none' })).toThrow(AiPermissionValidationError);
  });
  it('rejects unknown cmd (no silent allow)', () => {
    expect(() => validateAiPermissionInput({ cmd: ['/openstoa/chat/send', '/root/delete'], historyGrant: 'none' })).toThrow(/unknown cmd/);
  });
  it('rejects a non-string cmd entry', () => {
    expect(() => validateAiPermissionInput({ cmd: [123], historyGrant: 'none' })).toThrow(AiPermissionValidationError);
  });
  it('rejects too many cmd entries (SI-4 cap)', () => {
    const many = Array.from({ length: MAX_CMD_COUNT + 1 }, () => '/ai/summarize');
    expect(() => validateAiPermissionInput({ cmd: many, historyGrant: 'none' })).toThrow(/too many/);
  });
  it('dedupes repeated cmd entries', () => {
    const n = validateAiPermissionInput({ cmd: ['/ai/summarize', '/ai/summarize'], historyGrant: 'none' });
    expect(n.cmd).toEqual(['/ai/summarize']);
  });
});

describe('validateAiPermissionInput — historyGrant scope (boundary / hostile)', () => {
  it('accepts none | full | since_epoch:N | Nd', () => {
    for (const s of ['none', 'full', 'since_epoch:5', '30d']) {
      const n = validateAiPermissionInput({ cmd: [], historyGrant: s });
      expect(n.historyGrant).toBe(s);
    }
  });
  it('rejects garbage scope', () => {
    for (const s of ['everything', 'since_epoch:', 'since_epoch:-1', '', 'drop table', '0d', undefined, null, 123]) {
      expect(() => validateAiPermissionInput({ cmd: [], historyGrant: s })).toThrow(AiPermissionValidationError);
    }
  });
  it('SI-1: normalized permission carries ONLY metadata (cmd + historyGrant), no key/plaintext fields', () => {
    const n = validateAiPermissionInput({ cmd: ['/openstoa/chat/send'], historyGrant: 'full' });
    expect(Object.keys(n).sort()).toEqual(['cmd', 'historyGrant'].sort());
  });
});

describe('permissionAllows — enforcement predicate (integrity / hostile)', () => {
  const perm: AiPermissionRow = {
    userId: 'u1', cmd: ['/openstoa/chat/send', '/openstoa/post/read'], historyGrant: 'full', updatedAt: new Date(),
  };
  it('allows a cmd in the set', () => {
    expect(permissionAllows(perm, '/openstoa/chat/send')).toBe(true);
    expect(permissionAllows(perm, '/openstoa/post/read')).toBe(true);
  });
  it('denies a cmd not in the set (scope beyond permission)', () => {
    expect(permissionAllows(perm, '/openstoa/post/write')).toBe(false);
    expect(permissionAllows(perm, '/openstoa/profile/edit')).toBe(false);
  });
  it('denies when the permission set is null (no config → 403)', () => {
    expect(permissionAllows(null, '/openstoa/chat/send')).toBe(false);
  });
  it('denies against an empty allowlist (AI configured to do nothing)', () => {
    expect(permissionAllows({ ...perm, cmd: [] }, '/openstoa/chat/send')).toBe(false);
  });
  it('ALLOWED_CMDS spans the app (topic/post/comment/chat/profile) + /ai helpers', () => {
    for (const c of ['/openstoa/topic/join', '/openstoa/topic/leave', '/openstoa/post/write', '/openstoa/post/delete', '/openstoa/comment/write', '/openstoa/chat/send', '/openstoa/chat/read', '/openstoa/profile/edit', '/ai/summarize', '/ai/search']) {
      expect(ALLOWED_CMDS).toContain(c);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Shared mocks for the db/session-backed layers
// ───────────────────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  incr: vi.fn().mockResolvedValue(1),
  expire: vi.fn(),
  publish: vi.fn().mockResolvedValue(1),
  topicMembersFindFirst: vi.fn(),
  aiPermsFindFirst: vi.fn(),
  usersFindFirst: vi.fn(),
  postsFindFirst: vi.fn(),
  topicsFindFirst: vi.fn(),
  insertReturning: vi.fn(),
  // aiPermissions module mocks (route-wiring layer)
  requireAiCapability: vi.fn(),
  getAiPermissions: vi.fn(),
  setAiPermissions: vi.fn(),
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
vi.mock('@/lib/db', () => ({
  db: {
    query: {
      topicMembers: { findFirst: mocks.topicMembersFindFirst },
      aiPermissions: { findFirst: mocks.aiPermsFindFirst },
      users: { findFirst: mocks.usersFindFirst },
      posts: { findFirst: mocks.postsFindFirst },
      topics: { findFirst: mocks.topicsFindFirst },
    },
    insert: () => ({ values: () => ({ returning: mocks.insertReturning }) }),
  },
}));

// ───────────────────────────────────────────────────────────────────────────
// 2. REAL requireAiCapability gate (db mocked, module NOT mocked)
// ───────────────────────────────────────────────────────────────────────────
describe('requireAiCapability — the real gate (authz / hostile)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('non-AI session passes with NO capability lookup (humans unaffected)', async () => {
    const real = await vi.importActual<typeof import('@/lib/aiPermissions')>('@/lib/aiPermissions');
    const { db } = await import('@/lib/db');
    const res = await real.requireAiCapability(db as never, { userId: 'human', isAI: false }, '/openstoa/chat/send');
    expect(res).toBeNull();
    expect(mocks.aiPermsFindFirst).not.toHaveBeenCalled();
  });
  it('isAI session WITH the capability passes (null)', async () => {
    const real = await vi.importActual<typeof import('@/lib/aiPermissions')>('@/lib/aiPermissions');
    const { db } = await import('@/lib/db');
    mocks.aiPermsFindFirst.mockResolvedValue({ userId: 'bot', cmd: ['/openstoa/chat/send'], historyGrant: 'none', updatedAt: new Date() });
    const res = await real.requireAiCapability(db as never, { userId: 'bot', isAI: true }, '/openstoa/chat/send');
    expect(res).toBeNull();
  });
  it('isAI session WITHOUT the capability → 403', async () => {
    const real = await vi.importActual<typeof import('@/lib/aiPermissions')>('@/lib/aiPermissions');
    const { db } = await import('@/lib/db');
    mocks.aiPermsFindFirst.mockResolvedValue({ userId: 'bot', cmd: ['/openstoa/post/read'], historyGrant: 'none', updatedAt: new Date() });
    const res = await real.requireAiCapability(db as never, { userId: 'bot', isAI: true }, '/openstoa/chat/send');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
  it('isAI session with NO configured permissions → 403 (no silent allow)', async () => {
    const real = await vi.importActual<typeof import('@/lib/aiPermissions')>('@/lib/aiPermissions');
    const { db } = await import('@/lib/db');
    mocks.aiPermsFindFirst.mockResolvedValue(undefined);
    const res = await real.requireAiCapability(db as never, { userId: 'bot', isAI: true }, '/openstoa/topic/join');
    expect(res!.status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Route wiring (aiPermissions module mocked)
// ───────────────────────────────────────────────────────────────────────────
vi.mock('@/lib/aiPermissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aiPermissions')>();
  return {
    ...actual,
    requireAiCapability: mocks.requireAiCapability,
    getAiPermissions: mocks.getAiPermissions,
    setAiPermissions: mocks.setAiPermissions,
  };
});

import { NextResponse } from 'next/server';
import { GET as aiPermsGET, PUT as aiPermsPUT } from '@/app/api/profile/ai-permissions/route';
import { POST as chatPOST, GET as chatGET } from '@/app/api/topics/[topicId]/chat/route';
import { GET as archiveGET } from '@/app/api/topics/[topicId]/archive/route';
import { GET as takGET } from '@/app/api/topics/[topicId]/tak/bundles/route';
import { POST as joinPOST } from '@/app/api/topics/[topicId]/join/route';
import { DELETE as membersDELETE } from '@/app/api/topics/[topicId]/members/route';
import { POST as postsPOST } from '@/app/api/topics/[topicId]/posts/route';
import { PATCH as postPATCH, DELETE as postDELETE } from '@/app/api/posts/[postId]/route';
import { POST as commentsPOST } from '@/app/api/posts/[postId]/comments/route';
import { PUT as nicknamePUT } from '@/app/api/profile/nickname/route';
import { AiPermissionValidationError as AVE } from '@/lib/aiPermissions';

const TOPIC = '00000000-0000-0000-0000-000000000001';
const POST = '00000000-0000-0000-0000-0000000000bb';
const tParams = () => Promise.resolve({ topicId: TOPIC });
const pParams = () => Promise.resolve({ postId: POST });
const b64 = (s: string) => Buffer.from(s).toString('base64');
const req = (body: unknown, query = '') =>
  ({ json: async () => body, url: `http://x/api/x${query}`, cookies: { get: () => undefined }, headers: { get: () => null } }) as never;

const human = { userId: 'human1', nickname: 'h', isAI: false };
const ai = { userId: 'bot1', nickname: 'b', isAI: true };
const FORBIDDEN = () => NextResponse.json({ error: 'AI capability required' }, { status: 403 });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.incr.mockResolvedValue(1);
  // Default: gate allows (returns null). Individual tests override to 403.
  mocks.requireAiCapability.mockResolvedValue(null);
});

describe('GET /api/profile/ai-permissions', () => {
  it('401 when unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await aiPermsGET(req(null));
    expect(res.status).toBe(401);
  });
  it('200 with defaults when the user has no config', async () => {
    mocks.getSession.mockResolvedValue(human);
    mocks.getAiPermissions.mockResolvedValue(null);
    const res = await aiPermsGET(req(null));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cmd).toEqual([]);
    expect(body.historyGrant).toBe('none');
    expect(body.allowedCmd).toEqual([...ALLOWED_CMDS]);
  });
  it('200 returns the stored config', async () => {
    mocks.getSession.mockResolvedValue(human);
    mocks.getAiPermissions.mockResolvedValue({ userId: 'human1', cmd: ['/openstoa/chat/send'], historyGrant: 'full', updatedAt: new Date() });
    const res = await aiPermsGET(req(null));
    const body = await res.json();
    expect(body.cmd).toEqual(['/openstoa/chat/send']);
    expect(body.historyGrant).toBe('full');
  });
});

describe('PUT /api/profile/ai-permissions (authz / boundary / hostile)', () => {
  it('401 when unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await aiPermsPUT(req({ cmd: [], historyGrant: 'none' }));
    expect(res.status).toBe(401);
  });
  it('200 sets the caller OWN permissions (keyed by session user)', async () => {
    mocks.getSession.mockResolvedValue(human);
    mocks.setAiPermissions.mockResolvedValue({ userId: 'human1', cmd: ['/openstoa/chat/send'], historyGrant: '7d', updatedAt: new Date() });
    const res = await aiPermsPUT(req({ cmd: ['/openstoa/chat/send'], historyGrant: '7d' }));
    expect(res.status).toBe(200);
    // Contract: setAiPermissions called with the SESSION user id (not a body-supplied id).
    expect(mocks.setAiPermissions).toHaveBeenCalledTimes(1);
    expect(mocks.setAiPermissions.mock.calls[0][1]).toBe('human1');
    const body = await res.json();
    expect(body.cmd).toEqual(['/openstoa/chat/send']);
  });
  it('400 when setAiPermissions rejects invalid input (unknown cmd / bad scope)', async () => {
    mocks.getSession.mockResolvedValue(human);
    mocks.setAiPermissions.mockRejectedValue(new AVE('unknown cmd: /root/x'));
    const res = await aiPermsPUT(req({ cmd: ['/root/x'], historyGrant: 'none' }));
    expect(res.status).toBe(400);
  });
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
    // The real gate no-ops for non-AI (proven in section 2); routes call it
    // unconditionally, so a human chat send still returns 201.
    mocks.getSession.mockResolvedValue(human);
    mocks.requireAiCapability.mockResolvedValue(null);
    const res = await chatPOST(req({ ciphertext: b64('c'), epoch: 0 }), { params: tParams() });
    expect(res.status).toBe(201);
  });
});
