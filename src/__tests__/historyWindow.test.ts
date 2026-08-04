/**
 * `history_grant` window resolution + windowed archive read — REAL local
 * Postgres (mirrors mls-archive.test.ts).
 *
 * These are SQL invariants, not shapes: "a 7-day key sees only rows from the
 * last 7 days" is a claim about a WHERE clause, and a mocked db would prove
 * nothing about it. Requires the local dev DB (DATABASE_URL or default).
 *
 * EDGE-CASE MATRIX rows covered here
 *   boundary        → 'a message exactly at the day boundary is INSIDE',
 *                     'cutoff at N-1 / N / N+1 messages'
 *   empty           → 'an empty archive returns [] under every grant shape'
 *   result integrity→ 'every returned row is inside the window' + the keyset
 *                     rows ('paging cannot walk past the floor', 'no skips/dups')
 *   authorization   → covered at the route layer (historyGrant-routes.test.ts)
 *   hostile / UTF-8 → N/A at this layer: the grant never reaches SQL as text,
 *                     only as a parsed Date/number (proven in historyGrant.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { storeArchiveRow, getArchiveSince } from '@/lib/mls/archive';
import {
  getNewestMessagesCutoff,
  resolveHistoryWindow,
  getArchiveWindowed,
  isUnboundedWindow,
  UNBOUNDED_WINDOW,
  type HistoryWindow,
} from '@/lib/mls/historyWindow';
import { parseHistoryGrant } from '@/lib/historyGrant';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

const USER = 'hw-test-user';
const TOPIC = '00000000-0000-4000-8000-0000000079a1';

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-04T12:00:00.000Z');
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

/** Insert one user message at a fixed time/epoch; returns its id. */
async function seedMessage(createdAt: Date, epoch: number): Promise<string> {
  const [row] = await db
    .insert(schema.chatMessages)
    .values({
      topicId: TOPIC,
      userId: USER,
      ciphertext: Buffer.from(`sealed-${createdAt.toISOString()}`),
      epoch,
      type: 'message',
      createdAt,
    })
    .returning();
  return row.id;
}

/** Seed a message AND its archive row (the archive row's own createdAt is now). */
async function seedArchived(createdAt: Date, epoch: number): Promise<string> {
  const id = await seedMessage(createdAt, epoch);
  await storeArchiveRow(db as never, TOPIC, id, epoch, Buffer.from(`arch-${id}`));
  return id;
}

async function clean() {
  await db.delete(schema.chatArchive).where(eq(schema.chatArchive.topicId, TOPIC));
  await db.delete(schema.chatMessages).where(eq(schema.chatMessages.topicId, TOPIC));
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
  db = drizzle(pool, { schema });
  await clean();
  await db.delete(schema.topics).where(eq(schema.topics.id, TOPIC));
  await db.delete(schema.users).where(eq(schema.users.id, USER));
  await db.insert(schema.users).values({ id: USER, nickname: 'hw_test_user' });
  await db.insert(schema.topics).values({
    id: TOPIC,
    title: 'history window test topic',
    creatorId: USER,
    inviteCode: 'hw-invite-code',
    visibility: 'public',
  });
});

afterAll(async () => {
  await clean();
  await db.delete(schema.topics).where(eq(schema.topics.id, TOPIC));
  await db.delete(schema.users).where(eq(schema.users.id, USER));
  await pool.end();
});

beforeEach(clean);

// ---------------------------------------------------------------------------
// getNewestMessagesCutoff — the count-shaped grant
// ---------------------------------------------------------------------------

describe('getNewestMessagesCutoff', () => {
  it('returns null when the topic holds fewer messages than the grant covers', async () => {
    // Nothing to exclude → no bound at all, so a `100` key on a 3-message topic
    // reads all three rather than being mysteriously empty.
    await seedMessage(ago(1), 0);
    await seedMessage(ago(2), 0);
    expect(await getNewestMessagesCutoff(db as never, TOPIC, 100)).toBeNull();
    expect(await getNewestMessagesCutoff(db as never, TOPIC, 3)).toBeNull();
  });

  it('cutoff at the N-1 / N / N+1 boundary picks the Nth-newest message', async () => {
    const times = [ago(1), ago(2), ago(3), ago(4), ago(5)]; // newest first
    for (const t of times) await seedMessage(t, 0);

    expect((await getNewestMessagesCutoff(db as never, TOPIC, 1))!.toISOString()).toBe(ago(1).toISOString());
    expect((await getNewestMessagesCutoff(db as never, TOPIC, 3))!.toISOString()).toBe(ago(3).toISOString());
    expect((await getNewestMessagesCutoff(db as never, TOPIC, 5))!.toISOString()).toBe(ago(5).toISOString());
    // N+1 with only 5 rows → no bound.
    expect(await getNewestMessagesCutoff(db as never, TOPIC, 6)).toBeNull();
  });

  it('counts only user messages — system join/leave rows do not consume the budget', async () => {
    await seedMessage(ago(1), 0);
    await db.insert(schema.chatMessages).values({
      topicId: TOPIC, userId: USER, systemText: 'x joined', type: 'join', createdAt: ago(2),
    });
    await seedMessage(ago(3), 0);
    // Two USER messages exist; a grant of 2 must therefore bound at the older one,
    // not at the join row that sits between them.
    expect((await getNewestMessagesCutoff(db as never, TOPIC, 2))!.toISOString()).toBe(ago(3).toISOString());
  });

  it('returns null on a topic with no messages at all', async () => {
    expect(await getNewestMessagesCutoff(db as never, TOPIC, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveHistoryWindow — grant → bounds
// ---------------------------------------------------------------------------

describe('resolveHistoryWindow', () => {
  it('Nd resolves to a time floor and no epoch floor, without touching the db', async () => {
    const w = await resolveHistoryWindow(db as never, TOPIC, parseHistoryGrant('7d')!, NOW);
    expect(w.createdAfter!.toISOString()).toBe(ago(7).toISOString());
    expect(w.minEpoch).toBeNull();
    expect(isUnboundedWindow(w)).toBe(false);
  });

  it('since_epoch:N resolves to an epoch floor and no time floor', async () => {
    const w = await resolveHistoryWindow(db as never, TOPIC, parseHistoryGrant('since_epoch:4')!, NOW);
    expect(w.createdAfter).toBeNull();
    expect(w.minEpoch).toBe(4);
  });

  it('since_epoch:0 is still a bound, not an unbounded window', async () => {
    const w = await resolveHistoryWindow(db as never, TOPIC, parseHistoryGrant('since_epoch:0')!, NOW);
    expect(w.minEpoch).toBe(0);
    expect(isUnboundedWindow(w)).toBe(false);
  });

  it('N resolves through the db to the Nth-newest message time', async () => {
    for (const t of [ago(1), ago(2), ago(3)]) await seedMessage(t, 0);
    const w = await resolveHistoryWindow(db as never, TOPIC, parseHistoryGrant('2')!, NOW);
    expect(w.createdAfter!.toISOString()).toBe(ago(2).toISOString());
    expect(w.minEpoch).toBeNull();
  });

  it('a count grant on a short topic yields an unbounded window (nothing to exclude)', async () => {
    await seedMessage(ago(1), 0);
    const w = await resolveHistoryWindow(db as never, TOPIC, parseHistoryGrant('50')!, NOW);
    expect(isUnboundedWindow(w)).toBe(true);
    expect(isUnboundedWindow(UNBOUNDED_WINDOW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getArchiveWindowed — the bounded archive read
// ---------------------------------------------------------------------------

describe('getArchiveWindowed', () => {
  const win = (createdAfter: Date | null, minEpoch: number | null): HistoryWindow => ({ createdAfter, minEpoch });

  it('bounds on the ORIGINAL message time, not on when the row was archived', async () => {
    // THE core case. Both rows are archived NOW (back-fill), so an archival-time
    // bound would return both — which is the bug this join exists to prevent.
    const recent = await seedArchived(ago(2), 0);
    await seedArchived(ago(400), 0);

    const rows = await getArchiveWindowed(db as never, TOPIC, null, 100, win(ago(7), null));
    expect(rows.map((r) => r.messageId)).toEqual([recent]);

    // …and the unbounded read still returns both, proving the exclusion above
    // came from the window and not from the fixture.
    expect((await getArchiveSince(db as never, TOPIC, null, 100)).length).toBe(2);
  });

  it('a message exactly at the day boundary is INSIDE the window (inclusive floor)', async () => {
    const exact = await seedArchived(ago(7), 0);
    const justOutside = await seedArchived(new Date(ago(7).getTime() - 1), 0);

    const ids = (await getArchiveWindowed(db as never, TOPIC, null, 100, win(ago(7), null))).map((r) => r.messageId);
    expect(ids).toContain(exact);
    expect(ids).not.toContain(justOutside);
  });

  it('epoch floor selects by the original message epoch, inclusive', async () => {
    const e2 = await seedArchived(ago(1), 2);
    const e3 = await seedArchived(ago(1), 3);
    await seedArchived(ago(1), 1);

    const ids = (await getArchiveWindowed(db as never, TOPIC, null, 100, win(null, 2))).map((r) => r.messageId);
    expect(new Set(ids)).toEqual(new Set([e2, e3]));
  });

  it('an archive row whose original message is gone is EXCLUDED from a bounded read', async () => {
    // Fail-closed: without the message row its age cannot be proven, so a
    // bounded reader must not receive it (the unbounded read still does).
    const orphanMsg = await seedMessage(ago(1), 0);
    await storeArchiveRow(db as never, TOPIC, orphanMsg, 0, Buffer.from('orphan'));
    const kept = await seedArchived(ago(1), 0);
    await db.delete(schema.chatMessages).where(eq(schema.chatMessages.id, orphanMsg));

    const ids = (await getArchiveWindowed(db as never, TOPIC, null, 100, win(ago(7), null))).map((r) => r.messageId);
    expect(ids).toEqual([kept]);
    expect((await getArchiveSince(db as never, TOPIC, null, 100)).length).toBe(2);
  });

  it('returns [] on an empty archive under every window shape', async () => {
    for (const w of [win(ago(7), null), win(null, 3), win(ago(1), 0)]) {
      expect(await getArchiveWindowed(db as never, TOPIC, null, 100, w)).toEqual([]);
    }
  });

  it('paging with the keyset cursor cannot walk past the floor', async () => {
    // The bound is in the WHERE clause, so it is re-applied on every page — a
    // client cannot page backwards out of its window.
    const inside = [await seedArchived(ago(1), 0), await seedArchived(ago(2), 0), await seedArchived(ago(3), 0)];
    await seedArchived(ago(90), 0);
    await seedArchived(ago(365), 0);

    const w = win(ago(7), null);
    const seen: string[] = [];
    let cursor = null as null | { createdAt: string; messageId: string };
    for (let page = 0; page < 10; page++) {
      const rows = await getArchiveWindowed(db as never, TOPIC, cursor, 1, w);
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.messageId));
      const last = rows[rows.length - 1];
      cursor = { createdAt: last.createdAt, messageId: last.messageId };
    }
    expect(new Set(seen)).toEqual(new Set(inside));
    expect(seen.length).toBe(3); // no duplicates across pages either
  });

  it('preserves keyset ordering and full timestamp precision across ties', async () => {
    // Same archival instant for several rows — the (created_at, message_id)
    // compound cursor must still page exactly, as it does for getArchiveSince.
    const ids = [
      await seedArchived(ago(1), 0),
      await seedArchived(ago(1), 0),
      await seedArchived(ago(1), 0),
    ];
    const w = win(ago(7), null);
    const seen: string[] = [];
    let cursor = null as null | { createdAt: string; messageId: string };
    for (let page = 0; page < 10; page++) {
      const rows = await getArchiveWindowed(db as never, TOPIC, cursor, 2, w);
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.messageId));
      const last = rows[rows.length - 1];
      cursor = { createdAt: last.createdAt, messageId: last.messageId };
    }
    expect(seen.length).toBe(3);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('returns the same row shape as the unbounded read (ciphertext + takVersion intact)', async () => {
    const id = await seedArchived(ago(1), 5);
    const [bounded] = await getArchiveWindowed(db as never, TOPIC, null, 100, win(ago(7), null));
    const [plain] = await getArchiveSince(db as never, TOPIC, null, 100);
    expect(bounded.messageId).toBe(id);
    expect(bounded).toEqual(plain);
  });
});
