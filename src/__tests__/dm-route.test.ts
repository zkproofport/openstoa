import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canonicalDmPair } from '@/lib/dm';

/**
 * Unit tests for the DM (1:1 direct chat) model, P-D. Covers the synchronous
 * edge-case matrix rows the /api/dm route enforces: authz (guest 401), boundary
 * (self 400, non-existent peer 404), idempotency (same topicId for either order
 * of the pair), the isAI capability gate (chat/send on POST, chat/read on GET),
 * and SI-1 (the GET list carries only routing metadata — no message content).
 * The full two-agent E2EE round-trip + listing-exclusion + real-DB idempotency
 * live in the Docker E2E suite (src/__tests__/e2e/dm.test.ts).
 */

const human = { userId: 'alice', nickname: 'alice', isAI: false };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  usersFindFirst: vi.fn(),
  topicsFindFirst: vi.fn(),
  insertReturning: vi.fn(),
  selectRows: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: {
    query: {
      users: { findFirst: mocks.usersFindFirst },
      topics: { findFirst: mocks.topicsFindFirst },
      // requireAiCapability's DB path (only hit when isAI has no apiKeyCmd).
      aiPermissions: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        // topics insert path: .onConflictDoNothing({target}).returning({id})
        onConflictDoNothing: vi.fn(() => ({ returning: async () => mocks.insertReturning() })),
      })),
    })),
    // GET list path: db.select({...}).from(...).innerJoin(...).where(...) → rows
    select: vi.fn(() => ({
      from: () => ({ innerJoin: () => ({ where: async () => mocks.selectRows() }) }),
    })),
  },
}));

import { POST, GET } from '@/app/api/dm/route';

function post(body: unknown) {
  return { json: async () => body, url: 'http://x/api/dm', cookies: { get: () => undefined }, headers: { get: () => null } } as never;
}
function get() {
  return { url: 'http://x/api/dm', cookies: { get: () => undefined }, headers: { get: () => null } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(human);
  mocks.usersFindFirst.mockResolvedValue({ id: 'bob', nickname: 'bob' });
  mocks.topicsFindFirst.mockResolvedValue(undefined);
  mocks.insertReturning.mockResolvedValue([{ id: 'dm-topic-1' }]);
  mocks.selectRows.mockResolvedValue([]);
});

describe('canonicalDmPair — idempotency / order-independence', () => {
  it('is symmetric regardless of argument order', () => {
    expect(canonicalDmPair('alice', 'bob')).toBe(canonicalDmPair('bob', 'alice'));
  });
  it('produces a stable |-joined canonical form', () => {
    expect(canonicalDmPair('bob', 'alice')).toBe('alice|bob');
  });
});

describe('POST /api/dm — authz / boundary', () => {
  it('401 when unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await POST(post({ userId: 'bob' }))).status).toBe(401);
  });

  it('400 when userId missing', async () => {
    expect((await POST(post({}))).status).toBe(400);
  });

  it('400 when starting a DM with yourself', async () => {
    const res = await POST(post({ userId: 'alice' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/yourself/i);
  });

  it('404 when the target user does not exist', async () => {
    mocks.usersFindFirst.mockResolvedValue(undefined);
    const res = await POST(post({ userId: 'ghost' }));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/dm — idempotency', () => {
  it('200 returns the existing topicId when a DM already exists', async () => {
    mocks.topicsFindFirst.mockResolvedValue({ id: 'existing-dm' });
    const res = await POST(post({ userId: 'bob' }));
    expect(res.status).toBe(200);
    expect((await res.json()).topicId).toBe('existing-dm');
  });

  it('201 creates a new hidden DM topic on first start', async () => {
    const res = await POST(post({ userId: 'bob' }));
    expect(res.status).toBe(201);
    expect((await res.json()).topicId).toBe('dm-topic-1');
  });

  it('200 returns the race winner when the insert conflicts', async () => {
    // Lost the unique-index race: returning() is empty, re-read finds the winner.
    mocks.insertReturning.mockResolvedValue([]);
    mocks.topicsFindFirst
      .mockResolvedValueOnce(undefined) // first existence check: none yet
      .mockResolvedValueOnce({ id: 'race-winner' }); // post-conflict re-read
    const res = await POST(post({ userId: 'bob' }));
    expect(res.status).toBe(200);
    expect((await res.json()).topicId).toBe('race-winner');
  });
});

describe('POST /api/dm — isAI capability gate', () => {
  it('403 when an isAI key lacks chat/send', async () => {
    mocks.getSession.mockResolvedValue({ userId: 'ai', nickname: 'ai', isAI: true, apiKeyCmd: [] });
    const res = await POST(post({ userId: 'bob' }));
    expect(res.status).toBe(403);
  });

  it('201 when an isAI key holds chat/send', async () => {
    mocks.getSession.mockResolvedValue({ userId: 'ai', nickname: 'ai', isAI: true, apiKeyCmd: ['/openstoa/chat/send'] });
    const res = await POST(post({ userId: 'bob' }));
    expect(res.status).toBe(201);
  });
});

describe('GET /api/dm — capability gate + SI-1', () => {
  it('401 when unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await GET(get())).status).toBe(401);
  });

  it('403 when an isAI key lacks chat/read', async () => {
    mocks.getSession.mockResolvedValue({ userId: 'ai', nickname: 'ai', isAI: true, apiKeyCmd: [] });
    expect((await GET(get())).status).toBe(403);
  });

  it('200 with an empty list when the caller has no DMs', async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect((await res.json()).dms).toEqual([]);
  });

  it('SI-1: list rows expose only routing metadata, never message content', async () => {
    // First select = myDms (one channel); second select = peer metadata.
    mocks.selectRows
      .mockResolvedValueOnce([{ topicId: 't1', lastActivityAt: new Date('2026-01-01T00:00:00Z') }])
      .mockResolvedValueOnce([{ topicId: 't1', peerId: 'bob', nickname: 'bob', profileImage: null }]);
    const res = await GET(get());
    const body = await res.json();
    expect(body.dms).toHaveLength(1);
    expect(body.dms[0]).toEqual({
      topicId: 't1',
      peer: { userId: 'bob', nickname: 'bob', profileImage: null },
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    // No message / ciphertext / preview field must ever appear.
    expect(JSON.stringify(body)).not.toMatch(/ciphertext|message|sealed|preview/i);
  });
});
