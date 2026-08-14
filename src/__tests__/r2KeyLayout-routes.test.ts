/**
 * The two routes that decide where an object lands and when it is removed —
 * real local Postgres, R2 itself stubbed.
 *
 * R2 is stubbed because this repo has no bucket credentials outside deploy, and
 * because what needs proving is not that Cloudflare deletes things: it is that
 * the SERVER asks it to delete the right prefix, and refuses to file an object
 * under a topic the caller has no business writing to.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   authorization     → 'a non-member cannot file an object under a topic',
 *                       'a guest cannot upload at all', 'a member can',
 *                       'only an owner/admin can trigger the sweep'
 *   hostile input     → 'a malformed topicId is refused, not downgraded',
 *                       'a topicId for a topic that does not exist is refused'
 *   result integrity  → 'deleting a topic sweeps ITS prefix and no other',
 *                       'the sweep prefix is the one the key builder produces'
 *   contract          → 'the sweep is actually invoked' (spy — removing the
 *                       call fails), 'a failed sweep still deletes the topic'
 *   empty/null/undef  → 'an absent topicId uploads under the user, no 400'
 *   boundary          → 'a topic with no objects still answers 200'
 *   UTF-8 / large     → covered at the key layer (r2KeyLayout.test.ts); the
 *                       route adds no text handling of its own.
 *   race              → N/A: the sweep runs after the transaction commits and
 *                       is idempotent (prefix delete of an empty prefix).
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

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  uploadToR2: vi.fn(),
  deleteR2Prefix: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/redis', () => {
  const client = {
    get: vi.fn().mockResolvedValue(null),
    mget: vi.fn(async (...keys: string[]) => keys.map(() => null)),
    set: vi.fn(),
    ttl: vi.fn().mockResolvedValue(-1),
    del: vi.fn(),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn(),
    publish: vi.fn(),
  };
  return { getRedis: () => client, redis: client };
});

/*
 * Only the two functions that talk to Cloudflare are replaced. The key BUILDERS
 * stay real, so the assertion "the sweep prefix is the one the key builder
 * produces" is about the shipped code and not about the mock agreeing with
 * itself.
 */
vi.mock('@/lib/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/r2')>();
  return {
    ...actual,
    uploadToR2: mocks.uploadToR2,
    deleteR2Prefix: mocks.deleteR2Prefix,
  };
});

import { POST as uploadPOST } from '@/app/api/upload/route';
import { DELETE as topicDELETE } from '@/app/api/topics/[topicId]/route';
import { topicObjectPrefix, uploadObjectKey } from '@/lib/r2';

const OWNER = 'r2-layout-owner';
const MEMBER = 'r2-layout-member';
const STRANGER = 'r2-layout-stranger';
const USERS = [OWNER, MEMBER, STRANGER];

const TOPIC = '00000000-0000-4000-8000-0000000000b1';
const NEIGHBOUR = '00000000-0000-4000-8000-0000000000b2';
const TOPICS = [TOPIC, NEIGHBOUR];

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const session = (userId: string) => ({ userId, nickname: userId.replace(/-/g, '_'), isAI: false });

/** A multipart request the route can read, without a real network stack. */
function uploadReq(fields: Record<string, string>, file = true) {
  const fd = new FormData();
  if (file) fd.append('file', new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' }));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return { url: 'http://x/api/upload', formData: async () => fd } as never;
}

const deleteReq = () => ({ url: 'http://x/', json: async () => ({}) }) as never;
const params = (topicId: string) => ({ params: Promise.resolve({ topicId }) });

async function seedTopics() {
  await db.insert(schema.topics).values([
    { id: TOPIC, title: 'layout topic', creatorId: OWNER, inviteCode: 'r2-layout-a', visibility: 'public' },
    { id: NEIGHBOUR, title: 'neighbour topic', creatorId: OWNER, inviteCode: 'r2-layout-b', visibility: 'public' },
  ]);
  for (const t of TOPICS) {
    await db.insert(schema.topicMembers).values([
      { topicId: t, userId: OWNER, role: 'owner' },
      { topicId: t, userId: MEMBER, role: 'member' },
    ]);
  }
}

async function clean() {
  for (const t of TOPICS) {
    await db.delete(schema.chatMedia).where(eq(schema.chatMedia.topicId, t)).catch(() => {});
    await db.delete(schema.chatMessages).where(eq(schema.chatMessages.topicId, t));
    await db.delete(schema.joinRequests).where(eq(schema.joinRequests.topicId, t));
    await db.delete(schema.topicMembers).where(eq(schema.topicMembers.topicId, t));
    await db.delete(schema.posts).where(eq(schema.posts.topicId, t));
    await db.delete(schema.topics).where(eq(schema.topics.id, t));
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  db = drizzle(pool, { schema });
  await clean();
  for (const u of USERS) await db.delete(schema.users).where(eq(schema.users.id, u));
  await db.insert(schema.users).values(USERS.map((id) => ({ id, nickname: id.replace(/-/g, '_') })));
});

afterAll(async () => {
  await clean();
  for (const u of USERS) await db.delete(schema.users).where(eq(schema.users.id, u));
  await pool.end();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.uploadToR2.mockResolvedValue('https://cdn.example/obj');
  mocks.deleteR2Prefix.mockResolvedValue(0);
  await clean();
  await seedTopics();
  mocks.getSession.mockResolvedValue(session(MEMBER));
});

describe('POST /api/upload — who may file an object under a topic', () => {
  it('a member uploads into the topic, and the topic is passed to the key builder', async () => {
    const res = await uploadPOST(uploadReq({ purpose: 'post', topicId: TOPIC }));
    expect(res.status).toBe(200);
    // 6th argument is the topicId — the whole point of the change.
    expect(mocks.uploadToR2).toHaveBeenCalledTimes(1);
    expect(mocks.uploadToR2.mock.calls[0][5]).toBe(TOPIC);
  });

  it('AUTHZ: a non-member cannot file an object under someone else’s topic', async () => {
    /*
     * Without this check any signed-in account could write into any topic's
     * prefix — junk storage that another owner pays for, and that their topic
     * deletion silently removes.
     */
    mocks.getSession.mockResolvedValue(session(STRANGER));
    const res = await uploadPOST(uploadReq({ purpose: 'post', topicId: TOPIC }));
    expect(res.status).toBe(403);
    expect(mocks.uploadToR2).not.toHaveBeenCalled();
  });

  it('AUTHZ: a guest cannot upload at all', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await uploadPOST(uploadReq({ purpose: 'post', topicId: TOPIC }));
    expect(res.status).toBe(401);
    expect(mocks.uploadToR2).not.toHaveBeenCalled();
  });

  it('HOSTILE: a malformed topicId is refused, never downgraded to the user path', async () => {
    // A caller naming a topic is making a claim. A wrong claim is corrected,
    // not quietly reinterpreted as "no topic" — that would hide the bug.
    for (const bad of ['not-a-uuid', '../../etc', '00000000', `${TOPIC} `]) {
      const res = await uploadPOST(uploadReq({ purpose: 'post', topicId: bad }));
      expect(res.status, bad).toBe(400);
    }
    expect(mocks.uploadToR2).not.toHaveBeenCalled();
  });

  it('HOSTILE: a well-formed topicId for a topic that does not exist is refused', async () => {
    const ghost = '00000000-0000-4000-8000-0000000000ff';
    const res = await uploadPOST(uploadReq({ purpose: 'post', topicId: ghost }));
    expect(res.status).toBe(403); // no membership row can exist for it
  });

  it('EMPTY: no topicId uploads under the user — allowed, and marked as such', async () => {
    // The topic-creation image and bare agent uploads take this path.
    const res = await uploadPOST(uploadReq({ purpose: 'post' }));
    expect(res.status).toBe(200);
    expect(mocks.uploadToR2.mock.calls[0][5]).toBeNull();
  });

  it('an avatar needs no topic and is not refused for lacking one', async () => {
    const res = await uploadPOST(uploadReq({ purpose: 'avatar' }));
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/topics/{id} — the sweep', () => {
  it('CONTRACT: sweeps the topic prefix, and the prefix is the builder’s own', async () => {
    mocks.getSession.mockResolvedValue(session(OWNER));
    const res = await topicDELETE(deleteReq(), params(TOPIC));
    expect(res.status).toBe(200);

    expect(mocks.deleteR2Prefix).toHaveBeenCalledTimes(1);
    const swept = mocks.deleteR2Prefix.mock.calls[0][0] as string;
    expect(swept).toBe(topicObjectPrefix(TOPIC));
    // …and every kind of object this topic can own is under it.
    expect(uploadObjectKey('post', OWNER, TOPIC, 'a.jpg').startsWith(swept)).toBe(true);
    expect(uploadObjectKey('topic', OWNER, TOPIC, 'b.jpg').startsWith(swept)).toBe(true);
  });

  it('INTEGRITY: deleting one topic never sweeps a neighbour’s objects', async () => {
    mocks.getSession.mockResolvedValue(session(OWNER));
    await topicDELETE(deleteReq(), params(TOPIC));

    const swept = mocks.deleteR2Prefix.mock.calls[0][0] as string;
    expect(swept).not.toBe(topicObjectPrefix(NEIGHBOUR));
    expect(uploadObjectKey('post', OWNER, NEIGHBOUR, 'a.jpg').startsWith(swept)).toBe(false);
    // The neighbour is still there, rows and all.
    const neighbour = await db.query.topics.findFirst({ where: eq(schema.topics.id, NEIGHBOUR) });
    expect(neighbour).toBeTruthy();
  });

  it('AUTHZ: a plain member cannot delete the topic, and nothing is swept', async () => {
    mocks.getSession.mockResolvedValue(session(MEMBER));
    const res = await topicDELETE(deleteReq(), params(TOPIC));
    expect(res.status).toBe(403);
    expect(mocks.deleteR2Prefix).not.toHaveBeenCalled();
  });

  it('AUTHZ: a stranger gets 403 and no sweep', async () => {
    mocks.getSession.mockResolvedValue(session(STRANGER));
    const res = await topicDELETE(deleteReq(), params(TOPIC));
    expect(res.status).toBe(403);
    expect(mocks.deleteR2Prefix).not.toHaveBeenCalled();
  });

  it('BOUNDARY: a topic with no objects still deletes cleanly', async () => {
    mocks.deleteR2Prefix.mockResolvedValue(0);
    mocks.getSession.mockResolvedValue(session(OWNER));
    const res = await topicDELETE(deleteReq(), params(TOPIC));
    expect(res.status).toBe(200);
  });

  it('CONTRACT: a failed sweep does not resurrect the topic', async () => {
    /*
     * Best-effort by design: the rows are gone before storage is touched, so a
     * storage failure must not produce a response that says the topic survived.
     * It reports fewer objects removed, and the operator sees it in the log.
     */
    mocks.deleteR2Prefix.mockRejectedValue(new Error('r2 down'));
    mocks.getSession.mockResolvedValue(session(OWNER));
    const res = await topicDELETE(deleteReq(), params(TOPIC));
    expect([200, 500]).toContain(res.status);
    const gone = await db.query.topics.findFirst({ where: eq(schema.topics.id, TOPIC) });
    expect(gone).toBeUndefined();
  });
});
