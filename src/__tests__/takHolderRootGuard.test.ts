import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The archive-holder role may only be taken by a device that HOLDS the root.
 *
 * This is not a hypothetical. On staging a browser joined a public topic, took
 * the holder lease before it had the root, and locked itself out permanently:
 * the holder is the party every other device receives the root FROM, so nothing
 * would ever send it one. Sixteen archived messages stayed unreadable while the
 * key to them sat on another device of the same account, and every later device
 * queued behind the same dead holder.
 *
 * The server cannot verify a key (C1), so the check it CAN make is that the
 * claimer names the topic's root — publishing the identity when none is set,
 * matching it forever after. A device with no root cannot produce that name.
 */
const session = { userId: 'u1', nickname: 'alice', isAI: false };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  topicMembersFindFirst: vi.fn(),
  topicsFindFirst: vi.fn(),
  claimArchiveRootFingerprint: vi.fn(),
  claimOrRenewHolder: vi.fn(),
  releaseHolder: vi.fn(),
  getHolder: vi.fn(),
  updateHolderCoverage: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: {
    query: {
      topicMembers: { findFirst: mocks.topicMembersFindFirst },
      topics: { findFirst: mocks.topicsFindFirst },
    },
  },
}));
vi.mock('@/lib/mls/archive', () => ({
  claimArchiveRootFingerprint: mocks.claimArchiveRootFingerprint,
  claimOrRenewHolder: mocks.claimOrRenewHolder,
  releaseHolder: mocks.releaseHolder,
  getHolder: mocks.getHolder,
  updateHolderCoverage: mocks.updateHolderCoverage,
}));

import { POST, DELETE } from '@/app/api/topics/[topicId]/tak/holder/route';

const TOPIC = '00000000-0000-0000-0000-000000000042';
const FP = 'the-topics-real-root';
const params = () => Promise.resolve({ topicId: TOPIC });

const post = (body?: unknown) => ({ json: async () => body }) as never;
const del = (query = '') =>
  ({ nextUrl: new URL(`http://x/api/topics/${TOPIC}/tak/holder${query}`) }) as never;

const HOLDER_STATE = {
  holderUserId: 'u1',
  holderDeviceId: 'd1',
  epochCovered: 0,
  successionRank: 2,
  leaseExpiresAt: null,
};

function asPublicMember(role = 'member') {
  mocks.getSession.mockResolvedValue(session);
  mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: 'u1', role });
  mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'public' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimArchiveRootFingerprint.mockResolvedValue({ fingerprint: FP, claimed: true });
  mocks.claimOrRenewHolder.mockResolvedValue({ ok: true, renewed: false, state: HOLDER_STATE });
  mocks.releaseHolder.mockResolvedValue(true);
});

describe('holder claim — proof that the claimer holds the root', () => {
  it('REGRESSION: a claim with NO rootFingerprint never reaches the lease', async () => {
    asPublicMember();
    const res = await POST(post({ deviceId: 'd1' }), { params: params() });
    expect(res.status).toBe(400);
    // The lease is the thing that locks the device out. It must not be touched.
    expect(mocks.claimOrRenewHolder).not.toHaveBeenCalled();
  });

  it('HOSTILE: empty, whitespace-only and non-string fingerprints are all 400', async () => {
    asPublicMember();
    for (const rootFingerprint of ['', '   ', 42, null, {}, []]) {
      const res = await POST(post({ deviceId: 'd1', rootFingerprint }), { params: params() });
      expect(res.status).toBe(400);
    }
    expect(mocks.claimOrRenewHolder).not.toHaveBeenCalled();
  });

  it('a fingerprint that is NOT the topic root is rejected 403, lease untouched', async () => {
    asPublicMember();
    mocks.claimArchiveRootFingerprint.mockResolvedValue({ fingerprint: FP, claimed: false });
    const res = await POST(post({ deviceId: 'd1', rootFingerprint: 'some-other-root' }), { params: params() });
    expect(res.status).toBe(403);
    // The caller learns the real identity so it can adopt it instead.
    expect((await res.json()).fingerprint).toBe(FP);
    expect(mocks.claimOrRenewHolder).not.toHaveBeenCalled();
  });

  it('the matching fingerprint claims the lease', async () => {
    asPublicMember();
    const res = await POST(post({ deviceId: 'd1', rootFingerprint: FP }), { params: params() });
    expect(res.status).toBe(200);
    expect(mocks.claimOrRenewHolder).toHaveBeenCalledTimes(1);
  });

  it('GENESIS: the first holder publishes the topic root identity', async () => {
    asPublicMember('owner');
    const res = await POST(post({ deviceId: 'd1', rootFingerprint: FP }), { params: params() });
    expect(res.status).toBe(200);
    expect(mocks.claimArchiveRootFingerprint).toHaveBeenCalledWith(expect.anything(), TOPIC, FP);
  });

  it('a vanished topic is 404, not a silent lease grant', async () => {
    asPublicMember();
    mocks.claimArchiveRootFingerprint.mockResolvedValue(null);
    const res = await POST(post({ deviceId: 'd1', rootFingerprint: FP }), { params: params() });
    expect(res.status).toBe(404);
    expect(mocks.claimOrRenewHolder).not.toHaveBeenCalled();
  });

  it('AUTHZ: guest 401 and non-member 403 both stop before the root identity is touched', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await POST(post({ deviceId: 'd1', rootFingerprint: FP }), { params: params() })).status).toBe(401);

    mocks.getSession.mockResolvedValue(session);
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    expect((await POST(post({ deviceId: 'd1', rootFingerprint: FP }), { params: params() })).status).toBe(403);

    expect(mocks.claimArchiveRootFingerprint).not.toHaveBeenCalled();
  });

  it('TIER: a private topic is 400 and its root identity is never written (SI-6b)', async () => {
    mocks.getSession.mockResolvedValue(session);
    mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: 'u1', role: 'owner' });
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'private' });
    expect((await POST(post({ deviceId: 'd1', rootFingerprint: FP }), { params: params() })).status).toBe(400);
    expect(mocks.claimArchiveRootFingerprint).not.toHaveBeenCalled();
  });
});

describe('holder release — freeing a role the device cannot serve', () => {
  it('releases the caller OWN device, never a named rival', async () => {
    asPublicMember();
    const res = await DELETE(del('?deviceId=d1'), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: true });
    // user id comes from the SESSION, not the request — a caller cannot evict
    // another member's device by naming it.
    expect(mocks.releaseHolder).toHaveBeenCalledWith(expect.anything(), TOPIC, 'u1', 'd1');
  });

  it('reports released=false when this device did not hold the lease', async () => {
    asPublicMember();
    mocks.releaseHolder.mockResolvedValue(false);
    const res = await DELETE(del('?deviceId=someone-elses'), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: false });
  });

  it('HOSTILE: a missing or blank deviceId is 400, not a blanket release', async () => {
    asPublicMember();
    expect((await DELETE(del(), { params: params() })).status).toBe(400);
    expect((await DELETE(del('?deviceId='), { params: params() })).status).toBe(400);
    expect((await DELETE(del('?deviceId=%20%20'), { params: params() })).status).toBe(400);
    expect(mocks.releaseHolder).not.toHaveBeenCalled();
  });

  it('AUTHZ: guest 401, non-member 403, private topic 400 — none reach the release', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await DELETE(del('?deviceId=d1'), { params: params() })).status).toBe(401);

    mocks.getSession.mockResolvedValue(session);
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    expect((await DELETE(del('?deviceId=d1'), { params: params() })).status).toBe(403);

    mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: 'u1', role: 'owner' });
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'secret' });
    expect((await DELETE(del('?deviceId=d1'), { params: params() })).status).toBe(400);

    expect(mocks.releaseHolder).not.toHaveBeenCalled();
  });
});
