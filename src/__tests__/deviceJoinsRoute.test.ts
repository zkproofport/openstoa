import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Commit route's obligation to record a device join (D-1).
 *
 * `deviceJoins.test.ts` proves the helper reads and writes the right thing.
 * That is not the same claim as "the route calls it" — and the two drifting
 * apart is exactly how the leaf-identity gap survived a green suite once
 * already. Deleting the call in `mls/commit/route.ts` leaves every test in that
 * file passing; it must not leave every test in THIS one passing.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   contract      → an accepted Commit records, with the route's own decoded
 *                   bytes and the topic from the path
 *   integrity     → the epoch handed over is the NEW one the CAS produced, not
 *                   the one the Commit asserted (an asserted epoch would place
 *                   the device one window early, where it can read nothing)
 *   boundary      → an accepted result carrying no epoch records NOTHING rather
 *                   than defaulting to a guess
 *   authorization → guest (401), non-member (403) and rate-limited (429)
 *                   callers never reach the bookkeeping
 *   race          → a CAS conflict (409) records nothing: the losing Commit
 *                   added nobody
 *   hostile       → an unparseable Commit (400) records nothing
 *   ext-failure   → bookkeeping that throws leaves the ACCEPTED commit at 201,
 *                   because the commit cannot be un-applied and a 500 would send
 *                   the client back to retry into a 409
 *   empty/UTF-8/large → N/A: the payload is opaque bytes whose size and base64
 *                   validity are already gated above this point in the route,
 *                   and are covered in `mls-routes.test.ts`.
 */

const session = { userId: 'u1', nickname: 'alice', isAI: false };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  incr: vi.fn().mockResolvedValue(1),
  expire: vi.fn(),
  publish: vi.fn().mockResolvedValue(1),
  topicMembersFindFirst: vi.fn(),
  applyCommitCas: vi.fn(),
  getCommitsSince: vi.fn(),
  scheduleDeviceJoinRecord: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/redis', () => ({
  getRedis: () => ({ incr: mocks.incr, expire: mocks.expire, publish: mocks.publish }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: { query: { topicMembers: { findFirst: mocks.topicMembersFindFirst } } },
}));
vi.mock('@/lib/mls/commits', () => ({
  applyCommitCas: mocks.applyCommitCas,
  getCommitsSince: mocks.getCommitsSince,
}));
vi.mock('@/lib/mls/deviceJoins', () => ({
  scheduleDeviceJoinRecord: mocks.scheduleDeviceJoinRecord,
}));

import { POST as commitPOST } from '@/app/api/topics/[topicId]/mls/commit/route';

// A real ts-mls Commit asserting epoch 0, so the route's crypto-free framing
// parser runs for real rather than against a shape we invented.
const REAL_COMMIT_B64 =
  'AAEAAhZvcGVuc3RvYS10b3BpYy1leHBsb3JlAAAAAAAAAAADABxqGVjE8mSY3/UlksInOFsTWoStw8FMRkPW6K1qQbiu1kjBeORV2hFxs47XxshW8DwwB3q/t4L05SLGLPm64HwLUGZF7C/n1YLVN2W0t7RSgGeRPYdOLRhGW/YTv4m0GEh/nwYsSWNOa8xc27JdlHD7ALJzzmGBmiXpVhpt1tbJK46G2V/qRdiItHp/ylYFT7MuznMJ4RHl/sAs3/T1/w4trQ6Nk3ZN1jX7Xc8Ht47eWIFz+JXIKJLzQRZONnuBdCGs0bLcC7PHyUp1dIEn/Pe3ik3UNqE40vQibPfkK8418LhbIdWhWZGqXv2vPFTZGUo72gkxvbuaE0lu6rfP5m1kLcDM08P7ZXH0c6GjbG7FUh+TC4jpN2AZavzV2OKlE16W+ddpuAbl4s4b/SezwMDJ3veWN6emmhh6vzn5/NgoSxOUYz/q3rxgL6X4ysR+e3EmEFHPuXyM0tX2A75pPS//bbejFS0+BdIOsYYVjDA+F1cp1q61Elwa4LLDq5VghZerPaNci6OjMm7/12iHDDj8U05D0Uq5+S3C15KO5PoGbzr2bbKIxnZZT9L6xGQxGlomv+IuqX0TmeTpKY5EVqV0V6CJVYjBWWnREx86I5u/ZMefCxq4xQ==';

const TOPIC = '00000000-0000-0000-0000-000000000001';
const params = () => Promise.resolve({ topicId: TOPIC });
const req = (body: unknown) =>
  ({ json: async () => body, url: `http://x/api/topics/${TOPIC}/mls/commit` }) as never;

const post = (body: unknown = { commit: REAL_COMMIT_B64 }) => commitPOST(req(body), { params: params() });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(session);
  mocks.incr.mockResolvedValue(1);
  mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: 'u1' });
  mocks.applyCommitCas.mockResolvedValue({ ok: true, newEpoch: 7 });
});

describe('POST /mls/commit — device-join bookkeeping (D-1)', () => {
  it('CONTRACT: an accepted Commit records the join, with the route\'s decoded bytes', async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect(mocks.scheduleDeviceJoinRecord).toHaveBeenCalledTimes(1);

    const [, topicId, bytes] = mocks.scheduleDeviceJoinRecord.mock.calls[0];
    expect(topicId).toBe(TOPIC);
    // The same bytes the CAS saw — not re-decoded, not the base64 string.
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect((bytes as Buffer).equals(Buffer.from(REAL_COMMIT_B64, 'base64'))).toBe(true);
  });

  it('INTEGRITY: the epoch handed over is the NEW one, not the epoch the Commit asserted', async () => {
    // The commit above asserts epoch 0. Recording 0 would place the device in a
    // window that closes before it can read anything.
    mocks.applyCommitCas.mockResolvedValue({ ok: true, newEpoch: 42 });
    await post();
    expect(mocks.scheduleDeviceJoinRecord.mock.calls[0][3]).toBe(42);
  });

  it('BOUNDARY: an accepted result with no epoch records nothing rather than guessing', async () => {
    mocks.applyCommitCas.mockResolvedValue({ ok: true });
    const res = await post();
    expect(res.status).toBe(201);
    expect(mocks.scheduleDeviceJoinRecord).not.toHaveBeenCalled();
  });

  it('RACE: the loser of an epoch-CAS conflict records nothing', async () => {
    mocks.applyCommitCas.mockResolvedValue({ ok: false, reason: 'fork' });
    const res = await post();
    expect(res.status).toBe(409);
    expect(mocks.scheduleDeviceJoinRecord).not.toHaveBeenCalled();
  });

  it('AUTHZ: guest, non-member and rate-limited callers never reach the bookkeeping', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await post()).status).toBe(401);

    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue(session);
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    expect((await post()).status).toBe(403);

    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue(session);
    mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: 'u1' });
    mocks.incr.mockResolvedValue(10_000);
    expect((await post()).status).toBe(429);

    expect(mocks.scheduleDeviceJoinRecord).not.toHaveBeenCalled();
  });

  it('HOSTILE: an unparseable Commit is rejected before any bookkeeping', async () => {
    const res = await post({ commit: Buffer.from([9, 9, 9]).toString('base64') });
    expect(res.status).toBe(400);
    expect(mocks.applyCommitCas).not.toHaveBeenCalled();
    expect(mocks.scheduleDeviceJoinRecord).not.toHaveBeenCalled();
  });

  it('EXT-FAILURE: bookkeeping that throws leaves the accepted Commit at 201', async () => {
    // The Commit is applied and fanned out by this point and cannot be taken
    // back. A 500 here would tell the client to retry a Commit that already
    // won its epoch — and the retry would collide with its own result.
    mocks.scheduleDeviceJoinRecord.mockImplementation(() => {
      throw new Error('bookkeeping exploded');
    });
    const res = await post();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ epoch: 7 });
    // The fan-out still happened: the bookkeeping is beside the Commit, not before it.
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
});
