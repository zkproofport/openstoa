/**
 * Attachment collection (M-1) — real local Postgres.
 *
 * Every claim here is a property of SQL: which rows each statement can reach,
 * which it must not touch, and where its boundaries fall. A mocked executor
 * would prove only that a function was called, so this runs the real statements
 * against a real table; only the OBJECT deleter is a stub, because the thing
 * under test is which keys it is handed and in what order.
 *
 * Requires the local dev DB (DATABASE_URL or default).
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   boundary        → 'an empty index sweeps nothing', 'a row exactly at the
 *                     edge of the window survives', 'one second past the edge
 *                     is collected', 'an unclaimed row exactly at the grace
 *                     edge survives', 'one second past the grace edge is
 *                     collected', 'collects every expired object, not just the
 *                     first page'
 *   result integrity→ 'never touches another topic''s attachments', 'never
 *                     touches a claimed row in an unlimited topic', 'a claimed
 *                     row inside the window is left alone'
 *   hostile input   → 'a row whose key escapes the topic prefix is never handed
 *                     to storage', 'a topic id that does not exist collects
 *                     nothing'
 *   empty/null/undef→ 'an empty index sweeps nothing' (0 rows); claimed_at NULL
 *                     is the unclaimed case throughout; the window column is
 *                     NOT NULL so a null window is unrepresentable
 *   race            → 'an unclaimed row inside the grace window is left alone'
 *                     (a send about to succeed), 'the throttle sweeps at most
 *                     once per interval'
 *   contract        → 'the object is deleted BEFORE its row', 'a storage
 *                     failure keeps the row so the next sweep retries', 'a
 *                     failed sweep is swallowed, not thrown at the request'
 *   external dep    → 'a storage failure keeps the row...' (R2 refusing)
 *   authorization   → N/A at this layer: the sweep has no caller identity. Route
 *                     gates are in chat-media-route.test.ts.
 *   UTF-8 / large   → N/A: the sweep reads ids, keys we generated, and
 *                     timestamps — never user text.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import {
  CHAT_MEDIA_CLAIM_GRACE_MS,
  CHAT_MEDIA_SWEEP_INTERVAL_MS,
  resetChatMediaSweepThrottle,
  scheduleChatMediaSweep,
  selectExpiredChatMedia,
  selectUnclaimedChatMedia,
  sweepTopicChatMedia,
} from '@/lib/chatMediaSweep';
import { chatMediaObjectKey } from '@/lib/chatMedia';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

const USER = 'chat-media-sweep-user';
const TOPIC_30D = '00000000-0000-4000-8000-000000000040';
const TOPIC_UNLIMITED = '00000000-0000-4000-8000-000000000041';
const TOPIC_OTHER = '00000000-0000-4000-8000-000000000042';
const ALL_TOPICS = [TOPIC_30D, TOPIC_UNLIMITED, TOPIC_OTHER];

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-14T00:00:00.000Z');

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** Media ids that differ only in their last digits, so cases read cleanly. */
const media = (n: number) => String(n).padStart(32, '0');
const keyOf = (topicId: string, n: number) => chatMediaObjectKey(topicId, USER, media(n));

/** Insert one index row with an exact creation instant and claim state. */
async function seed(
  topicId: string,
  n: number,
  createdAt: Date,
  claimedAt: Date | null = null,
): Promise<string> {
  const key = keyOf(topicId, n);
  await db.execute(sql`
    INSERT INTO chat_media (topic_id, object_key, uploader_id, created_at, claimed_at)
    VALUES (${topicId}, ${key}, ${USER}, ${createdAt.toISOString()}::timestamptz,
            ${claimedAt ? claimedAt.toISOString() : null})
  `);
  return key;
}

/** A deleter that records what it was asked to delete. */
function recorder(opts: { fail?: boolean } = {}) {
  const seen: string[] = [];
  return {
    seen,
    deleter: async (key: string) => {
      seen.push(key);
      return !opts.fail;
    },
  };
}

async function keysIn(topicId: string): Promise<string[]> {
  const rows = await db
    .select({ objectKey: schema.chatMedia.objectKey })
    .from(schema.chatMedia)
    .where(eq(schema.chatMedia.topicId, topicId));
  return rows.map((r) => r.objectKey).sort();
}

async function clean() {
  for (const topicId of ALL_TOPICS) {
    await db.delete(schema.chatMedia).where(eq(schema.chatMedia.topicId, topicId));
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  db = drizzle(pool, { schema });
  await clean();
  for (const topicId of ALL_TOPICS) {
    await db.delete(schema.topics).where(eq(schema.topics.id, topicId));
  }
  await db.delete(schema.users).where(eq(schema.users.id, USER));
  await db.insert(schema.users).values({ id: USER, nickname: 'chat_media_sweep_user' });
  await db.insert(schema.topics).values([
    {
      id: TOPIC_30D,
      title: 'Media 30d',
      creatorId: USER,
      inviteCode: 'media-30d-code',
      visibility: 'public',
      chatArchiveRetentionDays: 30,
    },
    {
      id: TOPIC_UNLIMITED,
      title: 'Media unlimited',
      creatorId: USER,
      inviteCode: 'media-unlimited-code',
      visibility: 'public',
      chatArchiveRetentionDays: 0,
    },
    {
      id: TOPIC_OTHER,
      title: 'Media neighbour',
      creatorId: USER,
      inviteCode: 'media-other-code',
      visibility: 'public',
      chatArchiveRetentionDays: 30,
    },
  ]);
});

afterAll(async () => {
  await clean();
  for (const topicId of ALL_TOPICS) {
    await db.delete(schema.topics).where(eq(schema.topics.id, topicId));
  }
  await db.delete(schema.users).where(eq(schema.users.id, USER));
  await pool.end();
});

beforeEach(async () => {
  await clean();
  resetChatMediaSweepThrottle();
});

describe('retention — an attachment expires with its message', () => {
  it('an empty index sweeps nothing', async () => {
    const { deleter, seen } = recorder();
    const res = await sweepTopicChatMedia(db, TOPIC_30D, NOW, deleter);
    expect(res).toEqual({ swept: true, expired: 0, unclaimed: 0 });
    expect(seen).toEqual([]);
  });

  it('collects an attachment past the topic window', async () => {
    const key = await seed(TOPIC_30D, 1, new Date(NOW.getTime() - 31 * DAY_MS), NOW);
    const { deleter, seen } = recorder();
    const res = await sweepTopicChatMedia(db, TOPIC_30D, NOW, deleter);
    expect(res.expired).toBe(1);
    expect(seen).toEqual([key]);
    expect(await keysIn(TOPIC_30D)).toEqual([]);
  });

  it('BOUNDARY: a row exactly at the edge of the window survives', async () => {
    // Strict `<`, matching the archive purge — the forgiving side of the line.
    await seed(TOPIC_30D, 2, new Date(NOW.getTime() - 30 * DAY_MS), NOW);
    const { deleter, seen } = recorder();
    const res = await sweepTopicChatMedia(db, TOPIC_30D, NOW, deleter);
    expect(res.expired).toBe(0);
    expect(seen).toEqual([]);
    expect(await keysIn(TOPIC_30D)).toHaveLength(1);
  });

  it('BOUNDARY: one second past the edge is collected', async () => {
    await seed(TOPIC_30D, 3, new Date(NOW.getTime() - 30 * DAY_MS - 1000), NOW);
    const { deleter } = recorder();
    expect((await sweepTopicChatMedia(db, TOPIC_30D, NOW, deleter)).expired).toBe(1);
  });

  it('a claimed row inside the window is left alone', async () => {
    await seed(TOPIC_30D, 4, new Date(NOW.getTime() - 5 * DAY_MS), NOW);
    const { deleter, seen } = recorder();
    const res = await sweepTopicChatMedia(db, TOPIC_30D, NOW, deleter);
    expect(res).toMatchObject({ expired: 0, unclaimed: 0 });
    expect(seen).toEqual([]);
  });

  it('UNLIMITED: a claimed three-year-old attachment is kept forever', async () => {
    // "Unlimited means we delete nothing you can see" has to stay true.
    await seed(TOPIC_UNLIMITED, 5, new Date(NOW.getTime() - 1095 * DAY_MS), NOW);
    const { deleter, seen } = recorder();
    const res = await sweepTopicChatMedia(db, TOPIC_UNLIMITED, NOW, deleter);
    expect(res).toMatchObject({ expired: 0, unclaimed: 0 });
    expect(seen).toEqual([]);
    expect(await keysIn(TOPIC_UNLIMITED)).toHaveLength(1);
  });

  it('INTEGRITY: never touches another topic attachments', async () => {
    const mine = await seed(TOPIC_30D, 6, new Date(NOW.getTime() - 31 * DAY_MS), NOW);
    const theirs = await seed(TOPIC_OTHER, 7, new Date(NOW.getTime() - 31 * DAY_MS), NOW);
    const { deleter, seen } = recorder();
    await sweepTopicChatMedia(db, TOPIC_30D, NOW, deleter);
    expect(seen).toEqual([mine]);
    expect(await keysIn(TOPIC_OTHER)).toEqual([theirs]);
  });

  it('a topic id that does not exist collects nothing', async () => {
    const { deleter, seen } = recorder();
    const res = await sweepTopicChatMedia(db, '00000000-0000-4000-8000-0000000000ff', NOW, deleter);
    expect(res).toMatchObject({ expired: 0, unclaimed: 0 });
    expect(seen).toEqual([]);
  });

  it('collects every expired object, not just the first page', async () => {
    // The sweep pages; a backlog must drain rather than leave a tail behind.
    const keys: string[] = [];
    for (let i = 0; i < 250; i++) {
      keys.push(await seed(TOPIC_30D, 100 + i, new Date(NOW.getTime() - 31 * DAY_MS), NOW));
    }
    const { deleter, seen } = recorder();
    const res = await sweepTopicChatMedia(db, TOPIC_30D, NOW, deleter);
    expect(res.expired).toBe(250);
    expect(seen.sort()).toEqual(keys.sort());
    expect(await keysIn(TOPIC_30D)).toEqual([]);
  });
});

describe('unclaimed collection — the upload whose message never landed', () => {
  it('RACE: an unclaimed row inside the grace window is left alone', async () => {
    // A send that is about to succeed. Collecting here deletes the picture out
    // from under a message that then renders as permanently broken.
    await seed(TOPIC_30D, 10, new Date(NOW.getTime() - CHAT_MEDIA_CLAIM_GRACE_MS + 60_000), null);
    const { deleter, seen } = recorder();
    const res = await sweepTopicChatMedia(db, TOPIC_30D, NOW, deleter);
    expect(res.unclaimed).toBe(0);
    expect(seen).toEqual([]);
  });

  it('BOUNDARY: exactly at the grace edge survives', async () => {
    await seed(TOPIC_30D, 11, new Date(NOW.getTime() - CHAT_MEDIA_CLAIM_GRACE_MS), null);
    const { deleter } = recorder();
    expect((await sweepTopicChatMedia(db, TOPIC_30D, NOW, deleter)).unclaimed).toBe(0);
  });

  it('BOUNDARY: one second past the grace edge is collected', async () => {
    const key = await seed(TOPIC_30D, 12, new Date(NOW.getTime() - CHAT_MEDIA_CLAIM_GRACE_MS - 1000), null);
    const { deleter, seen } = recorder();
    expect((await sweepTopicChatMedia(db, TOPIC_30D, NOW, deleter)).unclaimed).toBe(1);
    expect(seen).toEqual([key]);
  });

  it('UNLIMITED: a stranded upload is still collected there', async () => {
    // The one deletion an unlimited topic must perform — nothing else ever
    // sweeps it, so a stranded object would be paid for forever.
    const key = await seed(
      TOPIC_UNLIMITED,
      13,
      new Date(NOW.getTime() - CHAT_MEDIA_CLAIM_GRACE_MS - 1000),
      null,
    );
    const { deleter, seen } = recorder();
    const res = await sweepTopicChatMedia(db, TOPIC_UNLIMITED, NOW, deleter);
    expect(res).toMatchObject({ expired: 0, unclaimed: 1 });
    expect(seen).toEqual([key]);
  });

  it('a CLAIMED old row is never collected as unclaimed', async () => {
    await seed(
      TOPIC_UNLIMITED,
      14,
      new Date(NOW.getTime() - 400 * DAY_MS),
      new Date(NOW.getTime() - 400 * DAY_MS),
    );
    const { deleter, seen } = recorder();
    expect((await sweepTopicChatMedia(db, TOPIC_UNLIMITED, NOW, deleter)).unclaimed).toBe(0);
    expect(seen).toEqual([]);
  });
});

describe('ordering and failure', () => {
  it('CONTRACT: the object is deleted BEFORE its row', async () => {
    /*
     * Row-first is the one order that can lose an object permanently: its only
     * other reference is inside a sealed body the server cannot read, so a
     * failed object delete after a successful row delete strands it forever.
     */
    const key = await seed(TOPIC_30D, 20, new Date(NOW.getTime() - 31 * DAY_MS), NOW);
    let rowsWhenObjectDeleted = -1;
    await sweepTopicChatMedia(db, TOPIC_30D, NOW, async (k) => {
      expect(k).toBe(key);
      rowsWhenObjectDeleted = (await keysIn(TOPIC_30D)).length;
      return true;
    });
    expect(rowsWhenObjectDeleted).toBe(1); // the row was still there
    expect(await keysIn(TOPIC_30D)).toEqual([]); // and is gone afterwards
  });

  it('EXTERNAL DEP: a storage failure keeps the row so the next sweep retries', async () => {
    await seed(TOPIC_30D, 21, new Date(NOW.getTime() - 31 * DAY_MS), NOW);
    const failing = recorder({ fail: true });
    const res = await sweepTopicChatMedia(db, TOPIC_30D, NOW, failing.deleter);
    expect(res.expired).toBe(0);
    expect(await keysIn(TOPIC_30D)).toHaveLength(1);

    resetChatMediaSweepThrottle();
    const working = recorder();
    expect((await sweepTopicChatMedia(db, TOPIC_30D, NOW, working.deleter)).expired).toBe(1);
    expect(await keysIn(TOPIC_30D)).toEqual([]);
  });

  it('an object already gone from storage still clears its row', async () => {
    // DeleteObject is idempotent and answers true for a key that was not there;
    // the goal state is "this object does not exist", which is already met.
    await seed(TOPIC_30D, 22, new Date(NOW.getTime() - 31 * DAY_MS), NOW);
    const res = await sweepTopicChatMedia(db, TOPIC_30D, NOW, async () => true);
    expect(res.expired).toBe(1);
    expect(await keysIn(TOPIC_30D)).toEqual([]);
  });

  it('HOSTILE: a row whose key escapes the topic prefix is never handed to storage', async () => {
    /*
     * Built through `chatMediaObjectKey`, not spelled out. A literal would keep
     * naming a shape uploads no longer produce, and since the collector now
     * also accepts the LEGACY prefix for deletion, a literal `chat/…` key here
     * would quietly stop testing "escapes this topic" and start testing the
     * legacy path — which has its own case below.
     */
    await db.execute(sql`
      INSERT INTO chat_media (topic_id, object_key, uploader_id, created_at, claimed_at)
      VALUES (${TOPIC_30D}, ${chatMediaObjectKey(TOPIC_OTHER, USER, media(30))}, ${USER},
              ${new Date(NOW.getTime() - 31 * DAY_MS).toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)
    `);
    const { deleter, seen } = recorder();
    const res = await sweepTopicChatMedia(db, TOPIC_30D, NOW, deleter);
    expect(seen).toEqual([]);
    expect(res.expired).toBe(0);
    // The row stays: refusing to act on it is not the same as pretending it is
    // handled, and an operator can see it.
    expect(await keysIn(TOPIC_30D)).toHaveLength(1);
  });

  it('LEGACY LAYOUT: a row written before the keys moved is still collected', async () => {
    /*
     * M-3 moved chat objects from `chat/{topicId}/…` to
     * `topics/{topicId}/chat/…`. A row written before that fails the new
     * confinement check, so without an explicit allowance the collector refuses
     * it on every pass and the row — and its object — live forever. A collector
     * that cannot collect the old thing is the wrong way round.
     */
    const legacyKey = `chat/${TOPIC_30D}/${USER}/${media(60)}.bin`;
    await db.execute(sql`
      INSERT INTO chat_media (topic_id, object_key, uploader_id, created_at, claimed_at)
      VALUES (${TOPIC_30D}, ${legacyKey}, ${USER},
              ${new Date(NOW.getTime() - 31 * DAY_MS).toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)
    `);
    const { deleter, seen } = recorder();
    const res = await sweepTopicChatMedia(db, TOPIC_30D, NOW, deleter);

    expect(res.expired).toBe(1);
    expect(seen).toEqual([legacyKey]);
    expect(await keysIn(TOPIC_30D)).toEqual([]);
  });

  it('LEGACY LAYOUT: another topic old-shape key is STILL refused', async () => {
    // The allowance is for the old PREFIX, not for old keys generally — it must
    // not become a way to reach a neighbour's objects.
    const foreignLegacy = `chat/${TOPIC_OTHER}/${USER}/${media(61)}.bin`;
    await db.execute(sql`
      INSERT INTO chat_media (topic_id, object_key, uploader_id, created_at, claimed_at)
      VALUES (${TOPIC_30D}, ${foreignLegacy}, ${USER},
              ${new Date(NOW.getTime() - 31 * DAY_MS).toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)
    `);
    const { deleter, seen } = recorder();
    const res = await sweepTopicChatMedia(db, TOPIC_30D, NOW, deleter);

    expect(seen).toEqual([]);
    expect(res.expired).toBe(0);
    expect(await keysIn(TOPIC_30D)).toHaveLength(1);
  });

  it('CONTRACT: the throttle sweeps at most once per interval', async () => {
    await seed(TOPIC_30D, 23, new Date(NOW.getTime() - 31 * DAY_MS), NOW);
    const first = recorder();
    expect((await sweepTopicChatMedia(db, TOPIC_30D, NOW, first.deleter)).swept).toBe(true);

    await seed(TOPIC_30D, 24, new Date(NOW.getTime() - 31 * DAY_MS), NOW);
    const second = recorder();
    const inside = new Date(NOW.getTime() + CHAT_MEDIA_SWEEP_INTERVAL_MS - 1000);
    const res = await sweepTopicChatMedia(db, TOPIC_30D, inside, second.deleter);
    expect(res).toEqual({ swept: false, expired: 0, unclaimed: 0 });
    expect(second.seen).toEqual([]);

    const outside = new Date(NOW.getTime() + CHAT_MEDIA_SWEEP_INTERVAL_MS + 1000);
    const third = recorder();
    expect((await sweepTopicChatMedia(db, TOPIC_30D, outside, third.deleter)).expired).toBe(1);
  });

  it('CONTRACT: a failed sweep is swallowed, not thrown at the request', async () => {
    const broken = {
      execute: async () => {
        throw new Error('database is on fire');
      },
    };
    expect(() => scheduleChatMediaSweep(broken, TOPIC_30D, NOW)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('SI-1 — what the index is allowed to know', () => {
  it('the index row carries nothing that helps read the object', async () => {
    /*
     * The row exists so deletion can find the object. Anything beyond that is
     * metadata the sealed envelope exists to withhold — a message id above all,
     * which would hand the operator a map of which messages contain pictures.
     */
    // Read the REAL table, not the TypeScript object: what the server can know
    // is decided by the column list Postgres has, and a column added by a
    // migration without touching the schema file would slip past the other one.
    const res = (await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'chat_media'
    `)) as { rows: Array<{ column_name: string }> };
    const columns = res.rows.map((r) => r.column_name).sort();
    expect(columns).toEqual(
      ['claimed_at', 'created_at', 'id', 'object_key', 'topic_id', 'uploader_id'].sort(),
    );
    for (const forbidden of ['message_id', 'mime', 'filename', 'size', 'key', 'nonce', 'tak_version']) {
      expect(columns, forbidden).not.toContain(forbidden);
    }
  });

  it('the uploader id in the row is the one already inside the object key', async () => {
    // So the column adds no fact the row did not already carry.
    const key = await seed(TOPIC_30D, 40, NOW, NOW);
    expect(key).toContain(`/${USER}/`);
  });
});

describe('select helpers in isolation', () => {
  it('selectExpiredChatMedia respects the topic window and nothing else', async () => {
    await seed(TOPIC_30D, 50, new Date(NOW.getTime() - 31 * DAY_MS), null); // expired AND unclaimed
    const expired = await selectExpiredChatMedia(db, TOPIC_30D, NOW);
    expect(expired).toHaveLength(1);
    const unclaimed = await selectUnclaimedChatMedia(db, TOPIC_30D, NOW);
    expect(unclaimed).toHaveLength(1); // both rules can name the same row
  });

  it('selectUnclaimedChatMedia ignores the topic window entirely', async () => {
    await seed(TOPIC_UNLIMITED, 51, new Date(NOW.getTime() - CHAT_MEDIA_CLAIM_GRACE_MS - 1), null);
    expect(await selectExpiredChatMedia(db, TOPIC_UNLIMITED, NOW)).toEqual([]);
    expect(await selectUnclaimedChatMedia(db, TOPIC_UNLIMITED, NOW)).toHaveLength(1);
  });

  it('a row named by both rules is deleted once, not twice', async () => {
    const key = await seed(TOPIC_30D, 52, new Date(NOW.getTime() - 31 * DAY_MS), null);
    const { deleter, seen } = recorder();
    const res = await sweepTopicChatMedia(db, TOPIC_30D, NOW, deleter);
    expect(seen).toEqual([key]);
    expect(res.expired + res.unclaimed).toBe(1);
  });
});
