import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Phase 1 ciphertext-routing unit tests for POST /api/topics/[topicId]/chat.
 * Covers the edge-case matrix rows the route enforces synchronously:
 * authz, hostile (plaintext injection / bad base64), empty, boundary
 * (size cap), epoch/takVersion validation, UTF-8 round-trip, and the
 * publish contract. GET mapping + SSE fan-out are covered by E2E (Docker).
 */

const session = { userId: 'u1', nickname: 'alice', isAI: false };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  publish: vi.fn().mockResolvedValue(1),
  topicMembersFindFirst: vi.fn(),
  usersFindFirst: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/redis', () => ({ getRedis: () => ({ publish: mocks.publish }) }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: {
    query: {
      topicMembers: { findFirst: mocks.topicMembersFindFirst },
      users: { findFirst: mocks.usersFindFirst },
      chatMessages: { findFirst: vi.fn() },
    },
    // Echo the inserted values back so the response payload reflects what
    // was stored — lets us assert the server round-trips ciphertext verbatim.
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
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
      }),
    }),
  },
}));

import { POST } from '@/app/api/topics/[topicId]/chat/route';

const TOPIC = '00000000-0000-0000-0000-000000000001';

function req(body: unknown) {
  return { json: async () => body, url: `http://x/api/topics/${TOPIC}/chat` } as never;
}
const params = () => Promise.resolve({ topicId: TOPIC });
const b64 = (s: string | Buffer) => Buffer.from(s as never).toString('base64');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(session);
  mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: 'u1' });
  mocks.usersFindFirst.mockResolvedValue({ nickname: 'alice', profileImage: null });
});

describe('POST chat — authz', () => {
  it('401 when unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await POST(req({ ciphertext: b64('x'), epoch: 0 }), { params: params() });
    expect(res.status).toBe(401);
  });

  it('403 when not a member', async () => {
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    const res = await POST(req({ ciphertext: b64('x'), epoch: 0 }), { params: params() });
    expect(res.status).toBe(403);
  });
});

describe('POST chat — hostile / SI-1 plaintext rejection', () => {
  it('400 rejects a plaintext message field outright', async () => {
    const res = await POST(req({ message: 'hello', ciphertext: b64('x'), epoch: 0 }), { params: params() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/plaintext/i);
  });

  it('400 rejects a plaintext message even with no ciphertext', async () => {
    const res = await POST(req({ message: 'hello' }), { params: params() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/plaintext/i);
  });

  it('400 on non-JSON / non-object body', async () => {
    const res = await POST(req(null), { params: params() });
    expect(res.status).toBe(400);
  });

  it('400 on non-base64 ciphertext', async () => {
    const res = await POST(req({ ciphertext: 'not valid!!', epoch: 0 }), { params: params() });
    expect(res.status).toBe(400);
  });

  it('400 on base64 with embedded whitespace/newline', async () => {
    const res = await POST(req({ ciphertext: 'aGVs bG8=', epoch: 0 }), { params: params() });
    expect(res.status).toBe(400);
  });
});

describe('POST chat — empty / boundary', () => {
  it('400 when ciphertext missing', async () => {
    const res = await POST(req({ epoch: 0 }), { params: params() });
    expect(res.status).toBe(400);
  });

  it('400 when ciphertext is empty string', async () => {
    const res = await POST(req({ ciphertext: '', epoch: 0 }), { params: params() });
    expect(res.status).toBe(400);
  });

  it('201 at 1 byte (lower boundary)', async () => {
    const res = await POST(req({ ciphertext: b64(Buffer.alloc(1, 7)), epoch: 0 }), { params: params() });
    expect(res.status).toBe(201);
  });

  it('201 at exactly 4096 bytes (max boundary)', async () => {
    const res = await POST(req({ ciphertext: b64(Buffer.alloc(4096, 1)), epoch: 0 }), { params: params() });
    expect(res.status).toBe(201);
  });

  it('400 at 4097 bytes (max+1)', async () => {
    const res = await POST(req({ ciphertext: b64(Buffer.alloc(4097, 1)), epoch: 0 }), { params: params() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/4096/);
  });
});

describe('POST chat — epoch / takVersion validation', () => {
  it('400 when epoch missing', async () => {
    const res = await POST(req({ ciphertext: b64('x') }), { params: params() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/epoch/);
  });

  it('400 on negative epoch', async () => {
    expect((await POST(req({ ciphertext: b64('x'), epoch: -1 }), { params: params() })).status).toBe(400);
  });

  it('400 on non-integer epoch', async () => {
    expect((await POST(req({ ciphertext: b64('x'), epoch: 1.5 }), { params: params() })).status).toBe(400);
  });

  it('400 on non-numeric epoch', async () => {
    expect((await POST(req({ ciphertext: b64('x'), epoch: 'x' }), { params: params() })).status).toBe(400);
  });

  it('201 at epoch 0 (placeholder)', async () => {
    expect((await POST(req({ ciphertext: b64('x'), epoch: 0 }), { params: params() })).status).toBe(201);
  });

  it('400 on negative takVersion', async () => {
    const res = await POST(req({ ciphertext: b64('x'), epoch: 0, takVersion: -1 }), { params: params() });
    expect(res.status).toBe(400);
  });

  it('201 with a valid takVersion', async () => {
    const res = await POST(req({ ciphertext: b64('x'), epoch: 0, takVersion: 3 }), { params: params() });
    expect(res.status).toBe(201);
    expect((await res.json()).message.sealed.takVersion).toBe(3);
  });
});

describe('POST chat — happy path, contract, integrity', () => {
  it('201 returns a sealed payload with null plaintext message', async () => {
    const ct = b64('sealed-bytes');
    const res = await POST(req({ ciphertext: ct, epoch: 0 }), { params: params() });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message.type).toBe('message');
    expect(body.message.message).toBeNull();
    expect(body.message.sealed.ciphertext).toBe(ct);
    expect(body.message.sealed.epoch).toBe(0);
  });

  it('contract: publishes the sealed payload to chat:topic:{id}', async () => {
    const ct = b64('sealed-bytes');
    await POST(req({ ciphertext: ct, epoch: 0 }), { params: params() });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = mocks.publish.mock.calls[0];
    expect(channel).toBe(`chat:topic:${TOPIC}`);
    const parsed = JSON.parse(raw);
    expect(parsed.event).toBe('message');
    expect(parsed.data.sealed.ciphertext).toBe(ct);
    // SI-1: the broadcast must not carry any plaintext message body.
    expect(parsed.data.message).toBeNull();
  });

  it('integrity: ciphertext of UTF-8 bytes round-trips verbatim', async () => {
    const ct = b64(Buffer.from('안녕하세요 🌟\t\n', 'utf8'));
    const res = await POST(req({ ciphertext: ct, epoch: 2 }), { params: params() });
    const body = await res.json();
    expect(body.message.sealed.ciphertext).toBe(ct);
    expect(body.message.sealed.epoch).toBe(2);
  });
});
