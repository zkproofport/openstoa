import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * P-Q — the OPTIONAL `pushArchive` field on POST /api/topics/[topicId]/chat
 * (design §13.6 strategy A). It is the TAK-sealed copy of the same body, sent in
 * this request because push fan-out happens here (the separate POST /archive
 * call only lands afterwards, so reading chat_archive in the push path would be
 * a race).
 *
 * The governing rule under test: `pushArchive` is a preview OPTIMISATION, not
 * message data. Anything malformed is ignored — the message is still stored, the
 * response is still 201, and the push still goes out (just without the preview).
 * It is also never persisted.
 *
 * Matrix rows: absent / empty / non-base64 / non-canonical / oversized ct,
 * takVersion 0-negative-fractional-huge-missing-wrong-type, non-object shapes,
 * decoded-size boundary (cap and cap+1), UTF-8 bodies, authz, and the two
 * contract invariants (insert never carries it; dispatch is always invoked).
 */

const session = { userId: 'u1', nickname: 'alice', isAI: false };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  publish: vi.fn().mockResolvedValue(1),
  topicMembersFindFirst: vi.fn(),
  usersFindFirst: vi.fn(),
  insertValues: vi.fn(),
  dispatchCiphertext: vi.fn(),
  dispatchDummy: vi.fn(),
  pushMode: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/redis', () => ({ getRedis: () => ({ publish: mocks.publish }) }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/push', () => ({
  // Return whatever the spy returns so a test can inject an async rejection (or
  // a synchronous throw) and assert the route still answers 201.
  dispatchCiphertextForMessage: (...a: unknown[]) => mocks.dispatchCiphertext(...a) ?? Promise.resolve(),
  dispatchDummyForMessage: (...a: unknown[]) => mocks.dispatchDummy(...a) ?? Promise.resolve(),
  getPushProvider: () => ({ send: async () => {}, sendCiphertext: async () => {} }),
  getPushMode: () => mocks.pushMode(),
}));
vi.mock('@/lib/db', () => ({
  db: {
    query: {
      topicMembers: { findFirst: mocks.topicMembersFindFirst },
      users: { findFirst: mocks.usersFindFirst },
      chatMessages: { findFirst: vi.fn() },
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        mocks.insertValues(v);
        return {
          returning: async () => [
            {
              id: 'm1',
              topicId: v.topicId,
              userId: v.userId,
              ciphertext: v.ciphertext,
              epoch: v.epoch,
              takVersion: v.takVersion ?? null,
              type: v.type,
              isAI: v.isAI,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
            },
          ],
        };
      },
    }),
  },
}));

import { POST } from '@/app/api/topics/[topicId]/chat/route';

const TOPIC = '00000000-0000-0000-0000-000000000001';
const MAX_CIPHERTEXT_BYTES = 4096;

function req(body: unknown) {
  return { json: async () => body, url: `http://x/api/topics/${TOPIC}/chat` } as never;
}
const params = () => Promise.resolve({ topicId: TOPIC });
const b64 = (s: string | Buffer) => Buffer.from(s as never).toString('base64');
const CT = b64('sealed-mls-bytes');
const ACT = b64('tak-sealed-preview');

/** The `input` object the route handed to dispatchCiphertextForMessage. */
function dispatchedInput(): Record<string, unknown> {
  expect(mocks.dispatchCiphertext).toHaveBeenCalledTimes(1);
  return mocks.dispatchCiphertext.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(session);
  mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: 'u1' });
  mocks.usersFindFirst.mockResolvedValue({ nickname: 'alice', profileImage: null });
  mocks.pushMode.mockReturnValue('ciphertext');
});

describe('POST chat — pushArchive accepted', () => {
  it('forwards a valid preview to the ciphertext dispatch', async () => {
    const res = await POST(
      req({ ciphertext: CT, epoch: 0, pushArchive: { ct: ACT, takVersion: 5 } }),
      { params: params() },
    );
    expect(res.status).toBe(201);
    const input = dispatchedInput();
    expect(input.archiveCiphertextB64).toBe(ACT); // verbatim
    expect(input.takVersion).toBe(5);
    expect(input.sealedCiphertextB64).toBe(CT);
    expect(input.messageId).toBe('m1');
  });

  it('takVersion 0 (public archive root) is accepted, not read as missing', async () => {
    await POST(req({ ciphertext: CT, epoch: 0, pushArchive: { ct: ACT, takVersion: 0 } }), { params: params() });
    expect(dispatchedInput().takVersion).toBe(0);
  });

  it('boundary: a preview at exactly the 4096-byte decoded cap is accepted', async () => {
    const act = b64(Buffer.alloc(MAX_CIPHERTEXT_BYTES, 9));
    const res = await POST(
      req({ ciphertext: CT, epoch: 0, pushArchive: { ct: act, takVersion: 1 } }),
      { params: params() },
    );
    expect(res.status).toBe(201);
    expect(dispatchedInput().archiveCiphertextB64).toBe(act);
  });

  it('integrity: a UTF-8 (Korean / emoji) body round-trips as opaque base64', async () => {
    for (const body of ['회의 3시에 시작합니다', '🌟 emoji preview 🎉']) {
      vi.clearAllMocks();
      mocks.getSession.mockResolvedValue(session);
      mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: 'u1' });
      mocks.usersFindFirst.mockResolvedValue({ nickname: 'alice', profileImage: null });
      mocks.pushMode.mockReturnValue('ciphertext');
      const act = b64(Buffer.from(body, 'utf8'));
      const res = await POST(
        req({ ciphertext: CT, epoch: 0, pushArchive: { ct: act, takVersion: 2 } }),
        { params: params() },
      );
      expect(res.status).toBe(201);
      expect(dispatchedInput().archiveCiphertextB64).toBe(act);
    }
  });
});

describe('POST chat — malformed pushArchive is ignored, never a 400', () => {
  const bad: Array<[string, unknown]> = [
    ['absent', undefined],
    ['null', null],
    ['a string', 'not-an-object'],
    ['a number', 7],
    ['an array', [{ ct: ACT, takVersion: 0 }]],
    ['empty object', {}],
    ['empty ct', { ct: '', takVersion: 0 }],
    ['whitespace ct', { ct: '   ', takVersion: 0 }],
    ['non-base64 ct', { ct: 'not valid!!', takVersion: 0 }],
    ['ct with embedded whitespace', { ct: 'aGVs bG8=', takVersion: 0 }],
    ['non-canonical base64 ct', { ct: 'aGVsbG8', takVersion: 0 }],
    ['ct not a string', { ct: 12345, takVersion: 0 }],
    ['missing takVersion', { ct: ACT }],
    ['null takVersion', { ct: ACT, takVersion: null }],
    ['negative takVersion', { ct: ACT, takVersion: -1 }],
    ['fractional takVersion', { ct: ACT, takVersion: 1.5 }],
    ['NaN takVersion', { ct: ACT, takVersion: NaN }],
    ['unsafe-integer takVersion', { ct: ACT, takVersion: Number.MAX_VALUE }],
    ['string takVersion', { ct: ACT, takVersion: '3' }],
  ];

  for (const [label, pushArchive] of bad) {
    it(`${label} → 201, dispatch still runs without the preview`, async () => {
      const res = await POST(req({ ciphertext: CT, epoch: 0, pushArchive }), { params: params() });
      expect(res.status).toBe(201);
      const input = dispatchedInput();
      expect(input.archiveCiphertextB64).toBeUndefined();
      expect(input.takVersion).toBeUndefined();
      expect(input.sealedCiphertextB64).toBe(CT); // the message itself is unaffected
    });
  }

  it('boundary: cap+1 decoded bytes is ignored (the message still sends)', async () => {
    const act = b64(Buffer.alloc(MAX_CIPHERTEXT_BYTES + 1, 9));
    const res = await POST(
      req({ ciphertext: CT, epoch: 0, pushArchive: { ct: act, takVersion: 1 } }),
      { params: params() },
    );
    expect(res.status).toBe(201);
    expect(dispatchedInput().archiveCiphertextB64).toBeUndefined();
  });
});

describe('POST chat — pushArchive contract invariants', () => {
  it('is NEVER persisted — the insert carries only the message columns', async () => {
    await POST(
      req({ ciphertext: CT, epoch: 1, takVersion: 9, pushArchive: { ct: ACT, takVersion: 5 } }),
      { params: params() },
    );
    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    const values = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(values).sort()).toEqual([
      'ciphertext',
      'epoch',
      'isAI',
      'takVersion',
      'topicId',
      'type',
      'userId',
    ]);
    // `takVersion` here is the MESSAGE column (9), not the preview's version (5).
    expect(values.takVersion).toBe(9);
    expect(JSON.stringify(values)).not.toContain(ACT);
  });

  it('is never echoed back to the client or broadcast over Redis', async () => {
    const res = await POST(
      req({ ciphertext: CT, epoch: 0, pushArchive: { ct: ACT, takVersion: 5 } }),
      { params: params() },
    );
    expect(JSON.stringify(await res.json())).not.toContain(ACT);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish.mock.calls[0][1]).not.toContain(ACT);
  });

  it('content-free mode ignores it entirely (dummy dispatch, no ciphertext path)', async () => {
    mocks.pushMode.mockReturnValue('content-free');
    const res = await POST(
      req({ ciphertext: CT, epoch: 0, pushArchive: { ct: ACT, takVersion: 5 } }),
      { params: params() },
    );
    expect(res.status).toBe(201);
    expect(mocks.dispatchCiphertext).not.toHaveBeenCalled();
    expect(mocks.dispatchDummy).toHaveBeenCalledTimes(1);
  });

  it('a push dispatch rejection never breaks the 201 (fire-and-forget)', async () => {
    mocks.dispatchCiphertext.mockImplementationOnce(() => Promise.reject(new Error('APNs down')));
    const res = await POST(
      req({ ciphertext: CT, epoch: 0, pushArchive: { ct: ACT, takVersion: 5 } }),
      { params: params() },
    );
    expect(res.status).toBe(201);
  });

  it('even a SYNCHRONOUS push failure never breaks the 201', async () => {
    mocks.dispatchCiphertext.mockImplementationOnce(() => {
      throw new Error('push exploded before awaiting');
    });
    const res = await POST(
      req({ ciphertext: CT, epoch: 0, pushArchive: { ct: ACT, takVersion: 5 } }),
      { params: params() },
    );
    expect(res.status).toBe(201);
  });
});

describe('POST chat — authz is unaffected by pushArchive', () => {
  it('401 when unauthenticated, with no dispatch', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await POST(
      req({ ciphertext: CT, epoch: 0, pushArchive: { ct: ACT, takVersion: 0 } }),
      { params: params() },
    );
    expect(res.status).toBe(401);
    expect(mocks.dispatchCiphertext).not.toHaveBeenCalled();
  });

  it('403 for a non-member, with no dispatch', async () => {
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    const res = await POST(
      req({ ciphertext: CT, epoch: 0, pushArchive: { ct: ACT, takVersion: 0 } }),
      { params: params() },
    );
    expect(res.status).toBe(403);
    expect(mocks.dispatchCiphertext).not.toHaveBeenCalled();
  });

  it('a valid pushArchive cannot rescue an invalid ciphertext (still 400)', async () => {
    const res = await POST(
      req({ ciphertext: 'not base64!!', epoch: 0, pushArchive: { ct: ACT, takVersion: 0 } }),
      { params: params() },
    );
    expect(res.status).toBe(400);
    expect(mocks.dispatchCiphertext).not.toHaveBeenCalled();
  });
});
