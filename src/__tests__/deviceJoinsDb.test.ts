/**
 * `mls_device_joins` against real Postgres (D-1).
 *
 * `deviceJoins.test.ts` runs the INSERT through a recording executor, which pins
 * the statement's shape and its parameters and nothing else. The three claims
 * that matter here are properties of the SQL and of the schema, and a recorder
 * cannot observe any of them: that `ON CONFLICT DO NOTHING` keeps the FIRST row
 * rather than the latest, that a null `user_id` survives the round trip, and
 * that the rows leave with their topic. Migration `0029_nervous_rawhide_kid`
 * creates the table; this suite is the thing that proves it did.
 *
 * Real local Postgres, in the manner of `mls-commit-cas.test.ts`.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   integrity     → a re-record keeps the FIRST joined_epoch and joined_at,
 *                   because moving them forward shrinks the window of messages
 *                   the device is owed — the one direction that loses data
 *   contract      → the first record reports true, the conflicting one false
 *   empty/null    → a device whose credential named no account round-trips as
 *                   SQL NULL, distinguishable from the empty string
 *   boundary      → a second, DIFFERENT device on the same topic is a new row,
 *                   not a conflict
 *   ext-dep       → deleting the topic cascades the rows away, so a dropped
 *                   topic cannot leave orphans behind for the retention sweep
 *   hostile/UTF-8 → a credential carrying wildcards, quotes and multi-script
 *                   text is stored verbatim (the statement is parameterised)
 *   authorization/race → N/A here: this is the storage layer. The gate is the
 *                   epoch-CAS above it, covered in `deviceJoinsRoute.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { recordDeviceJoin, type DeviceJoin } from '@/lib/mls/deviceJoins';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

const TEST_USER = 'd1-joins-test-user';
const TEST_TOPIC = '00000000-0000-4000-8000-00000000d100';

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

interface Row {
  device_id: string;
  leaf_identity: string | null;
  user_id: string | null;
  joined_epoch: string | number;
  // `db.execute` hands back whatever the driver parsed; a timestamptz arrives as
  // a string here rather than as the Date the ORM path would build.
  joined_at: string | Date;
}

const at = (v: string | Date) => new Date(v).getTime();

async function rows(topicId = TEST_TOPIC): Promise<Row[]> {
  const r = (await db.execute(
    sql`SELECT device_id, leaf_identity, user_id, joined_epoch, joined_at
        FROM mls_device_joins WHERE topic_id = ${topicId} ORDER BY device_id`,
  )) as unknown as { rows: Row[] };
  return r.rows;
}

const join = (over: Partial<DeviceJoin> = {}): DeviceJoin => ({
  deviceId: 'dev-A',
  leafIdentity: `${TEST_USER}:dev-A`,
  userId: TEST_USER,
  joinedEpoch: 1,
  ...over,
});

async function seedTopic() {
  await db.insert(schema.users).values({ id: TEST_USER, nickname: 'd1_joins_test_user' });
  await db.insert(schema.topics).values({
    id: TEST_TOPIC,
    title: 'D-1 device joins test topic',
    creatorId: TEST_USER,
    inviteCode: 'd1-joins-invite-code',
  });
}

async function dropTopic() {
  await db.execute(sql`DELETE FROM topics WHERE id = ${TEST_TOPIC}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${TEST_USER}`);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  db = drizzle(pool, { schema });
  await dropTopic();
});

afterAll(async () => {
  await dropTopic();
  await pool.end();
});

beforeEach(async () => {
  await dropTopic();
  await seedTopic();
});

describe('mls_device_joins — real Postgres', () => {
  it('CONTRACT: the first record writes and reports true', async () => {
    expect(await recordDeviceJoin(db, TEST_TOPIC, join())).toBe(true);
    const [row] = await rows();
    expect(row.device_id).toBe('dev-A');
    expect(row.leaf_identity).toBe(`${TEST_USER}:dev-A`);
    expect(row.user_id).toBe(TEST_USER);
    expect(Number(row.joined_epoch)).toBe(1);
  });

  it('INTEGRITY: a re-record keeps the FIRST epoch and the FIRST timestamp', async () => {
    // The window of messages a device is owed starts at its join. Letting a
    // later record move `joined_at` forward would silently shorten that window,
    // which is the only direction in which this table can lose data.
    await recordDeviceJoin(db, TEST_TOPIC, join());
    const [first] = await rows();

    // A later epoch, a different credential — the same device key.
    const reported = await recordDeviceJoin(
      db,
      TEST_TOPIC,
      join({ joinedEpoch: 99, leafIdentity: 'someone-else:dev-A', userId: 'someone-else' }),
    );

    expect(reported).toBe(false);
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(Number(after[0].joined_epoch)).toBe(1);
    expect(after[0].user_id).toBe(TEST_USER);
    expect(at(after[0].joined_at)).toBe(at(first.joined_at));
  });

  it('EMPTY: a credential that named no account round-trips as NULL, not as ""', async () => {
    await recordDeviceJoin(db, TEST_TOPIC, join({ leafIdentity: 'sdk-legacy-leaf', userId: null }));
    const [row] = await rows();
    expect(row.user_id).toBeNull();
    // The raw credential is KEPT, so null reads as "nobody could name it"
    // rather than "never looked at".
    expect(row.leaf_identity).toBe('sdk-legacy-leaf');
  });

  it('BOUNDARY: a second, different device is a new row rather than a conflict', async () => {
    expect(await recordDeviceJoin(db, TEST_TOPIC, join())).toBe(true);
    expect(await recordDeviceJoin(db, TEST_TOPIC, join({ deviceId: 'dev-B', leafIdentity: `${TEST_USER}:dev-B`, joinedEpoch: 2 }))).toBe(true);
    const all = await rows();
    expect(all.map((r) => r.device_id)).toEqual(['dev-A', 'dev-B']);
  });

  it('HOSTILE: wildcards, quotes and multi-script text are stored verbatim', async () => {
    // The statement is parameterised, so none of this is interpreted. A device
    // id that is 100% ilike-wildcard must not become a pattern that matches
    // every row when this table is later joined against.
    const nasty = `%_\\'"; drop table mls_device_joins; -- 한글 🙂`;
    expect(await recordDeviceJoin(db, TEST_TOPIC, join({ deviceId: nasty, leafIdentity: nasty }))).toBe(true);
    const [row] = await rows();
    expect(row.device_id).toBe(nasty);
    expect(row.leaf_identity).toBe(nasty);
  });

  it('EXT-DEP: the rows leave with their topic, so no orphans survive a deletion', async () => {
    await recordDeviceJoin(db, TEST_TOPIC, join());
    await recordDeviceJoin(db, TEST_TOPIC, join({ deviceId: 'dev-B' }));
    expect(await rows()).toHaveLength(2);

    await db.execute(sql`DELETE FROM topics WHERE id = ${TEST_TOPIC}`);
    expect(await rows()).toHaveLength(0);
  });
});
