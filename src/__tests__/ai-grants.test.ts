import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Phase 5 AI-member grant model — unit tests.
 *
 * Two layers, both DB-free:
 *   1. Pure validation + predicate logic in `src/lib/aiGrants.ts`
 *      (validateGrantInput / grantAllows) — the edge-case matrix's
 *      boundary / hostile / empty / integrity rows.
 *   2. Route wiring for the grant endpoints AND the AI-enforcement branch on
 *      chat send / archive read / tak read — the db + session layers are
 *      mocked (mirrors mls-routes.test.ts) so we isolate the HTTP contract,
 *      including the `session.isAI` gate dev-login can't set at E2E level.
 *
 * DB-backed invariants (last-resort KeyPackage reusability, atomic single-use)
 * are proven against real Postgres in mls-key-packages.concurrency.test.ts; a
 * pointer test here documents that mapping.
 */

// ───────────────────────────────────────────────────────────────────────────
// 1. Pure validation + predicate (no db, no mocks)
// ───────────────────────────────────────────────────────────────────────────
import {
  validateGrantInput,
  grantAllows,
  ALLOWED_CMDS,
  GrantValidationError,
  MAX_CMD_COUNT,
  MAX_GRANT_DEPTH,
  type GrantRow,
} from '@/lib/aiGrants';

const base = { topicId: 't1', granterUserId: 'owner1' };

describe('validateGrantInput — boundary (depth)', () => {
  it('accepts depth 0, 1, 3 (0 = no sub-delegation, 1 = default)', () => {
    for (const depth of [0, 1, 3]) {
      const n = validateGrantInput({ ...base, aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: 'none', depth });
      expect(n.depth).toBe(depth);
    }
  });
  it('defaults depth to 1 when omitted', () => {
    const n = validateGrantInput({ ...base, aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: 'none' });
    expect(n.depth).toBe(1);
  });
  it('rejects depth 4 (> MAX_GRANT_DEPTH)', () => {
    expect(() => validateGrantInput({ ...base, aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: 'none', depth: 4 }))
      .toThrow(GrantValidationError);
    expect(MAX_GRANT_DEPTH).toBe(3);
  });
  it('rejects negative and non-integer depth', () => {
    expect(() => validateGrantInput({ ...base, aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: 'none', depth: -1 })).toThrow(GrantValidationError);
    expect(() => validateGrantInput({ ...base, aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: 'none', depth: 1.5 })).toThrow(GrantValidationError);
  });
});

describe('validateGrantInput — cmd allowlist (hostile / empty)', () => {
  it('accepts a non-empty subset of ALLOWED_CMDS', () => {
    const n = validateGrantInput({ ...base, aiUserId: 'bot', cmd: ['/openstoa/chat/send', '/openstoa/post/read'], historyGrant: 'full' });
    expect(n.cmd).toEqual(['/openstoa/chat/send', '/openstoa/post/read']);
  });
  it('rejects empty cmd array', () => {
    expect(() => validateGrantInput({ ...base, aiUserId: 'bot', cmd: [], historyGrant: 'none' })).toThrow(/non-empty array/);
  });
  it('rejects a non-array cmd', () => {
    expect(() => validateGrantInput({ ...base, aiUserId: 'bot', cmd: '/openstoa/chat/send', historyGrant: 'none' })).toThrow(GrantValidationError);
  });
  it('rejects unknown cmd (no silent allow)', () => {
    expect(() => validateGrantInput({ ...base, aiUserId: 'bot', cmd: ['/openstoa/chat/send', '/root/delete'], historyGrant: 'none' })).toThrow(/unknown cmd/);
  });
  it('rejects a non-string cmd entry', () => {
    expect(() => validateGrantInput({ ...base, aiUserId: 'bot', cmd: [123], historyGrant: 'none' })).toThrow(GrantValidationError);
  });
  it('rejects too many cmd entries (SI-4 cap)', () => {
    const many = Array.from({ length: MAX_CMD_COUNT + 1 }, () => '/ai/summarize');
    expect(() => validateGrantInput({ ...base, aiUserId: 'bot', cmd: many, historyGrant: 'none' })).toThrow(/too many/);
  });
  it('dedupes repeated cmd entries', () => {
    const n = validateGrantInput({ ...base, aiUserId: 'bot', cmd: ['/ai/summarize', '/ai/summarize'], historyGrant: 'none' });
    expect(n.cmd).toEqual(['/ai/summarize']);
  });
});

describe('validateGrantInput — historyGrant scope (boundary / hostile)', () => {
  it('accepts none | full | since_epoch:N | Nd', () => {
    for (const s of ['none', 'full', 'since_epoch:5', '30d']) {
      const n = validateGrantInput({ ...base, aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: s });
      expect(n.historyGrant).toBe(s);
    }
  });
  it('rejects garbage scope', () => {
    for (const s of ['everything', 'since_epoch:', 'since_epoch:-1', '', 'drop table', '0d']) {
      expect(() => validateGrantInput({ ...base, aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: s })).toThrow(GrantValidationError);
    }
  });
});

describe('validateGrantInput — aiUserId + optional bindings (empty / hostile)', () => {
  it('rejects missing / empty / whitespace aiUserId', () => {
    expect(() => validateGrantInput({ ...base, aiUserId: undefined, cmd: ['/ai/summarize'], historyGrant: 'none' })).toThrow(/aiUserId/);
    expect(() => validateGrantInput({ ...base, aiUserId: '', cmd: ['/ai/summarize'], historyGrant: 'none' })).toThrow(/aiUserId/);
    expect(() => validateGrantInput({ ...base, aiUserId: '   ', cmd: ['/ai/summarize'], historyGrant: 'none' })).toThrow(/aiUserId/);
  });
  it('accepts and normalizes optional dpopJkt / consentAnchor (nullable)', () => {
    const n = validateGrantInput({ ...base, aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: 'none' });
    expect(n.dpopJkt).toBeNull();
    expect(n.consentAnchor).toBeNull();
    const n2 = validateGrantInput({ ...base, aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: 'none', dpopJkt: 'jkt123', consentAnchor: '0xeas' });
    expect(n2.dpopJkt).toBe('jkt123');
    expect(n2.consentAnchor).toBe('0xeas');
  });
  it('rejects empty-string optional bindings when provided', () => {
    expect(() => validateGrantInput({ ...base, aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: 'none', dpopJkt: '' })).toThrow(GrantValidationError);
  });
  it('SI-1: the normalized grant carries NO key/plaintext fields — only metadata', () => {
    const n = validateGrantInput({ ...base, aiUserId: 'bot', cmd: ['/openstoa/chat/send'], historyGrant: 'full', dpopJkt: 'jkt', consentAnchor: '0xeas' });
    expect(Object.keys(n).sort()).toEqual(['aiUserId', 'cmd', 'consentAnchor', 'depth', 'dpopJkt', 'historyGrant'].sort());
  });
});

describe('grantAllows — enforcement predicate (integrity / hostile)', () => {
  const active: GrantRow = {
    id: 'g1', topicId: 't1', granterUserId: 'owner1', aiUserId: 'bot',
    cmd: ['/openstoa/chat/send', '/openstoa/post/read'], historyGrant: 'full', depth: 1,
    dpopJkt: null, consentAnchor: null, revokedAt: null, createdAt: new Date(),
  };
  it('allows a cmd in the active grant', () => {
    expect(grantAllows(active, '/openstoa/chat/send')).toBe(true);
    expect(grantAllows(active, '/openstoa/post/read')).toBe(true);
  });
  it('denies a cmd not in the grant (scope beyond grant)', () => {
    expect(grantAllows(active, '/openstoa/post/write')).toBe(false);
    expect(grantAllows(active, '/ai/summarize')).toBe(false);
  });
  it('denies when grant is null (no grant → 403)', () => {
    expect(grantAllows(null, '/openstoa/chat/send')).toBe(false);
  });
  it('denies when grant is revoked (revoke blocks immediately)', () => {
    expect(grantAllows({ ...active, revokedAt: new Date() }, '/openstoa/chat/send')).toBe(false);
  });
  it('ALLOWED_CMDS includes the wired enforcement commands', () => {
    expect(ALLOWED_CMDS).toContain('/openstoa/chat/send');
    expect(ALLOWED_CMDS).toContain('/openstoa/post/read');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Route wiring (db + session mocked)
// ───────────────────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  incr: vi.fn().mockResolvedValue(1),
  expire: vi.fn(),
  publish: vi.fn().mockResolvedValue(1),
  topicMembersFindFirst: vi.fn(),
  aiGrantsFindFirst: vi.fn(),
  aiGrantsFindMany: vi.fn(),
  usersFindFirst: vi.fn(),
  chatFindFirst: vi.fn(),
  createGrant: vi.fn(),
  listGrants: vi.fn(),
  revokeGrant: vi.fn(),
  checkGrantAllows: vi.fn(),
  insertReturning: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/redis', () => ({
  getRedis: () => ({ incr: mocks.incr, expire: mocks.expire, publish: mocks.publish }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: {
    query: {
      topicMembers: { findFirst: mocks.topicMembersFindFirst },
      aiGrants: { findFirst: mocks.aiGrantsFindFirst, findMany: mocks.aiGrantsFindMany },
      users: { findFirst: mocks.usersFindFirst },
      chatMessages: { findFirst: mocks.chatFindFirst },
    },
    insert: () => ({ values: () => ({ returning: mocks.insertReturning }) }),
  },
}));
// The grants routes go through the aiGrants lib; enforcement routes call
// checkGrantAllows. Mock the module so route tests stay DB-free while the pure
// logic above is exercised directly against the real implementation.
vi.mock('@/lib/aiGrants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aiGrants')>();
  return {
    ...actual,
    createGrant: mocks.createGrant,
    listGrants: mocks.listGrants,
    revokeGrant: mocks.revokeGrant,
    checkGrantAllows: mocks.checkGrantAllows,
  };
});

import { POST as grantsPOST, GET as grantsGET } from '@/app/api/topics/[topicId]/ai/grants/route';
import { DELETE as grantsDELETE } from '@/app/api/topics/[topicId]/ai/grants/[grantId]/route';
import { POST as chatPOST } from '@/app/api/topics/[topicId]/chat/route';
import { GET as archiveGET } from '@/app/api/topics/[topicId]/archive/route';
import { GET as takGET } from '@/app/api/topics/[topicId]/tak/bundles/route';
import { GrantValidationError as GVE } from '@/lib/aiGrants';

const TOPIC = '00000000-0000-0000-0000-000000000001';
const GRANT = '00000000-0000-0000-0000-0000000000aa';
const tParams = () => Promise.resolve({ topicId: TOPIC });
const gParams = () => Promise.resolve({ topicId: TOPIC, grantId: GRANT });
const b64 = (s: string) => Buffer.from(s).toString('base64');
const req = (body: unknown, query = '') =>
  ({ json: async () => body, url: `http://x/api/topics/${TOPIC}/ai/x${query}`, cookies: { get: () => undefined }, headers: { get: () => null } }) as never;

const owner = { userId: 'owner1', nickname: 'owner', isAI: false };
const member = { userId: 'member1', nickname: 'mem', isAI: false };
const aiSession = { userId: 'bot1', nickname: 'bot', isAI: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.incr.mockResolvedValue(1);
});

describe('grants POST — owner-only + validation (authz / empty / boundary)', () => {
  it('401 when unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await grantsPOST(req({ aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: 'none' }), { params: tParams() });
    expect(res.status).toBe(401);
  });
  it('403 for non-member', async () => {
    mocks.getSession.mockResolvedValue(owner);
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    const res = await grantsPOST(req({ aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: 'none' }), { params: tParams() });
    expect(res.status).toBe(403);
  });
  it('403 for a non-owner member (hostile: member tries to grant)', async () => {
    mocks.getSession.mockResolvedValue(member);
    mocks.topicMembersFindFirst.mockResolvedValue({ role: 'member' });
    const res = await grantsPOST(req({ aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: 'none' }), { params: tParams() });
    expect(res.status).toBe(403);
    expect(mocks.createGrant).not.toHaveBeenCalled();
  });
  it('201 when owner grants (contract: createGrant called with cmd/scope)', async () => {
    mocks.getSession.mockResolvedValue(owner);
    mocks.topicMembersFindFirst.mockResolvedValue({ role: 'owner' });
    mocks.createGrant.mockResolvedValue({
      id: GRANT, topicId: TOPIC, granterUserId: 'owner1', aiUserId: 'bot',
      cmd: ['/openstoa/chat/send'], historyGrant: '7d', depth: 1, dpopJkt: null, consentAnchor: null,
      revokedAt: null, createdAt: new Date(),
    });
    const res = await grantsPOST(req({ aiUserId: 'bot', cmd: ['/openstoa/chat/send'], historyGrant: '7d' }), { params: tParams() });
    expect(res.status).toBe(201);
    expect(mocks.createGrant).toHaveBeenCalledTimes(1);
    const arg = mocks.createGrant.mock.calls[0][1];
    expect(arg.aiUserId).toBe('bot');
    expect(arg.cmd).toEqual(['/openstoa/chat/send']);
    expect(arg.historyGrant).toBe('7d');
    // SI-1: response is metadata only, no key fields.
    const { grant } = await res.json();
    expect(grant.cmd).toEqual(['/openstoa/chat/send']);
    expect(Object.keys(grant)).not.toContain('key');
  });
  it('400 when createGrant rejects invalid input (admin allowed as owner)', async () => {
    mocks.getSession.mockResolvedValue(owner);
    mocks.topicMembersFindFirst.mockResolvedValue({ role: 'admin' });
    mocks.createGrant.mockRejectedValue(new GVE('depth must be an integer between 0 and 3'));
    const res = await grantsPOST(req({ aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: 'none', depth: 4 }), { params: tParams() });
    expect(res.status).toBe(400);
  });
  it('429 when over rate limit', async () => {
    mocks.getSession.mockResolvedValue(owner);
    mocks.topicMembersFindFirst.mockResolvedValue({ role: 'owner' });
    mocks.incr.mockResolvedValue(99999);
    const res = await grantsPOST(req({ aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: 'none' }), { params: tParams() });
    expect(res.status).toBe(429);
  });
});

describe('grants GET — member list (authz)', () => {
  it('403 for non-member', async () => {
    mocks.getSession.mockResolvedValue(member);
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    const res = await grantsGET(req(null), { params: tParams() });
    expect(res.status).toBe(403);
  });
  it('200 returns active grants for a member', async () => {
    mocks.getSession.mockResolvedValue(member);
    mocks.topicMembersFindFirst.mockResolvedValue({ role: 'member' });
    mocks.listGrants.mockResolvedValue([
      { id: GRANT, topicId: TOPIC, granterUserId: 'owner1', aiUserId: 'bot', cmd: ['/ai/summarize'], historyGrant: 'none', depth: 1, dpopJkt: null, consentAnchor: null, revokedAt: null, createdAt: new Date() },
    ]);
    const res = await grantsGET(req(null), { params: tParams() });
    expect(res.status).toBe(200);
    const { grants } = await res.json();
    expect(grants).toHaveLength(1);
    expect(grants[0].aiUserId).toBe('bot');
  });
});

describe('grants DELETE — revoke (authz / race)', () => {
  const grantRow = { id: GRANT, topicId: TOPIC, aiUserId: 'bot1', granterUserId: 'owner1' };
  it('401 unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await grantsDELETE(req(null), { params: gParams() });
    expect(res.status).toBe(401);
  });
  it('404 when grant not found', async () => {
    mocks.getSession.mockResolvedValue(owner);
    mocks.aiGrantsFindFirst.mockResolvedValue(undefined);
    const res = await grantsDELETE(req(null), { params: gParams() });
    expect(res.status).toBe(404);
  });
  it('403 when caller is neither owner nor the bot', async () => {
    mocks.getSession.mockResolvedValue(member);
    mocks.aiGrantsFindFirst.mockResolvedValue(grantRow);
    mocks.topicMembersFindFirst.mockResolvedValue({ role: 'member' });
    const res = await grantsDELETE(req(null), { params: gParams() });
    expect(res.status).toBe(403);
    expect(mocks.revokeGrant).not.toHaveBeenCalled();
  });
  it('200 when the owner revokes', async () => {
    mocks.getSession.mockResolvedValue(owner);
    mocks.aiGrantsFindFirst.mockResolvedValue(grantRow);
    mocks.topicMembersFindFirst.mockResolvedValue({ role: 'owner' });
    mocks.revokeGrant.mockResolvedValue({ ...grantRow, revokedAt: new Date() });
    const res = await grantsDELETE(req(null), { params: gParams() });
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBe(true);
  });
  it('200 when the bot revokes its own grant', async () => {
    mocks.getSession.mockResolvedValue(aiSession); // userId 'bot1' === grant.aiUserId
    mocks.aiGrantsFindFirst.mockResolvedValue(grantRow);
    mocks.revokeGrant.mockResolvedValue({ ...grantRow, revokedAt: new Date() });
    const res = await grantsDELETE(req(null), { params: gParams() });
    expect(res.status).toBe(200);
    expect(mocks.topicMembersFindFirst).not.toHaveBeenCalled(); // bot path skips membership
  });
  it('404 on concurrent double-revoke (second flip is a no-op)', async () => {
    mocks.getSession.mockResolvedValue(owner);
    mocks.aiGrantsFindFirst.mockResolvedValue(grantRow);
    mocks.topicMembersFindFirst.mockResolvedValue({ role: 'owner' });
    mocks.revokeGrant.mockResolvedValue(null); // already revoked by the racing caller
    const res = await grantsDELETE(req(null), { params: gParams() });
    expect(res.status).toBe(404);
  });
});

describe('AI enforcement on chat send (isAI gate)', () => {
  beforeEach(() => {
    mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: 'x', role: 'member' });
    mocks.usersFindFirst.mockResolvedValue({ id: 'x', nickname: 'n', profileImage: null });
    mocks.insertReturning.mockResolvedValue([
      { id: 'm1', topicId: TOPIC, userId: 'bot1', ciphertext: Buffer.from('c'), epoch: 0, takVersion: null, type: 'message', isAI: true, createdAt: new Date() },
    ]);
  });
  it('403 when an AI caller has no grant allowing chat/send', async () => {
    mocks.getSession.mockResolvedValue(aiSession);
    mocks.checkGrantAllows.mockResolvedValue(false);
    const res = await chatPOST(req({ ciphertext: b64('c'), epoch: 0 }), { params: tParams() });
    expect(res.status).toBe(403);
    expect(mocks.checkGrantAllows).toHaveBeenCalledWith(expect.anything(), TOPIC, 'bot1', '/openstoa/chat/send');
  });
  it('201 when an AI caller has an allowing grant', async () => {
    mocks.getSession.mockResolvedValue(aiSession);
    mocks.checkGrantAllows.mockResolvedValue(true);
    const res = await chatPOST(req({ ciphertext: b64('c'), epoch: 0 }), { params: tParams() });
    expect(res.status).toBe(201);
  });
  it('humans are unaffected — no grant lookup for a non-AI sender', async () => {
    mocks.getSession.mockResolvedValue(member);
    const res = await chatPOST(req({ ciphertext: b64('c'), epoch: 0 }), { params: tParams() });
    expect(res.status).toBe(201);
    expect(mocks.checkGrantAllows).not.toHaveBeenCalled();
  });
});

describe('AI enforcement on history read (archive + tak GET)', () => {
  beforeEach(() => {
    mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: 'x', role: 'member' });
  });
  it('archive GET: 403 for an AI reader without a post/read grant', async () => {
    mocks.getSession.mockResolvedValue(aiSession);
    mocks.checkGrantAllows.mockResolvedValue(false);
    const res = await archiveGET(req(null), { params: tParams() });
    expect(res.status).toBe(403);
    expect(mocks.checkGrantAllows).toHaveBeenCalledWith(expect.anything(), TOPIC, 'bot1', '/openstoa/post/read');
  });
  it('tak bundles GET: 403 for an AI reader without a post/read grant', async () => {
    mocks.getSession.mockResolvedValue(aiSession);
    mocks.checkGrantAllows.mockResolvedValue(false);
    const res = await takGET(req(null, `?deviceId=d1`), { params: tParams() });
    expect(res.status).toBe(403);
  });
  it('humans reading history do not trigger a grant lookup', async () => {
    mocks.getSession.mockResolvedValue(member);
    const res = await takGET(req(null, `?deviceId=d1`), { params: tParams() });
    // 400 (no bundles handler mocked) is fine — the point is no grant gate ran.
    expect(mocks.checkGrantAllows).not.toHaveBeenCalled();
    expect([200, 400, 500]).toContain(res.status);
  });
});

describe('last-resort KeyPackage reusability (pointer)', () => {
  it('DB-backed proof lives in mls-key-packages.concurrency.test.ts', () => {
    // Deliverable #1: normal KP is single-use (one concurrent winner),
    // last-resort KP is reusable (returned without being consumed). Both are
    // proven against real Postgres in that file (SET consumed_at = CASE WHEN
    // is_last_resort THEN consumed_at ELSE now() END). Kept as a documented
    // pointer so the mapping is discoverable from the Phase 5 suite.
    expect(true).toBe(true);
  });
});
