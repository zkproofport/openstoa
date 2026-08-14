/**
 * Who gets in, and what they can read — at the ROUTE layer, real local Postgres.
 *
 * The tier model rests on one distinction: in a `private` topic the POSTS are
 * open to anyone signed in, and the CHAT is not. Membership buys the
 * conversation, not the reading. This file is where that is enforced rather
 * than described, because every other statement of it — the design doc, the
 * creation screen, `/docs/tiers` — is downstream copy that can drift.
 *
 * It also pins the removal of the approval flow: `private` is invite-only, and
 * `POST /api/topics/{id}/join` no longer mints join requests. Requests created
 * before that change are deliberately LEFT approvable, so an owner can drain
 * the queue instead of finding people silently stranded.
 *
 * Only the session and the side-effect modules are mocked; the database is
 * real, because "a signed-in stranger can read this and not that" is a property
 * of the SQL and the branch, not of a function call.
 *
 * Requires the local dev DB (DATABASE_URL or default).
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   authorization     → guest / signed-in non-member / member / owner across
 *                       public, private, secret, for join, post list, post
 *                       detail, post write and chat
 *   contract          → 'no join request is created any more', 'a pending
 *                       request is left approvable', 'private CHAT stays 403'
 *   hostile input     → 'an unrecognised visibility fails CLOSED at join'
 *   boundary          → 'already a member' (409), 'topic not found' (404)
 *   result integrity  → 'a refused join creates no membership row', 'reading a
 *                       private topic never leaks a secret one'
 *   empty/null/undef  → N/A at this layer: visibility is a NOT NULL column with
 *                       a default; the unrecognised-value case above covers the
 *                       only shape that can reach the branch.
 *   UTF-8 / large     → N/A: no free text on these paths.
 *   race              → N/A: covered where it exists (membership insert) by the
 *                       pre-existing 409 path.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';
});

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
/*
 * A cache that answers "nothing cached" to everything. `mget` in particular has
 * to return one null PER KEY: the badge lookup zips its result against the key
 * list, and a bare `[]` silently becomes an undefined read further down — which
 * is how a missing method here surfaces as a 500 on a route that has nothing to
 * do with Redis.
 */
vi.mock('@/lib/redis', () => {
  const client = {
    get: vi.fn().mockResolvedValue(null),
    mget: vi.fn(async (...keys: string[]) => keys.map(() => null)),
    set: vi.fn().mockResolvedValue('OK'),
    ttl: vi.fn().mockResolvedValue(-1),
    del: vi.fn().mockResolvedValue(0),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn(),
    publish: vi.fn(),
  };
  // BOTH exports: the module exposes `getRedis()` and a `redis` proxy, and
  // different callers on these routes reach for different ones. Mocking only
  // one surfaces as a 500 on a route that has nothing to do with Redis.
  return { getRedis: () => client, redis: client };
})
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/push', () => ({
  dispatchDummyForMessage: vi.fn().mockResolvedValue(undefined),
  dispatchCiphertextForMessage: vi.fn().mockResolvedValue(undefined),
  getPushProvider: () => null,
  getPushMode: () => 'content-free',
}));
// The join route publishes a membership system message on success.
vi.mock('@/lib/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat')>();
  return { ...actual, broadcastMembershipSystemEvent: vi.fn().mockResolvedValue(undefined) };
});

import { POST as joinPOST } from '@/app/api/topics/[topicId]/join/route';
import { GET as postsGET, POST as postsPOST } from '@/app/api/topics/[topicId]/posts/route';
import { GET as postDetailGET } from '@/app/api/posts/[postId]/route';
import { GET as chatGET } from '@/app/api/topics/[topicId]/chat/route';

const OWNER = 'tier-access-owner';
const MEMBER = 'tier-access-member';
const STRANGER = 'tier-access-stranger';
const USERS = [OWNER, MEMBER, STRANGER];

const PUBLIC_T = '00000000-0000-4000-8000-0000000000a1';
const PRIVATE_T = '00000000-0000-4000-8000-0000000000a2';
const SECRET_T = '00000000-0000-4000-8000-0000000000a3';
const ODD_T = '00000000-0000-4000-8000-0000000000a4'; // visibility not in the enum
const TOPICS = [PUBLIC_T, PRIVATE_T, SECRET_T, ODD_T];

/** One post per topic, so the detail route has something to answer with. */
const POST_OF: Record<string, string> = {};

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const session = (userId: string) => ({ userId, nickname: userId.replace(/-/g, '_'), isAI: false });

const params = (topicId: string) => ({ params: Promise.resolve({ topicId }) });
const postParams = (postId: string) => ({ params: Promise.resolve({ postId }) });
const req = (url = 'http://x/', body?: unknown) =>
  ({ url, json: async () => body ?? {} }) as never;

async function memberCount(topicId: string): Promise<number> {
  const rows = await db.query.topicMembers.findMany({
    where: eq(schema.topicMembers.topicId, topicId),
  });
  return rows.length;
}

async function requestRows(topicId: string) {
  return db.query.joinRequests.findMany({ where: eq(schema.joinRequests.topicId, topicId) });
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  db = drizzle(pool, { schema });

  for (const t of TOPICS) {
    await db.delete(schema.joinRequests).where(eq(schema.joinRequests.topicId, t));
    await db.delete(schema.topicMembers).where(eq(schema.topicMembers.topicId, t));
    await db.delete(schema.posts).where(eq(schema.posts.topicId, t));
    await db.delete(schema.topics).where(eq(schema.topics.id, t));
  }
  for (const u of USERS) await db.delete(schema.users).where(eq(schema.users.id, u));

  await db.insert(schema.users).values(USERS.map((id) => ({ id, nickname: id.replace(/-/g, '_') })));
  await db.insert(schema.topics).values([
    { id: PUBLIC_T, title: 'public topic', creatorId: OWNER, inviteCode: 'tier-pub', visibility: 'public' },
    { id: PRIVATE_T, title: 'private topic', creatorId: OWNER, inviteCode: 'tier-priv', visibility: 'private' },
    { id: SECRET_T, title: 'secret topic', creatorId: OWNER, inviteCode: 'tier-sec', visibility: 'secret' },
    // A row whose visibility is none of the three. Only reachable through a bad
    // write or a future tier, and the point is that it must not instant-join.
    { id: ODD_T, title: 'odd topic', creatorId: OWNER, inviteCode: 'tier-odd', visibility: 'PRIVATE' },
  ]);
  for (const t of TOPICS) {
    await db.insert(schema.topicMembers).values([
      { topicId: t, userId: OWNER, role: 'owner' },
      { topicId: t, userId: MEMBER, role: 'member' },
    ]);
    const [row] = await db
      .insert(schema.posts)
      .values({ topicId: t, authorId: OWNER, title: `post in ${t}`, content: 'body' })
      .returning();
    POST_OF[t] = row.id;
  }
});

afterAll(async () => {
  for (const t of TOPICS) {
    await db.delete(schema.joinRequests).where(eq(schema.joinRequests.topicId, t));
    await db.delete(schema.topicMembers).where(eq(schema.topicMembers.topicId, t));
    await db.delete(schema.posts).where(eq(schema.posts.topicId, t));
    await db.delete(schema.topics).where(eq(schema.topics.id, t));
  }
  for (const u of USERS) await db.delete(schema.users).where(eq(schema.users.id, u));
  await pool.end();
});

beforeEach(async () => {
  vi.clearAllMocks();
  // The stranger is never a member at the start of a case.
  for (const t of TOPICS) {
    await db
      .delete(schema.topicMembers)
      .where(and(eq(schema.topicMembers.topicId, t), eq(schema.topicMembers.userId, STRANGER)));
    await db.delete(schema.joinRequests).where(eq(schema.joinRequests.topicId, t));
  }
  mocks.getSession.mockResolvedValue(session(STRANGER));
});

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

describe('POST /api/topics/{id}/join', () => {
  it('public: a signed-in stranger joins immediately', async () => {
    const res = await joinPOST(req(), params(PUBLIC_T));
    expect(res.status).toBe(201);
    expect(await memberCount(PUBLIC_T)).toBe(3);
  });

  it('CONTRACT: private is INVITE-ONLY — 403, and no join request is created', async () => {
    /*
     * The approval flow used to answer 202 here and insert a pending row. It is
     * gone: a private topic's invite link is what carries the chat-history
     * keys, so an approved member would arrive unable to read anything.
     */
    const res = await joinPOST(req(), params(PRIVATE_T));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/invite/i);
    expect(await requestRows(PRIVATE_T)).toHaveLength(0);
    expect(await memberCount(PRIVATE_T)).toBe(2); // unchanged
  });

  it('secret: 403, pointing at the invite route', async () => {
    const res = await joinPOST(req(), params(SECRET_T));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/invite/i);
    expect(await memberCount(SECRET_T)).toBe(2);
  });

  it('HOSTILE: an unrecognised visibility fails CLOSED, not into the public path', async () => {
    // Allowlist, not blocklist: only exactly 'public' instant-joins.
    const res = await joinPOST(req(), params(ODD_T));
    expect(res.status).toBe(403);
    expect(await memberCount(ODD_T)).toBe(2);
  });

  it('CONTRACT: a join request made BEFORE the change is left approvable, not stranded', async () => {
    /*
     * Nothing deletes these rows, and `GET`/`PATCH /requests` are unchanged, so
     * an owner can still drain the queue. The route simply stops adding to it.
     */
    await db.insert(schema.joinRequests).values({
      topicId: PRIVATE_T,
      userId: STRANGER,
      status: 'pending',
    });

    const res = await joinPOST(req(), params(PRIVATE_T));
    expect(res.status).toBe(403);

    const rows = await requestRows(PRIVATE_T);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending'); // untouched, still approvable
  });

  it('AUTHZ: a guest cannot join anything', async () => {
    mocks.getSession.mockResolvedValue(null);
    for (const t of TOPICS) {
      const res = await joinPOST(req(), params(t));
      expect(res.status, t).toBe(401);
    }
  });

  it('BOUNDARY: an existing member gets 409, not a duplicate row', async () => {
    mocks.getSession.mockResolvedValue(session(MEMBER));
    const res = await joinPOST(req(), params(PUBLIC_T));
    expect(res.status).toBe(409);
    expect(await memberCount(PUBLIC_T)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Reading posts
// ---------------------------------------------------------------------------

describe('GET posts — list and detail agree', () => {
  const listOf = (t: string) => postsGET(req(`http://x/api/topics/${t}/posts`), params(t));
  const detailOf = (t: string) => postDetailGET(req(), postParams(POST_OF[t]));

  it('AUTHZ: a signed-in stranger reads a PRIVATE topic’s posts — list and detail', async () => {
    // The change: membership buys the conversation, not the reading.
    expect((await listOf(PRIVATE_T)).status).toBe(200);
    expect((await detailOf(PRIVATE_T)).status).toBe(200);
  });

  it('AUTHZ: a signed-in stranger still cannot read a SECRET topic’s posts', async () => {
    expect((await listOf(SECRET_T)).status).toBe(403);
    expect((await detailOf(SECRET_T)).status).toBe(403);
  });

  it('AUTHZ: a signed-in stranger reads a public topic, as before', async () => {
    expect((await listOf(PUBLIC_T)).status).toBe(200);
    expect((await detailOf(PUBLIC_T)).status).toBe(200);
  });

  it('AUTHZ: a guest reads public only — private and secret both refuse', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await listOf(PUBLIC_T)).status).toBe(200);
    expect((await listOf(PRIVATE_T)).status).toBe(401);
    expect((await listOf(SECRET_T)).status).toBe(401);
    expect((await detailOf(PRIVATE_T)).status).toBe(401);
  });

  it('AUTHZ: a member reads every tier they belong to', async () => {
    mocks.getSession.mockResolvedValue(session(MEMBER));
    for (const t of TOPICS) {
      expect((await listOf(t)).status, t).toBe(200);
    }
  });

  it('HOSTILE: an unrecognised visibility is NOT treated as private', async () => {
    // Same fail-closed direction as the join branch.
    expect((await listOf(ODD_T)).status).toBe(403);
  });

  it('INTEGRITY: reading a private topic returns that topic’s posts, not another’s', async () => {
    const res = await listOf(PRIVATE_T);
    const body = await res.json();
    expect(Array.isArray(body.posts)).toBe(true);
    for (const p of body.posts) {
      expect(p.id).toBe(POST_OF[PRIVATE_T]);
    }
  });
});

describe('writing and chatting still require membership', () => {
  it('CONTRACT: a stranger cannot POST into a private topic they can read', async () => {
    const res = await postsPOST(
      req(`http://x/api/topics/${PRIVATE_T}/posts`, { title: 'hi', content: 'body' }),
      params(PRIVATE_T),
    );
    expect(res.status).toBe(403);
  });

  it('CONTRACT: a stranger cannot read a private topic’s CHAT — the whole point of the tier', async () => {
    /*
     * This is the assertion the tier model rests on. Posts opened up; the
     * conversation did not. If this ever returns 200, `private` has silently
     * become `public` for the one surface that is supposed to be members-only.
     */
    const res = await chatGET(req(`http://x/api/topics/${PRIVATE_T}/chat`), params(PRIVATE_T));
    expect(res.status).toBe(403);
  });

  it('CONTRACT: chat is members-only in EVERY tier, not just private', async () => {
    for (const t of TOPICS) {
      const res = await chatGET(req(`http://x/api/topics/${t}/chat`), params(t));
      expect(res.status, t).toBe(403);
    }
  });

  it('a member reads the chat of the private topic they belong to', async () => {
    mocks.getSession.mockResolvedValue(session(MEMBER));
    const res = await chatGET(req(`http://x/api/topics/${PRIVATE_T}/chat`), params(PRIVATE_T));
    expect(res.status).toBe(200);
  });
});
