/**
 * R-3 — deleting a topic deletes its encrypted attachments.
 *
 * Nothing else can. An attachment is referenced only from inside a sealed
 * message body, so the server cannot read which objects a message named; the
 * topic's storage prefix — `topicObjectPrefix(topicId)`, which chat attachments
 * live under (M-3) — is the only handle it has on them, by design. Once the
 * rows are gone the objects are unreachable AND undeletable, paid for forever,
 * so the sweep has to happen here or it never happens.
 *
 * The DB is mocked: the claim under test is "the delete handler calls the sweep
 * with THIS topic's prefix", which is about the handler, not about rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const TOPIC = '11111111-2222-3333-4444-555555555555';
const OWNER = '0xowner';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  topicsFindFirst: vi.fn(),
  topicMembersFindFirst: vi.fn(),
  deleteR2Prefix: vi.fn(),
  txDelete: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/redis', () => ({
  getRedis: () => ({ incr: vi.fn().mockResolvedValue(1), expire: vi.fn(), publish: vi.fn() }),
}));
vi.mock('@/lib/db', () => {
  const where = () => Promise.resolve([]);
  return {
    db: {
      query: {
        topics: { findFirst: mocks.topicsFindFirst },
        topicMembers: { findFirst: mocks.topicMembersFindFirst },
      },
      select: () => ({ from: () => ({ where }) }),
      transaction: async (cb: (tx: unknown) => Promise<void>) => {
        await cb({ delete: () => ({ where: mocks.txDelete }) });
      },
    },
  };
});
vi.mock('@/lib/r2', async (importOriginal) => {
  // `topicObjectPrefix` is NOT stubbed: the assertion below is about which
  // prefix the route sweeps, so the real one has to compute it.
  const actual = await importOriginal<typeof import('@/lib/r2')>();
  return {
    ...actual,
    deleteR2Prefix: mocks.deleteR2Prefix,
    deleteOrphanedR2Urls: vi.fn(),
    uploadToR2: vi.fn(),
  };
});

import { DELETE } from '@/app/api/topics/[topicId]/route';
import { chatMediaObjectKey } from '@/lib/chatMedia';
import { topicObjectPrefix } from '@/lib/r2';

const params = () => Promise.resolve({ topicId: TOPIC });
const req = () => ({ url: `http://x/api/topics/${TOPIC}` }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ userId: OWNER, nickname: 'o', isAI: false });
  mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, creatorId: OWNER });
  mocks.deleteR2Prefix.mockResolvedValue(3);
  mocks.txDelete.mockResolvedValue(undefined);
});

describe('DELETE /api/topics/{topicId}', () => {
  it('T1 CONTRACT: sweeps the topic own attachment prefix', async () => {
    const res = await DELETE(req(), { params: params() });
    expect(res.status).toBe(200);
    // Removing the sweep call fails here.
    /*
     * The route sweeps ONE prefix covering everything the topic owns (M-3), and
     * what this test defends is that chat attachments are inside it. Asserting
     * the chat prefix directly would pass while the sweep quietly moved to a
     * prefix that no longer contains it.
     */
    expect(mocks.deleteR2Prefix).toHaveBeenCalledTimes(1);
    const swept = mocks.deleteR2Prefix.mock.calls[0][0] as string;
    expect(swept).toBe(topicObjectPrefix(TOPIC));
    expect(
      chatMediaObjectKey(TOPIC, 'u1', 'a'.repeat(32)).startsWith(swept),
      'chat objects must be under the swept prefix',
    ).toBe(true);
  });

  it('M-1: the attachment INDEX rows go with the topic, inside the transaction', async () => {
    // The rows have an FK to topics, so leaving them would fail the topic
    // delete outright — and an index row for a topic that no longer exists
    // could never be swept by anything.
    await DELETE(req(), { params: params() });
    expect(mocks.txDelete).toHaveBeenCalled();
    // One tx.delete(...).where(...) per table cleared; chat_media is among them.
    expect(mocks.txDelete.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('T1: the prefix is the topic in the URL, not a neighbouring one', async () => {
    await DELETE(req(), { params: params() });
    const prefix = mocks.deleteR2Prefix.mock.calls[0][0];
    // Derived, not spelled out — the layout moved once already (M-3).
    expect(prefix).toBe(topicObjectPrefix(TOPIC));
    expect(prefix).toContain(TOPIC);
    expect(prefix.endsWith('/')).toBe(true); // or it would also match <TOPIC>2/
  });

  it('CONTRACT: the real sweep never throws, so a storage outage cannot fail the delete', async () => {
    /*
     * The rows are already gone by the time the sweep runs, so a throw here
     * would answer 500 for a topic that no longer exists. `deleteR2Prefix`
     * therefore swallows its own failures — asserted against the REAL
     * implementation, with R2 unconfigured, rather than against a mock.
     */
    const { deleteR2Prefix } = await vi.importActual<typeof import('@/lib/r2')>('@/lib/r2');
    const saved = process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCOUNT_ID;
    try {
      await expect(deleteR2Prefix(topicObjectPrefix(TOPIC))).resolves.toBe(0);
    } finally {
      if (saved !== undefined) process.env.R2_ACCOUNT_ID = saved;
    }
  });

  it('a traversal prefix is refused by the sweep itself', async () => {
    const { deleteR2Prefix } = await vi.importActual<typeof import('@/lib/r2')>('@/lib/r2');
    await expect(deleteR2Prefix('chat/../../')).resolves.toBe(0);
    await expect(deleteR2Prefix('')).resolves.toBe(0);
  });

  it('AUTHZ: a non-owner never reaches the sweep', async () => {
    mocks.getSession.mockResolvedValue({ userId: '0xstranger', nickname: 's', isAI: false });
    mocks.topicMembersFindFirst.mockResolvedValue({ role: 'member' });
    const res = await DELETE(req(), { params: params() });
    expect(res.status).toBe(403);
    expect(mocks.deleteR2Prefix).not.toHaveBeenCalled();
  });

  it('AUTHZ: a guest never reaches the sweep', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await DELETE(req(), { params: params() });
    expect(res.status).toBe(401);
    expect(mocks.deleteR2Prefix).not.toHaveBeenCalled();
  });

  it('a missing topic is 404 and sweeps nothing', async () => {
    mocks.topicsFindFirst.mockResolvedValue(undefined);
    const res = await DELETE(req(), { params: params() });
    expect(res.status).toBe(404);
    expect(mocks.deleteR2Prefix).not.toHaveBeenCalled();
  });
});
