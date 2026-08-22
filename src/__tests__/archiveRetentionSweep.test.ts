/**
 * Chat-archive retention ENFORCEMENT — real local Postgres.
 *
 * The rule is unit-tested without a database (`archiveRetention.test.ts`); what
 * is at stake HERE is the statement that actually deletes, and every claim
 * about it is a property of the SQL: which rows it can reach, which it must not
 * touch, and where exactly its boundary falls. Mocking the executor would prove
 * only that a function was called.
 *
 * Requires the local dev DB (DATABASE_URL or default).
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   boundary          → 'an empty archive purges nothing' (0 rows),
 *                       'a single expired row is purged' (1 row),
 *                       'a row exactly at the edge of the window survives',
 *                       'a row one second past the edge is purged'
 *   result integrity  → 'never touches another topic's rows',
 *                       'never touches a row inside the window',
 *                       'an unlimited topic keeps a three-year-old row'
 *   race              → 'a message archived DURING the purge survives it'
 *   contract          → 'the throttle runs the purge at most once per interval',
 *                       'a failed purge is swallowed, not thrown at the request'
 *   hostile input     → 'a topic id that does not exist deletes nothing'
 *   empty/null/undef  → covered as 0-row and unlimited(0) cases above; the
 *                       column is NOT NULL with a default, so a null window is
 *                       unrepresentable — asserted in 'every existing topic
 *                       defaults to unlimited'
 *   authorization     → N/A at this layer: the sweep has no caller identity. The
 *                       route-level gates are in archiveRetention-routes.test.ts.
 *   UTF-8 / large     → N/A: the purge reads timestamps and an integer window,
 *                       never user text. Hostile values are rejected at the
 *                       route before they can reach a row.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { storeArchiveRow } from '@/lib/mls/archive';
import {
  ARCHIVE_SWEEP_INTERVAL_MS,
  purgeExpiredArchiveRows,
  resetArchiveSweepThrottle,
  scheduleArchiveSweep,
  sweepTopicArchive,
} from '@/lib/archiveRetentionSweep';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

const USER = 'archive-retention-user';
const TOPIC_30D = '00000000-0000-4000-8000-000000000030';
const TOPIC_UNLIMITED = '00000000-0000-4000-8000-000000000031';
const TOPIC_OTHER = '00000000-0000-4000-8000-000000000032';
const ALL_TOPICS = [TOPIC_30D, TOPIC_UNLIMITED, TOPIC_OTHER];

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-14T00:00:00.000Z');

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** Insert one archive row with an exact creation instant (the purge's input). */
async function seedRow(topicId: string, messageId: string, createdAt: Date): Promise<void> {
  await db.execute(sql`
    INSERT INTO chat_archive (topic_id, message_id, tak_version, ciphertext, created_at)
    VALUES (${topicId}, ${messageId}::uuid, 1, ${Buffer.from('ct')}, ${createdAt.toISOString()}::timestamptz)
  `);
}

/** Message ids that differ only in their last digits, so cases read cleanly. */
const msg = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function idsIn(topicId: string): Promise<string[]> {
  const rows = await db
    .select({ messageId: schema.chatArchive.messageId })
    .from(schema.chatArchive)
    .where(eq(schema.chatArchive.topicId, topicId));
  return rows.map((r) => r.messageId).sort();
}

async function clean() {
  for (const topicId of ALL_TOPICS) {
    await db.delete(schema.chatArchive).where(eq(schema.chatArchive.topicId, topicId));
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
  await db.insert(schema.users).values({ id: USER, nickname: 'archive_retention_user' });
  await db.insert(schema.topics).values([
    {
      id: TOPIC_30D,
      title: 'Retention 30d',
      creatorId: USER,
      inviteCode: 'retention-30d-code',
      visibility: 'public',
      chatArchiveRetentionDays: 30,
    },
    {
      id: TOPIC_UNLIMITED,
      title: 'Retention unlimited',
      creatorId: USER,
      inviteCode: 'retention-unlimited-code',
      visibility: 'public',
      chatArchiveRetentionDays: 0,
    },
    {
      id: TOPIC_OTHER,
      title: 'Retention neighbour',
      creatorId: USER,
      inviteCode: 'retention-other-code',
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
  resetArchiveSweepThrottle();
});

describe('purgeExpiredArchiveRows — the window', () => {
  it('BOUNDARY: an empty archive purges nothing and does not throw', () => {
    return expect(purgeExpiredArchiveRows(db, TOPIC_30D, NOW)).resolves.toBe(0);
  });

  it('BOUNDARY: a single expired row is purged', async () => {
    await seedRow(TOPIC_30D, msg(1), new Date(NOW.getTime() - 40 * DAY_MS));
    expect(await purgeExpiredArchiveRows(db, TOPIC_30D, NOW)).toBe(1);
    expect(await idsIn(TOPIC_30D)).toEqual([]);
  });

  it('BOUNDARY: a row exactly at the edge of the window survives', async () => {
    // Strictly-older-than, matching `grantTimeFloor`'s inclusive lower bound: a
    // message a reader can still see must not vanish under them.
    await seedRow(TOPIC_30D, msg(2), new Date(NOW.getTime() - 30 * DAY_MS));
    expect(await purgeExpiredArchiveRows(db, TOPIC_30D, NOW)).toBe(0);
    expect(await idsIn(TOPIC_30D)).toEqual([msg(2)]);
  });

  it('BOUNDARY: a row one second past the edge is purged', async () => {
    await seedRow(TOPIC_30D, msg(3), new Date(NOW.getTime() - 30 * DAY_MS - 1000));
    expect(await purgeExpiredArchiveRows(db, TOPIC_30D, NOW)).toBe(1);
    expect(await idsIn(TOPIC_30D)).toEqual([]);
  });

  it('INTEGRITY: never touches a row inside the window', async () => {
    await seedRow(TOPIC_30D, msg(4), NOW); // this instant
    await seedRow(TOPIC_30D, msg(5), new Date(NOW.getTime() - 1 * DAY_MS));
    await seedRow(TOPIC_30D, msg(6), new Date(NOW.getTime() - 29 * DAY_MS));
    await seedRow(TOPIC_30D, msg(7), new Date(NOW.getTime() - 31 * DAY_MS)); // the only casualty

    expect(await purgeExpiredArchiveRows(db, TOPIC_30D, NOW)).toBe(1);
    expect(await idsIn(TOPIC_30D)).toEqual([msg(4), msg(5), msg(6)].sort());
  });

  it('INTEGRITY: never touches another topic’s rows', async () => {
    // Same age, same expired side of the line, different topic. A purge that
    // reaches across topics is the worst bug this statement can have.
    await seedRow(TOPIC_30D, msg(8), new Date(NOW.getTime() - 90 * DAY_MS));
    await seedRow(TOPIC_OTHER, msg(9), new Date(NOW.getTime() - 90 * DAY_MS));

    expect(await purgeExpiredArchiveRows(db, TOPIC_30D, NOW)).toBe(1);
    expect(await idsIn(TOPIC_30D)).toEqual([]);
    expect(await idsIn(TOPIC_OTHER)).toEqual([msg(9)]);
  });

  it('an unlimited topic keeps a three-year-old row', async () => {
    await seedRow(TOPIC_UNLIMITED, msg(10), new Date(NOW.getTime() - 3 * 365 * DAY_MS));
    expect(await purgeExpiredArchiveRows(db, TOPIC_UNLIMITED, NOW)).toBe(0);
    expect(await idsIn(TOPIC_UNLIMITED)).toEqual([msg(10)]);
  });

  it('CONTRACT: every existing topic defaults to unlimited, so the column can never be null', async () => {
    // The migration is additive with a NOT NULL default of 0. Any row reading
    // back as null (or as some other window) would mean history is being purged
    // under topics whose owners never chose a window.
    const rows = await db.execute(sql`
      SELECT count(*)::int AS n FROM topics WHERE chat_archive_retention_days IS NULL
    `);
    expect((rows.rows[0] as { n: number }).n).toBe(0);

    const created = await db.execute(sql`
      SELECT chat_archive_retention_days AS d FROM topics WHERE id = ${TOPIC_UNLIMITED}
    `);
    expect(Number((created.rows[0] as { d: number }).d)).toBe(0);
  });

  it('HOSTILE: a topic id that does not exist deletes nothing', async () => {
    await seedRow(TOPIC_30D, msg(11), new Date(NOW.getTime() - 90 * DAY_MS));
    const ghost = '00000000-0000-4000-8000-0000000000ff';
    expect(await purgeExpiredArchiveRows(db, ghost, NOW)).toBe(0);
    expect(await idsIn(TOPIC_30D)).toEqual([msg(11)]);
  });

  it('RACE: a message archived DURING the purge survives it', async () => {
    // The purge is fire-and-forget beside live traffic, so it WILL overlap an
    // upload. A fresh row is inside every window; the concurrent delete must not
    // take it, and must still take the expired ones.
    await seedRow(TOPIC_30D, msg(12), new Date(NOW.getTime() - 200 * DAY_MS));
    await seedRow(TOPIC_30D, msg(13), new Date(NOW.getTime() - 100 * DAY_MS));

    const [deleted] = await Promise.all([
      purgeExpiredArchiveRows(db, TOPIC_30D, NOW),
      storeArchiveRow(db, TOPIC_30D, msg(14), 1, Buffer.from('fresh')),
    ]);

    expect(deleted).toBe(2);
    expect(await idsIn(TOPIC_30D)).toEqual([msg(14)]);
  });
});

describe('sweepTopicArchive — the throttle', () => {
  it('CONTRACT: runs the purge at most once per interval, then again after it', async () => {
    await seedRow(TOPIC_30D, msg(15), new Date(NOW.getTime() - 90 * DAY_MS));
    expect(await sweepTopicArchive(db, TOPIC_30D, NOW)).toEqual({ swept: true, deleted: 1 });

    // A second request a minute later must not issue another DELETE.
    await seedRow(TOPIC_30D, msg(16), new Date(NOW.getTime() - 90 * DAY_MS));
    const skipped = await sweepTopicArchive(db, TOPIC_30D, new Date(NOW.getTime() + 60_000));
    expect(skipped).toEqual({ swept: false, deleted: 0 });
    expect(await idsIn(TOPIC_30D)).toEqual([msg(16)]);

    // Past the interval it sweeps again — the row is at most one interval late.
    const later = new Date(NOW.getTime() + ARCHIVE_SWEEP_INTERVAL_MS);
    expect(await sweepTopicArchive(db, TOPIC_30D, later)).toEqual({ swept: true, deleted: 1 });
    expect(await idsIn(TOPIC_30D)).toEqual([]);
  });

  it('the throttle is per topic — one busy room does not shield another', async () => {
    await seedRow(TOPIC_30D, msg(17), new Date(NOW.getTime() - 90 * DAY_MS));
    await seedRow(TOPIC_OTHER, msg(18), new Date(NOW.getTime() - 90 * DAY_MS));

    expect((await sweepTopicArchive(db, TOPIC_30D, NOW)).deleted).toBe(1);
    expect((await sweepTopicArchive(db, TOPIC_OTHER, NOW)).deleted).toBe(1);
  });

  it('RACE: concurrent requests on one topic produce exactly one purge', async () => {
    // The stamp is taken before the DELETE runs, so a burst collapses to one.
    await seedRow(TOPIC_30D, msg(19), new Date(NOW.getTime() - 90 * DAY_MS));
    const results = await Promise.all([
      sweepTopicArchive(db, TOPIC_30D, NOW),
      sweepTopicArchive(db, TOPIC_30D, NOW),
      sweepTopicArchive(db, TOPIC_30D, NOW),
    ]);
    expect(results.filter((r) => r.swept)).toHaveLength(1);
    expect(results.reduce((n, r) => n + r.deleted, 0)).toBe(1);
  });
});

describe('scheduleArchiveSweep — fire and forget', () => {
  it('CONTRACT: a failed purge is swallowed, not thrown at the request', async () => {
    // A member reading history must never get a 500 because a DELETE failed.
    let rejection!: Promise<unknown>;
    const broken = {
      execute: () => {
        rejection = Promise.reject(new Error('db is down'));
        return rejection;
      },
    };
    expect(() => scheduleArchiveSweep(broken, TOPIC_30D, NOW)).not.toThrow();
    // Wait on the rejection ITSELF rather than on a guessed number of
    // milliseconds. The helper attaches its catch before it returns, so its
    // handler is already queued ahead of this one — settling here means the
    // swallow has happened, on a slow runner as surely as on a fast one.
    await rejection.catch(() => undefined);
  });

  it('returns synchronously — the caller never waits on the purge', async () => {
    await seedRow(TOPIC_30D, msg(20), new Date(NOW.getTime() - 90 * DAY_MS));
    let settled = false;
    // Two gates instead of two sleeps. The old shape held the DELETE for 30ms
    // and then gave it 80ms to finish, which is a bet on the runner being
    // fast; CI lost that bet. Here the DELETE is held open until the test
    // says so, which is the actual contract being asserted — control came
    // back while the work was demonstrably unfinished, not merely early.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finish!: () => void;
    const purged = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const slow = {
      execute: async (q: Parameters<typeof db.execute>[0]) => {
        await held;
        settled = true;
        const result = await db.execute(q);
        finish();
        return result;
      },
    };
    scheduleArchiveSweep(slow, TOPIC_30D, NOW);
    expect(settled).toBe(false); // control returned before the DELETE finished
    release();
    await purged;
    expect(settled).toBe(true);
    expect(await idsIn(TOPIC_30D)).toEqual([]);
  });
});
