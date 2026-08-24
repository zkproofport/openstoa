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
  readCursorRows: vi.fn(),
  unreadCountRows: vi.fn(),
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
    /*
     * TWO select shapes, and the fake REFUSES anything else.
     *
     *   .from(...).innerJoin(...).where(...) — the DM list's own two queries
     *   .from(...).where(...)                — `chatUnread.readStatesForTopics`
     *
     * Kept as separate mock queues rather than one, because collapsing them is
     * how the previous version broke: `readStatesForTopics` drew from
     * `selectRows` and consumed the peer-metadata row, and the list came back
     * empty for a reason nothing in the route was responsible for.
     */
    select: vi.fn(() => ({
      from: () => ({
        innerJoin: () => ({ where: async () => mocks.selectRows() }),
        where: async () => mocks.readCursorRows(),
      }),
    })),
    /*
     * The unread count is one grouped statement, not a query-builder chain.
     * `rows` is AWAITED: the real driver hands back a settled array, and a
     * fake that hands back a Promise is not lenient — it is a different shape,
     * and the route dies on it with "object is not iterable" rather than on
     * anything the route did.
     */
    execute: vi.fn(async () => ({ rows: await mocks.unreadCountRows() })),
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
  mocks.readCursorRows.mockResolvedValue([]);
  mocks.unreadCountRows.mockResolvedValue([]);
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
      // Read state, never read content: an id, an instant and a count. All
      // three are metadata the server already held.
      lastReadAt: null,
      lastReadMessageId: null,
      unreadCount: 0,
    });
    /*
     * Anchored at the KEY, not as a bare substring.
     *
     * `lastReadMessageId` contains "message" and is a message ID, not a
     * message — a substring test reads the two as the same thing and fails on
     * a field that carries no content. The guard exists to catch a body,
     * a preview or a ciphertext arriving in this response, so it looks for
     * those as JSON keys.
     */
    expect(JSON.stringify(body)).not.toMatch(/"(ciphertext|message|sealed|preview|systemText|body)"\s*:/i);
  });

  it('SI-1 guard bites: a body field would be caught by the key-anchored check', () => {
    // The guard above is only worth anything if it still fires. A field named
    // exactly `message` is what it exists to refuse.
    const leaky = JSON.stringify({ dms: [{ topicId: 't1', message: 'hello' }] });
    expect(leaky).toMatch(/"(ciphertext|message|sealed|preview|systemText|body)"\s*:/i);
  });

  it('CONTRACT: a stored cursor and count reach the row', async () => {
    // The other half of the same field: nulls above prove it is always present,
    // this proves it is actually populated from the read-state query.
    mocks.selectRows
      .mockResolvedValueOnce([{ topicId: 't1', lastActivityAt: new Date('2026-01-01T00:00:00Z') }])
      .mockResolvedValueOnce([{ topicId: 't1', peerId: 'bob', nickname: 'bob', profileImage: null }]);
    mocks.readCursorRows.mockResolvedValue([
      { topicId: 't1', lastReadAt: new Date('2026-01-02T00:00:00Z'), lastReadMessageId: 'm-1' },
    ]);
    mocks.unreadCountRows.mockResolvedValue([{ topic_id: 't1', unread: 4 }]);
    const body = await (await GET(get())).json();
    expect(body.dms[0].lastReadAt).toBe('2026-01-02T00:00:00.000Z');
    expect(body.dms[0].lastReadMessageId).toBe('m-1');
    expect(body.dms[0].unreadCount).toBe(4);
  });
});
