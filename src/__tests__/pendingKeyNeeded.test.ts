/**
 * What a newly-opened account stream owes an account, against real Postgres.
 *
 * The live `key-needed` fan-out is Redis pub/sub, which is to say VOLATILE: an
 * event published while an account had nothing connected is gone. The host
 * replays deliveries latched while the mini-app was unmounted, but a KILLED app
 * takes that latch with it — so if the only key-holding device was closed at the
 * moment somebody joined, the newcomer's room stays locked until an unrelated
 * commit happens to fire another event. This query is the catch-up.
 *
 * Against real Postgres rather than a recording executor, because every claim
 * here is a property of the SQL — which tiers it selects, whose membership it
 * requires, how far back it looks, how it orders and truncates. A recorder can
 * only confirm the string was sent.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract      → a recent join in a private topic this account belongs to is
 *                   returned, carrying the epoch
 *   authorization → a topic the account is NOT a member of is never returned,
 *                   even though the join row exists — this decides who gets
 *                   nudged about which rooms
 *   integrity     → `public` and `dm` are excluded: neither needs a holder
 *                   woken, and including them would spend the budget on rooms
 *                   where nobody is waiting
 *   integrity     → one row per topic, at the NEWEST epoch, when several
 *                   devices joined the same room
 *   boundary      → a join just inside the 72h window is returned, one just
 *                   outside is not
 *   boundary      → the limit truncates, and truncates the OLDEST, because the
 *                   newest joins are the ones still waiting
 *   empty         → an account with no joins, and one with no memberships at
 *                   all, both return []
 *   hostile/UTF-8 → N/A: no free text reaches this query; it takes one user id
 *                   and returns ids and integers
 *   race          → N/A: a single read, advisory by design — a duplicate or a
 *                   miss both cost at most a delay the room's retry covers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { pendingKeyNeeded, JOIN_CATCH_UP_HOURS } from '@/lib/mls/deviceJoins';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

const HOLDER = 'pkn-holder';
const STRANGER = 'pkn-stranger';
/*
 * A prefix nothing else uses.
 *
 * It was `00000000-0000-4000-8000-0000000000`, which SWALLOWS the ids other
 * real-Postgres suites pick from the same obvious range — `chatDelivered-route`
 * uses `…000000000060` and `…061`. `wipe()` deletes by `LIKE prefix%`, so this
 * file quietly destroyed another file's fixtures whenever the two ran together,
 * and both passed in isolation. `dead` is hex, so this is still a valid uuid.
 */
const PREFIX = '0000dead-0000-4000-8000-0000000000';
const topicId = (n: number) => `${PREFIX}${String(n).padStart(2, '0')}`;

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

async function wipe() {
  // `topic_members` has no cascade on its topic FK, so it goes first — the
  // joins table does cascade, and users must outlive the topics they created.
  await db.execute(sql`DELETE FROM topic_members WHERE topic_id::text LIKE ${`${PREFIX}%`}`);
  await db.execute(sql`DELETE FROM topics WHERE id::text LIKE ${`${PREFIX}%`}`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${HOLDER}, ${STRANGER})`);
}

/** A topic of `visibility`, optionally with `HOLDER` as a member. */
async function makeTopic(
  n: number,
  visibility: 'public' | 'private' | 'secret' | 'dm',
  { member = true }: { member?: boolean } = {},
) {
  const id = topicId(n);
  await db.insert(schema.topics).values({
    id,
    title: `pkn topic ${n}`,
    creatorId: STRANGER,
    inviteCode: `pkn-invite-${n}`,
    visibility,
  });
  if (member) {
    await db.insert(schema.topicMembers).values({ topicId: id, userId: HOLDER, role: 'member' });
  }
  return id;
}

/** A device join `hoursAgo` old. Written directly: the age is the point. */
async function seedJoin(id: string, deviceId: string, epoch: number, hoursAgo = 1) {
  await db.execute(sql`
    INSERT INTO mls_device_joins (topic_id, device_id, leaf_identity, user_id, joined_epoch, joined_at)
    VALUES (${id}, ${deviceId}, ${`${STRANGER}:${deviceId}`}, ${STRANGER}, ${epoch},
            now() - (${hoursAgo} * INTERVAL '1 hour'))
  `);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  db = drizzle(pool, { schema });
  await wipe();
});

afterAll(async () => {
  await wipe();
  await pool.end();
});

beforeEach(async () => {
  await wipe();
  await db.insert(schema.users).values([
    { id: HOLDER, nickname: 'pkn_holder' },
    { id: STRANGER, nickname: 'pkn_stranger' },
  ]);
});

describe('pendingKeyNeeded — real Postgres', () => {
  it('CONTRACT: a recent join in a private topic is returned with its epoch', async () => {
    const id = await makeTopic(1, 'private');
    await seedJoin(id, 'dev-A', 7);

    expect(await pendingKeyNeeded(db, HOLDER)).toEqual([{ topicId: id, epoch: 7 }]);
  });

  it('CONTRACT: secret counts too', async () => {
    const id = await makeTopic(2, 'secret');
    await seedJoin(id, 'dev-A', 2);

    expect((await pendingKeyNeeded(db, HOLDER)).map((p) => p.topicId)).toEqual([id]);
  });

  it.each(['public', 'dm'] as const)('INTEGRITY: %s is excluded', async (visibility) => {
    // `public` keeps its root server-side and `dm` grants on accept, so no
    // holder needs waking. Including them would spend the budget on rooms
    // where nobody is waiting.
    const id = await makeTopic(3, visibility);
    await seedJoin(id, 'dev-A', 1);

    expect(await pendingKeyNeeded(db, HOLDER)).toEqual([]);
  });

  it('AUTHZ: a topic this account is not a member of is never returned', async () => {
    // The join row exists and the topic is private; the only thing missing is
    // this account's membership. Nudging here would tell somebody that a room
    // they are not in gained a device.
    const id = await makeTopic(4, 'private', { member: false });
    await seedJoin(id, 'dev-A', 1);

    expect(await pendingKeyNeeded(db, HOLDER)).toEqual([]);
  });

  it('INTEGRITY: several devices in one topic collapse to its NEWEST epoch', async () => {
    // One nudge per room. The newest epoch is the one a grant has to cover.
    const id = await makeTopic(5, 'private');
    await seedJoin(id, 'dev-A', 3, 5);
    await seedJoin(id, 'dev-B', 9, 1);
    await seedJoin(id, 'dev-C', 6, 3);

    expect(await pendingKeyNeeded(db, HOLDER)).toEqual([{ topicId: id, epoch: 9 }]);
  });

  it('BOUNDARY: just inside the window is returned, just outside is not', async () => {
    const inside = await makeTopic(6, 'private');
    const outside = await makeTopic(7, 'private');
    await seedJoin(inside, 'dev-A', 1, JOIN_CATCH_UP_HOURS - 1);
    await seedJoin(outside, 'dev-B', 1, JOIN_CATCH_UP_HOURS + 1);

    expect((await pendingKeyNeeded(db, HOLDER)).map((p) => p.topicId)).toEqual([inside]);
  });

  it('BOUNDARY: the limit keeps the NEWEST, and drops the oldest', async () => {
    /*
     * This runs before the first byte of the stream, so it is bounded. Which
     * end it keeps matters: the newest joins are the ones still waiting, and
     * an older one has either been resolved or is not worth re-attempting on
     * every app launch.
     */
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await makeTopic(10 + i, 'private');
      ids.push(id);
      // i=0 is the oldest.
      await seedJoin(id, 'dev-A', 1, 5 - i);
    }

    const got = await pendingKeyNeeded(db, HOLDER, 3);

    expect(got.map((p) => p.topicId)).toEqual([ids[4], ids[3], ids[2]]);
  });

  it.each([
    ['a member with no joins anywhere', true],
    ['an account with no memberships at all', false],
  ])('EMPTY: %s gets nothing', async (_label, member) => {
    await makeTopic(20, 'private', { member });

    expect(await pendingKeyNeeded(db, HOLDER)).toEqual([]);
  });

  it('EMPTY: an unknown account is empty, not an error', async () => {
    await expect(pendingKeyNeeded(db, 'pkn-nobody')).resolves.toEqual([]);
  });

  it('BOUNDARY: a zero limit asks for nothing and gets nothing', async () => {
    const id = await makeTopic(21, 'private');
    await seedJoin(id, 'dev-A', 1);

    expect(await pendingKeyNeeded(db, HOLDER, 0)).toEqual([]);
  });

  it('CONTRACT: the epoch is a number, not the bigint string the driver hands back', async () => {
    // `joined_epoch` is a bigint, and node-postgres parses those as STRINGS.
    // Passed through as-is it would reach the client as `"7"` and every
    // comparison against it would be quietly wrong.
    const id = await makeTopic(22, 'private');
    await seedJoin(id, 'dev-A', 9007199254740991);

    const [row] = await pendingKeyNeeded(db, HOLDER);
    expect(typeof row.epoch).toBe('number');
    expect(row.epoch).toBe(9007199254740991);
  });
});
