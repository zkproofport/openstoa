import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Route-level tests for the MLS Delivery Service endpoints: authz (401/403),
 * input validation (400), rate limit (429), framing rejection, and success
 * response shapes. The DB-level invariants (SI-2 epoch-CAS, SI-3 atomic
 * consume) are proven separately against real Postgres; here the DB/helper
 * layer is mocked so we isolate the HTTP wiring.
 */

const session = { userId: 'u1', nickname: 'alice', isAI: false };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  incr: vi.fn().mockResolvedValue(1),
  expire: vi.fn(),
  publish: vi.fn().mockResolvedValue(1),
  topicMembersFindFirst: vi.fn(),
  mlsGroupsFindFirst: vi.fn(),
  kpReturning: vi.fn(),
  consumeOneKeyPackage: vi.fn(),
  applyCommitCas: vi.fn(),
  getCommitsSince: vi.fn(),
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
      mlsGroups: { findFirst: mocks.mlsGroupsFindFirst },
    },
    insert: () => ({ values: () => ({ returning: mocks.kpReturning }) }),
  },
}));
vi.mock('@/lib/mls/keyPackages', () => ({ consumeOneKeyPackage: mocks.consumeOneKeyPackage }));
vi.mock('@/lib/mls/commits', () => ({
  applyCommitCas: mocks.applyCommitCas,
  getCommitsSince: mocks.getCommitsSince,
}));

import { POST as kpPOST, GET as kpGET } from '@/app/api/topics/[topicId]/mls/key-packages/route';
import { POST as commitPOST, GET as commitGET } from '@/app/api/topics/[topicId]/mls/commit/route';
import { GET as groupInfoGET } from '@/app/api/topics/[topicId]/mls/group-info/route';

// A real ts-mls Commit (mls_private_message, asserts epoch 0) — so the route's
// crypto-free framing parser runs for real in the commit test.
const REAL_COMMIT_B64 =
  'AAEAAhZvcGVuc3RvYS10b3BpYy1leHBsb3JlAAAAAAAAAAADABxqGVjE8mSY3/UlksInOFsTWoStw8FMRkPW6K1qQbiu1kjBeORV2hFxs47XxshW8DwwB3q/t4L05SLGLPm64HwLUGZF7C/n1YLVN2W0t7RSgGeRPYdOLRhGW/YTv4m0GEh/nwYsSWNOa8xc27JdlHD7ALJzzmGBmiXpVhpt1tbJK46G2V/qRdiItHp/ylYFT7MuznMJ4RHl/sAs3/T1/w4trQ6Nk3ZN1jX7Xc8Ht47eWIFz+JXIKJLzQRZONnuBdCGs0bLcC7PHyUp1dIEn/Pe3ik3UNqE40vQibPfkK8418LhbIdWhWZGqXv2vPFTZGUo72gkxvbuaE0lu6rfP5m1kLcDM08P7ZXH0c6GjbG7FUh+TC4jpN2AZavzV2OKlE16W+ddpuAbl4s4b/SezwMDJ3veWN6emmhh6vzn5/NgoSxOUYz/q3rxgL6X4ysR+e3EmEFHPuXyM0tX2A75pPS//bbejFS0+BdIOsYYVjDA+F1cp1q61Elwa4LLDq5VghZerPaNci6OjMm7/12iHDDj8U05D0Uq5+S3C15KO5PoGbzr2bbKIxnZZT9L6xGQxGlomv+IuqX0TmeTpKY5EVqV0V6CJVYjBWWnREx86I5u/ZMefCxq4xQ==';

const TOPIC = '00000000-0000-0000-0000-000000000001';
const params = () => Promise.resolve({ topicId: TOPIC });
const req = (body: unknown, query = '') =>
  ({ json: async () => body, url: `http://x/api/topics/${TOPIC}/mls/x${query}` }) as never;
const b64 = (s: string | Buffer) => Buffer.from(s as never).toString('base64');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(session);
  mocks.incr.mockResolvedValue(1);
  mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: 'u1' });
});

describe('key-packages POST', () => {
  it('401 when unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await kpPOST(req({ keyPackage: b64('kp'), deviceId: 'd1' }), { params: params() });
    expect(res.status).toBe(401);
  });
  it('403 for non-member', async () => {
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    const res = await kpPOST(req({ keyPackage: b64('kp'), deviceId: 'd1' }), { params: params() });
    expect(res.status).toBe(403);
  });
  it('400 on invalid base64 keyPackage', async () => {
    const res = await kpPOST(req({ keyPackage: 'not!b64', deviceId: 'd1' }), { params: params() });
    expect(res.status).toBe(400);
  });
  it('400 when deviceId missing', async () => {
    const res = await kpPOST(req({ keyPackage: b64('kp') }), { params: params() });
    expect(res.status).toBe(400);
  });
  it('429 when over rate limit', async () => {
    mocks.incr.mockResolvedValue(99999);
    const res = await kpPOST(req({ keyPackage: b64('kp'), deviceId: 'd1' }), { params: params() });
    expect(res.status).toBe(429);
  });
  it('201 on success', async () => {
    mocks.kpReturning.mockResolvedValue([{ id: 'kp1' }]);
    const res = await kpPOST(req({ keyPackage: b64('kp'), deviceId: 'd1' }), { params: params() });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'kp1' });
  });
});

describe('key-packages GET (consume)', () => {
  it('400 without userId', async () => {
    const res = await kpGET(req(null), { params: params() });
    expect(res.status).toBe(400);
  });
  it('404 when none available', async () => {
    mocks.consumeOneKeyPackage.mockResolvedValue(null);
    const res = await kpGET(req(null, '?userId=joiner'), { params: params() });
    expect(res.status).toBe(404);
  });
  it('200 returns the consumed package (base64)', async () => {
    mocks.consumeOneKeyPackage.mockResolvedValue({
      id: 'kp1', deviceId: 'd1', keyPackage: Buffer.from('pkg'), isLastResort: false,
    });
    const res = await kpGET(req(null, '?userId=joiner'), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'kp1', deviceId: 'd1', keyPackage: b64('pkg'), isLastResort: false });
  });
});

describe('commit POST', () => {
  it('403 for non-member', async () => {
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    const res = await commitPOST(req({ commit: REAL_COMMIT_B64 }), { params: params() });
    expect(res.status).toBe(403);
  });
  it('400 on invalid base64 commit', async () => {
    const res = await commitPOST(req({ commit: 'not!b64' }), { params: params() });
    expect(res.status).toBe(400);
  });
  it('400 on unparseable framing (valid base64, junk bytes)', async () => {
    const res = await commitPOST(req({ commit: b64('junkjunk') }), { params: params() });
    expect(res.status).toBe(400);
    expect(mocks.applyCommitCas).not.toHaveBeenCalled();
  });
  it('409 when epoch-CAS reports a fork', async () => {
    mocks.applyCommitCas.mockResolvedValue({ ok: false, reason: 'fork' });
    const res = await commitPOST(req({ commit: REAL_COMMIT_B64 }), { params: params() });
    expect(res.status).toBe(409);
    expect(mocks.publish).not.toHaveBeenCalled(); // no fan-out on rejection
  });
  it('201 + fan-out on success', async () => {
    mocks.applyCommitCas.mockResolvedValue({ ok: true, newEpoch: 1 });
    const res = await commitPOST(req({ commit: REAL_COMMIT_B64 }), { params: params() });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ epoch: 1 });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish.mock.calls[0][0]).toBe(`mls:topic:${TOPIC}`);
  });
});

describe('commit GET (catch-up)', () => {
  it('returns commits since epoch as base64', async () => {
    mocks.getCommitsSince.mockResolvedValue([{ epoch: 2, commit: Buffer.from('c'), welcome: null }]);
    const res = await commitGET(req(null, '?sinceEpoch=1'), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ commits: [{ epoch: 2, commit: b64('c'), welcome: null }] });
  });
});

describe('group-info GET', () => {
  it('403 for non-member', async () => {
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    const res = await groupInfoGET(req(null), { params: params() });
    expect(res.status).toBe(403);
  });
  it('404 when no GroupInfo', async () => {
    mocks.mlsGroupsFindFirst.mockResolvedValue(undefined);
    const res = await groupInfoGET(req(null), { params: params() });
    expect(res.status).toBe(404);
  });
  it('200 returns base64 GroupInfo + epoch + ciphersuite', async () => {
    mocks.mlsGroupsFindFirst.mockResolvedValue({
      groupInfo: Buffer.from('gi'), currentEpoch: 3, ciphersuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
    });
    const res = await groupInfoGET(req(null), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      groupInfo: b64('gi'), epoch: 3, ciphersuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
    });
  });
});
