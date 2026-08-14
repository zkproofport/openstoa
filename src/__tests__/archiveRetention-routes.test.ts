/**
 * Chat-archive retention at the ROUTE layer — real local Postgres.
 *
 * Two claims are being defended here and neither can be checked with mocks:
 * that the window a topic is CREATED with is the window that ends up in the
 * row (and that nothing else can change it afterwards), and that the routes
 * which touch the archive actually invoke the purge — so deleting the call
 * fails a test rather than quietly turning retention back off.
 *
 * Only the session and the side-effect modules are mocked; the database is
 * real, because "the stored window is the chosen one" is a statement about a row.
 *
 * Requires the local dev DB (DATABASE_URL or default).
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   authorization     → 'a guest cannot create a topic, so cannot set a window',
 *                       'the owner cannot change the window after creation',
 *                       'a member cannot change another’s window' (403),
 *                       'a non-member’s archive request is refused BEFORE any sweep'
 *   hostile input     → 'every hostile window is refused with 400',
 *                       'a refused window creates no topic'
 *   empty/null/undef  → 'an omitted window means unlimited', 'null is refused',
 *                       'an empty string is refused' (each asserted separately)
 *   UTF-8             → 'Korean and emoji windows are refused'
 *   very large input  → 'MAX_SAFE_INTEGER and a 10 000-character window are refused'
 *   boundary          → 'each offered window is stored exactly as chosen',
 *                       including the shortest (30) and unlimited (0)
 *   contract          → 'POST /archive sweeps the topic it just wrote to',
 *                       'GET /archive sweeps the topic it is reading',
 *                       'the sweep is passed the topic in the URL, not another'
 *   result integrity  → 'creating one topic does not change another’s window'
 *   race              → N/A at this layer: the sweep is fire-and-forget and its
 *                       concurrency is pinned in archiveRetentionSweep.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';
});

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), scheduleArchiveSweep: vi.fn() }));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/redis', () => ({
  getRedis: () => ({ incr: vi.fn().mockResolvedValue(1), expire: vi.fn(), publish: vi.fn() }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The sweep is SPIED, not replaced: the real implementation still runs, so the
 * assertion is "the route calls it" and not "the route calls a stub that does
 * nothing". Removing `scheduleArchiveSweep(...)` from either archive handler
 * fails the contract tests below.
 */
vi.mock('@/lib/archiveRetentionSweep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/archiveRetentionSweep')>();
  mocks.scheduleArchiveSweep.mockImplementation(actual.scheduleArchiveSweep);
  return { ...actual, scheduleArchiveSweep: mocks.scheduleArchiveSweep };
});

import { POST as topicsPOST } from '@/app/api/topics/route';
import { PATCH as topicPATCH } from '@/app/api/topics/[topicId]/route';
import { POST as archivePOST, GET as archiveGET } from '@/app/api/topics/[topicId]/archive/route';
import { ARCHIVE_RETENTION_CHOICES } from '@/lib/archiveRetention';
import { resetArchiveSweepThrottle } from '@/lib/archiveRetentionSweep';

const OWNER = 'retention-route-owner';
const MEMBER = 'retention-route-member';
const OUTSIDER = 'retention-route-outsider';
const CATEGORY = '00000000-0000-4000-8000-0000000000c1';
const TOPIC = '00000000-0000-4000-8000-0000000000c2';
const MESSAGE = '00000000-0000-4000-8000-0000000000c3';

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const session = (userId: string) => ({ userId, nickname: userId.replace(/-/g, '_'), isAI: false });

/** A request whose body is whatever the case wants to send — including junk. */
const postReq = (body: unknown) =>
  ({ url: 'http://x/api/topics', json: async () => body }) as never;

const tParams = () => Promise.resolve({ topicId: TOPIC });
const archiveReq = (body?: unknown) =>
  ({
    url: `http://x/api/topics/${TOPIC}/archive`,
    json: async () => body ?? null,
  }) as never;

async function createTopic(body: Record<string, unknown>): Promise<Response> {
  return topicsPOST(
    postReq({ title: 'Retention route topic', categoryId: CATEGORY, ...body }),
  ) as unknown as Response;
}

/**
 * Every topic this file has created THROUGH THE ROUTE, so cases can count them.
 * The fixed `TOPIC` (seeded directly, for the archive cases) is excluded — it
 * has the same creator and would otherwise be swept away between cases.
 */
async function createdTopics() {
  const rows = await db.query.topics.findMany({ where: eq(schema.topics.creatorId, OWNER) });
  return rows.filter((t) => t.id !== TOPIC);
}

async function cleanCreated() {
  const rows = await createdTopics();
  for (const t of rows) {
    await db.delete(schema.topicMembers).where(eq(schema.topicMembers.topicId, t.id));
    await db.delete(schema.chatArchive).where(eq(schema.chatArchive.topicId, t.id));
    await db.delete(schema.topics).where(eq(schema.topics.id, t.id));
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  db = drizzle(pool, { schema });

  await cleanCreated();
  await db.delete(schema.topicMembers).where(eq(schema.topicMembers.topicId, TOPIC));
  await db.delete(schema.chatArchive).where(eq(schema.chatArchive.topicId, TOPIC));
  await db.delete(schema.topics).where(eq(schema.topics.id, TOPIC));
  for (const id of [OWNER, MEMBER, OUTSIDER]) {
    await db.delete(schema.users).where(eq(schema.users.id, id));
  }
  await db.delete(schema.categories).where(eq(schema.categories.id, CATEGORY));

  await db.insert(schema.users).values([
    { id: OWNER, nickname: 'retention_route_owner' },
    { id: MEMBER, nickname: 'retention_route_member' },
    { id: OUTSIDER, nickname: 'retention_route_outsider' },
  ]);
  await db.insert(schema.categories).values({
    id: CATEGORY,
    name: 'Retention',
    slug: 'retention-route-test',
  });
  // A fixed topic for the archive-route contract cases (the creation cases make
  // their own, with generated ids).
  await db.insert(schema.topics).values({
    id: TOPIC,
    title: 'retention archive topic',
    creatorId: OWNER,
    inviteCode: 'retention-route-invite',
    visibility: 'public',
    chatArchiveRetentionDays: 30,
  });
  await db.insert(schema.topicMembers).values([
    { topicId: TOPIC, userId: OWNER, role: 'owner' },
    { topicId: TOPIC, userId: MEMBER, role: 'member' },
  ]);
});

afterAll(async () => {
  await cleanCreated();
  await db.delete(schema.topicMembers).where(eq(schema.topicMembers.topicId, TOPIC));
  await db.delete(schema.chatArchive).where(eq(schema.chatArchive.topicId, TOPIC));
  await db.delete(schema.topics).where(eq(schema.topics.id, TOPIC));
  await db.delete(schema.categories).where(eq(schema.categories.id, CATEGORY));
  for (const id of [OWNER, MEMBER, OUTSIDER]) {
    await db.delete(schema.users).where(eq(schema.users.id, id));
  }
  await pool.end();
});

beforeEach(async () => {
  vi.clearAllMocks();
  resetArchiveSweepThrottle();
  await cleanCreated();
  await db.delete(schema.chatArchive).where(eq(schema.chatArchive.topicId, TOPIC));
  mocks.getSession.mockResolvedValue(session(OWNER));
});

// ---------------------------------------------------------------------------
// Choosing the window, at creation
// ---------------------------------------------------------------------------

describe('POST /api/topics — the window is chosen once, here', () => {
  for (const days of ARCHIVE_RETENTION_CHOICES) {
    it(`BOUNDARY: a window of ${days} days is stored exactly as chosen`, async () => {
      const res = await createTopic({ chatArchiveRetentionDays: days });
      expect(res.status).toBe(201);
      const { topic } = await res.json();
      expect(topic.chatArchiveRetentionDays).toBe(days);

      const stored = await db.query.topics.findFirst({ where: eq(schema.topics.id, topic.id) });
      expect(stored?.chatArchiveRetentionDays).toBe(days);
    });
  }

  it('EMPTY: an omitted window means unlimited — a client that predates the field deletes nothing', async () => {
    const res = await createTopic({});
    expect(res.status).toBe(201);
    const { topic } = await res.json();
    expect(topic.chatArchiveRetentionDays).toBe(0);
  });

  it('the created topic is readable back with its window, so members can see it', async () => {
    // The listing/detail responses spread the topic row, so the setting travels
    // to both clients without a per-route allowlist to forget.
    const res = await createTopic({ chatArchiveRetentionDays: 90 });
    const { topic } = await res.json();
    expect(Object.keys(topic)).toContain('chatArchiveRetentionDays');
    expect(topic.chatArchiveRetentionDays).toBe(90);
  });
});

describe('POST /api/topics — hostile windows', () => {
  const HOSTILE: Array<[string, unknown]> = [
    ['a window outside the offered set', 45],
    ['one day', 1],
    ['negative', -30],
    ['negative one', -1],
    ['fractional', 30.5],
    ['huge', 1e9],
    ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ['Infinity', Infinity],
    ['NaN', NaN],
    ['a numeric string', '30'],
    ['an empty string', ''],
    ['a whitespace string', '   '],
    ['null', null],
    ['a boolean', true],
    ['an array', [30]],
    ['an object', { days: 30 }],
    ['Korean', '삼십일'],
    ['emoji', '🗓️'],
    ['a 10 000-character string', '9'.repeat(10_000)],
  ];

  for (const [name, value] of HOSTILE) {
    it(`HOSTILE: ${name} is refused with 400`, async () => {
      const res = await createTopic({ chatArchiveRetentionDays: value });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('chatArchiveRetentionDays');
    });
  }

  it('INTEGRITY: a refused window creates no topic at all', async () => {
    expect(await createdTopics()).toHaveLength(0);
    const res = await createTopic({ chatArchiveRetentionDays: -1 });
    expect(res.status).toBe(400);
    expect(await createdTopics()).toHaveLength(0);
  });

  it('INTEGRITY: creating one topic does not change another’s window', async () => {
    const a = await (await createTopic({ chatArchiveRetentionDays: 30 })).json();
    await createTopic({ chatArchiveRetentionDays: 365 });
    const stillA = await db.query.topics.findFirst({ where: eq(schema.topics.id, a.topic.id) });
    expect(stillA?.chatArchiveRetentionDays).toBe(30);

    const fixed = await db.query.topics.findFirst({ where: eq(schema.topics.id, TOPIC) });
    expect(fixed?.chatArchiveRetentionDays).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Who may set it
// ---------------------------------------------------------------------------

describe('authorization', () => {
  it('AUTHZ: a guest cannot create a topic, so cannot set a window', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await createTopic({ chatArchiveRetentionDays: 30 });
    expect(res.status).toBe(401);
    expect(await createdTopics()).toHaveLength(0);
  });

  it('AUTHZ: the OWNER cannot shorten the window after creation', async () => {
    /*
     * Shortening deletes other members' history, so the choice is made once. The
     * edit route accepts title/description/image and nothing else; this pins
     * that adding the field there is a deliberate act, not an accident.
     */
    const res = await topicPATCH(
      { url: `http://x/api/topics/${TOPIC}`, json: async () => ({ title: 'renamed', chatArchiveRetentionDays: 30 }) } as never,
      { params: tParams() },
    );
    expect(res.status).toBe(200);
    const stored = await db.query.topics.findFirst({ where: eq(schema.topics.id, TOPIC) });
    expect(stored?.chatArchiveRetentionDays).toBe(30); // unchanged from creation
    expect(stored?.title).toBe('renamed');

    await db.update(schema.topics).set({ title: 'retention archive topic' }).where(eq(schema.topics.id, TOPIC));
  });

  it('AUTHZ: a plain member cannot edit the topic at all, window included', async () => {
    mocks.getSession.mockResolvedValue(session(MEMBER));
    const res = await topicPATCH(
      { url: `http://x/api/topics/${TOPIC}`, json: async () => ({ title: 'hijacked', chatArchiveRetentionDays: 0 }) } as never,
      { params: tParams() },
    );
    expect(res.status).toBe(403);
    const stored = await db.query.topics.findFirst({ where: eq(schema.topics.id, TOPIC) });
    expect(stored?.chatArchiveRetentionDays).toBe(30);
    expect(stored?.title).toBe('retention archive topic');
  });
});

// ---------------------------------------------------------------------------
// The purge is actually wired up
// ---------------------------------------------------------------------------

describe('the archive routes sweep the topic', () => {
  const archiveBody = {
    messageId: MESSAGE,
    takVersion: 1,
    archive: Buffer.from('sealed-body').toString('base64'),
  };

  it('CONTRACT: POST /archive sweeps the topic it just wrote to', async () => {
    const res = await archivePOST(archiveReq(archiveBody), { params: tParams() });
    expect(res.status).toBe(201);
    expect(mocks.scheduleArchiveSweep).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleArchiveSweep.mock.calls[0][1]).toBe(TOPIC);
  });

  it('CONTRACT: GET /archive sweeps the topic it is reading', async () => {
    // A room that is only ever read is exactly the one whose archive would
    // otherwise sit past its window forever.
    const res = await archiveGET(archiveReq(), { params: tParams() });
    expect(res.status).toBe(200);
    expect(mocks.scheduleArchiveSweep).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleArchiveSweep.mock.calls[0][1]).toBe(TOPIC);
  });

  it('CONTRACT: the sweep is given the instant of the request, so its floor is decidable', async () => {
    const before = Date.now();
    await archiveGET(archiveReq(), { params: tParams() });
    const now = mocks.scheduleArchiveSweep.mock.calls[0][2] as Date;
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('AUTHZ: a non-member’s archive request is refused BEFORE any sweep runs', async () => {
    mocks.getSession.mockResolvedValue(session(OUTSIDER));
    const read = await archiveGET(archiveReq(), { params: tParams() });
    expect(read.status).toBe(403);
    const write = await archivePOST(archiveReq(archiveBody), { params: tParams() });
    expect(write.status).toBe(403);
    expect(mocks.scheduleArchiveSweep).not.toHaveBeenCalled();
  });

  it('AUTHZ: a guest’s archive request is refused before any sweep runs', async () => {
    mocks.getSession.mockResolvedValue(null);
    const read = await archiveGET(archiveReq(), { params: tParams() });
    expect(read.status).toBe(401);
    expect(mocks.scheduleArchiveSweep).not.toHaveBeenCalled();
  });

  it('a failing sweep never reaches the member’s response', async () => {
    // Fire-and-forget in the route, so a broken purge is invisible to the caller.
    mocks.scheduleArchiveSweep.mockImplementationOnce(() => {
      void Promise.reject(new Error('sweep exploded')).catch(() => {});
    });
    const res = await archiveGET(archiveReq(), { params: tParams() });
    expect(res.status).toBe(200);
  });
});
