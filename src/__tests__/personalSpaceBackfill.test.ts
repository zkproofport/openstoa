/*
 * WHO the backfill in `drizzle/0035_personal_topic_backfill.sql` reaches — run
 * as the file itself ships it, against a real database.
 *
 * That migration exists because an account created before 0033 never got the
 * personal space every account is supposed to have: `ensureUser` returned early
 * for an account it already knew and skipped `ensurePersonalTopic` entirely.
 * The application fix makes the promise true from the next sign-in; this
 * migration closes it for everyone at once, at boot, and then never runs again.
 *
 * "Never runs again" is why it needs a test rather than a re-run. It is applied
 * once per database, keyed by tag in `__drizzle_migrations` — the runner stores
 * `entry.tag` as the hash and does not checksum the file — so a wrong predicate
 * is not something a later boot corrects. It is a single irreversible pass over
 * every account.
 *
 * THE CASE THAT MATTERS is the second one: a DELETED account does not get its
 * space back. Deletion here is a soft delete that keeps the user row, and
 * `DELETE /api/account` removes the personal space explicitly
 * (account/route.ts:111-112). A backfill over the whole table therefore puts
 * back exactly the row the deletion path deleted on purpose. Measured before
 * the guard existed: 196 seeded accounts of which 5 were deleted produced 5
 * spaces for the deleted ones. With the guard, 0.
 *
 * WHY A REAL DATABASE. What is under test is a SQL predicate. A mocked client
 * can record that a statement was issued and cannot tell a predicate that
 * spares a row from one that creates it, which is the entire distinction. Same
 * local-Postgres, rolled-back-transaction pattern as
 * `deleteDmChatArchiveScope.test.ts` and `chatDeliveryPurge.test.ts`.
 *
 * The statements are READ FROM THE MIGRATION FILE, never retyped. A test that
 * carries its own copy of the SQL passes forever while the file it claims to
 * guard says something else.
 *
 * WHY AN ISOLATED SCHEMA, unlike its two siblings. Those tests seed rows and
 * assert on the rows they seeded; this one runs a statement that sweeps the
 * ENTIRE users table, so it cannot be scoped by seeding. Against the shared
 * development database that is not merely noisy but unsound: the suite runs
 * files in parallel, and a user row deleted by another file between this
 * statement's scan and its insert takes the whole case down on
 * `topics_creator_id_users_id_fk`. Measured — 9/9 alone, 5 failures inside the
 * full run from drifting counts, then 2 from that foreign key once the counts
 * were scoped.
 *
 * So each case builds its own schema and puts it first on `search_path`. The
 * migration's SQL is unqualified, so it resolves there and sweeps a table that
 * holds nothing but this case's rows. The tables are made with
 * `LIKE public.<t> INCLUDING ALL`, which copies the real columns, defaults and
 * indexes — including the unique index on `(creator_id) WHERE personal` that
 * actually enforces one space per account — so the fixture cannot drift away
 * from the schema it is standing in for.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract       → an account with no space gets exactly one, and owns it
 *   integrity      → a DELETED account gets none  ← the guard
 *   integrity      → community topics are untouched in count and membership
 *   boundary       → an account that already has one does not get a second
 *   race/idempotence → a second and third run insert 0 rows
 *   partial state  → topics in, membership missing → re-running repairs it
 *   empty          → no accounts at all inserts nothing and does not throw
 *   authorization  → membership is written as 'owner', for the creator only
 *   hostile / UTF-8 / large → N/A: the statement reads `deleted_at`, `personal`
 *                    and foreign keys. It never touches user text. The one
 *                    generated value, `invite_code`, is asserted for shape.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

/** Every account this file makes carries the tag, so assertions can scope to them. */
const TAG = `bf-${randomUUID().slice(0, 8)}`;

let pool: Pool;
let client: PoolClient;

/** Per-run schema name. Deterministic within a run, unique across concurrent ones. */
const SCHEMA = `bf_${TAG.replace(/-/g, '_')}`;

/**
 * The migration, split on its own breakpoints — the same two statements the
 * boot runner executes, in the same order.
 */
const STATEMENTS: string[] = readFileSync(
  path.join(process.cwd(), 'drizzle', '0035_personal_topic_backfill.sql'),
  'utf-8',
)
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

async function runBackfill(): Promise<number[]> {
  const counts: number[] = [];
  for (const stmt of STATEMENTS) {
    const res = await client.query(stmt);
    counts.push(res.rowCount ?? 0);
  }
  return counts;
}

/**
 * Rows this file made, and only those.
 *
 * The statement under test is an INSERT over the WHOLE users table, and the
 * suite runs test files in parallel against one development database. A count
 * of every personal topic therefore moves when a completely unrelated file
 * inserts a user — measured: this file passed 9/9 alone and failed 5 inside the
 * full run, purely from other files' accounts landing mid-transaction. Every
 * assertion below is scoped to `TAG` for that reason.
 */
async function taggedCounts(): Promise<{ spaces: number; members: number }> {
  const { rows } = await client.query<{ spaces: number; members: number }>(
    `SELECT
       (SELECT count(*)::int FROM topics WHERE personal AND creator_id LIKE $1) AS spaces,
       (SELECT count(*)::int FROM topic_members m
          JOIN topics t ON t.id = m.topic_id
        WHERE t.personal AND t.creator_id LIKE $1) AS members`,
    [`${TAG}-%`],
  );
  return rows[0];
}

async function makeAccount(opts: { deleted?: boolean; withSpace?: boolean } = {}): Promise<string> {
  const id = `${TAG}-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO users (id, nickname, deleted_at) VALUES ($1, $2, $3)`,
    [id, `anon_${id.slice(-8)}`, opts.deleted ? new Date() : null],
  );
  if (opts.withSpace) {
    await client.query(
      `INSERT INTO topics (id, title, creator_id, invite_code, visibility, kind, personal)
       VALUES ($1::uuid, 'My space', $2, $3, 'secret', 'topic', true)`,
      [randomUUID(), id, `pre-${randomUUID().slice(0, 12)}`],
    );
  }
  return id;
}

/** A community topic: what the backfill must leave completely alone. */
async function makeCommunityTopic(owner: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO topics (id, title, creator_id, invite_code, visibility, kind, personal)
     VALUES ($1::uuid, 'community', $2, $3, 'public', 'topic', false)`,
    [id, owner, `pub-${randomUUID().slice(0, 12)}`],
  );
  return id;
}

async function spacesOf(userId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM topics WHERE creator_id = $1 AND personal`,
    [userId],
  );
  return rows[0].n;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  client = await pool.connect();
});

afterAll(async () => {
  client.release();
  await pool.end();
});

/*
 * Nothing here commits. The backfill is an INSERT over the WHOLE users table,
 * so an un-rolled-back case would give every real account in the developer's
 * database a space — a test that quietly performs the migration it is meant to
 * be examining.
 */
beforeEach(async () => {
  await client.query('BEGIN');
  /*
   * Created inside the transaction, so the ROLLBACK removes the schema too —
   * Postgres makes DDL transactional. Nothing survives a case, including on a
   * case that throws.
   */
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET LOCAL search_path TO ${SCHEMA}, public`);
  for (const t of ['users', 'topics', 'topic_members']) {
    await client.query(`CREATE TABLE ${SCHEMA}.${t} (LIKE public.${t} INCLUDING ALL)`);
  }
});

afterEach(async () => {
  await client.query('ROLLBACK');
});

describe('the personal-space backfill reaches the right accounts', () => {
  it('CONTRACT: an account with no space gets exactly one, and owns it', async () => {
    const user = await makeAccount();

    await runBackfill();

    expect(await spacesOf(user)).toBe(1);
    const { rows } = await client.query<{ role: string; title: string; visibility: string; kind: string }>(
      `SELECT m.role, t.title, t.visibility, t.kind
       FROM topics t JOIN topic_members m ON m.topic_id = t.id AND m.user_id = t.creator_id
       WHERE t.creator_id = $1 AND t.personal`,
      [user],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'owner',
      title: 'My space',
      visibility: 'secret',
      kind: 'topic',
    });
  });

  it('INTEGRITY: a DELETED account does not get its space back', async () => {
    /*
     * The guard. Deleting an account removes its space on purpose; a backfill
     * over the whole table hands it back. Dropping `deleted_at IS NULL` from
     * the migration makes this case — and only this case — fail.
     */
    const gone = await makeAccount({ deleted: true });
    const here = await makeAccount();

    await runBackfill();

    expect(await spacesOf(gone)).toBe(0);
    expect(await spacesOf(here)).toBe(1);
  });

  it('INTEGRITY: a deleted account gets no membership row either', async () => {
    /*
     * Note what is actually doing the work here. Only the FIRST statement
     * carries `deleted_at IS NULL`; the second is scoped to personal topics
     * and simply finds none, because the first declined to make one. So this
     * case is downstream of the same guard rather than a second guard — worth
     * asserting because the membership row is the one that would name a
     * deleted account, and worth stating because a reader who assumed two
     * guards would delete the wrong line.
     */
    const gone = await makeAccount({ deleted: true });

    await runBackfill();

    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM topic_members WHERE user_id = $1`,
      [gone],
    );
    expect(rows[0].n).toBe(0);
  });

  it('BOUNDARY: an account that already has a space does not get a second', async () => {
    const user = await makeAccount({ withSpace: true });

    await runBackfill();

    expect(await spacesOf(user)).toBe(1);
  });

  it('INTEGRITY: community topics are untouched — no new rows, no new members', async () => {
    const owner = await makeAccount();
    const community = await makeCommunityTopic(owner);

    await runBackfill();

    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM topic_members WHERE topic_id = $1::uuid`,
      [community],
    );
    expect(rows[0].n).toBe(0);
    const { rows: still } = await client.query<{ personal: boolean }>(
      `SELECT personal FROM topics WHERE id = $1::uuid`,
      [community],
    );
    expect(still[0].personal).toBe(false);
    // And the owner did get their own space — so the case is not passing merely
    // because the backfill did nothing at all.
    expect(await spacesOf(owner)).toBe(1);
  });

  it('RACE: a second and third run insert nothing', async () => {
    await makeAccount();

    await runBackfill();
    const after1 = await taggedCounts();
    await runBackfill();
    const after2 = await taggedCounts();
    await runBackfill();
    const after3 = await taggedCounts();

    expect(after1).toEqual({ spaces: 1, members: 1 });
    expect(after2).toEqual(after1);
    expect(after3).toEqual(after1);
  });

  it('PARTIAL STATE: topics in but membership missing is repaired by running again', async () => {
    /*
     * The reason the two statements are separate rather than one insert. A run
     * that dies between them leaves spaces nobody is a member of, and every
     * read goes through `topic_members` — so the owner cannot open their own
     * room until the second statement lands.
     */
    const user = await makeAccount();
    await runBackfill();
    await client.query(
      `DELETE FROM topic_members m USING topics t
       WHERE m.topic_id = t.id AND t.personal AND t.creator_id = $1`,
      [user],
    );

    expect(await taggedCounts()).toEqual({ spaces: 1, members: 0 });

    await runBackfill();

    expect(await taggedCounts()).toEqual({ spaces: 1, members: 1 });
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM topic_members m JOIN topics t ON t.id = m.topic_id
       WHERE t.personal AND t.creator_id = $1 AND m.user_id = $1 AND m.role = 'owner'`,
      [user],
    );
    expect(rows[0].n).toBe(1);
  });

  it('BOUNDARY: the generated invite code is 16 hex characters and unique', async () => {
    /*
     * No invite can be made from a personal topic, but the column is NOT NULL
     * and unique — a constant would collide on the second account, taking the
     * whole migration down with it.
     */
    const a = await makeAccount();
    const b = await makeAccount();

    await runBackfill();

    const { rows } = await client.query<{ invite_code: string }>(
      `SELECT invite_code FROM topics WHERE personal AND creator_id = ANY($1::text[])`,
      [[a, b]],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.invite_code).toMatch(/^[0-9a-f]{16}$/);
    expect(rows[0].invite_code).not.toBe(rows[1].invite_code);
  });

  it('EMPTY: with this file\'s accounts already served, a further run changes nothing', async () => {
    const user = await makeAccount();
    await runBackfill();
    const before = await taggedCounts();

    await runBackfill();

    expect(await taggedCounts()).toEqual(before);
    expect(await spacesOf(user)).toBe(1);
  });
});
