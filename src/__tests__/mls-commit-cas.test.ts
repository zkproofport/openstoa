/**
 * SI-2 integration test: MLS Commit epoch-CAS — fork safety + liveness (G3).
 *
 * Real local Postgres (not mocks): the invariant lives in the transaction
 * (FOR UPDATE + CAS UPDATE), so concurrency must be genuine. Requires the local
 * dev DB (DATABASE_URL or default).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { applyCommitCas, getCommitsSince } from '@/lib/mls/commits';
import { MLS_CIPHERSUITE } from '@/lib/mls/http';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

const TEST_USER = 'si2-test-user';
const TEST_TOPIC = '00000000-0000-4000-8000-0000000051c2'; // fixed test uuid
const GID = Buffer.from('grp-commit-test');
const COMMIT = Buffer.from('commit-bytes');
const WELCOME = Buffer.from('welcome-bytes');

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

async function resetGroup() {
  await db.delete(schema.mlsCommits).where(eq(schema.mlsCommits.topicId, TEST_TOPIC));
  await db.delete(schema.mlsGroups).where(eq(schema.mlsGroups.topicId, TEST_TOPIC));
}
async function currentEpoch(): Promise<number | null> {
  const r = (await db.execute(
    sql`SELECT current_epoch FROM mls_groups WHERE topic_id = ${TEST_TOPIC}`,
  )) as unknown as { rows: Array<{ current_epoch: string | number }> };
  return r.rows.length ? Number(r.rows[0].current_epoch) : null;
}
async function commitCount(): Promise<number> {
  const r = (await db.execute(
    sql`SELECT count(*)::int AS n FROM mls_commits WHERE topic_id = ${TEST_TOPIC}`,
  )) as unknown as { rows: Array<{ n: number }> };
  return Number(r.rows[0].n);
}
const cas = (asserted: number, gid = GID) =>
  applyCommitCas(db, TEST_TOPIC, asserted, gid, COMMIT, WELCOME, null, MLS_CIPHERSUITE);

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 12 });
  db = drizzle(pool, { schema });
  await resetGroup();
  await db.delete(schema.topics).where(eq(schema.topics.id, TEST_TOPIC));
  await db.delete(schema.users).where(eq(schema.users.id, TEST_USER));
  await db.insert(schema.users).values({ id: TEST_USER, nickname: 'si2_test_user' });
  await db.insert(schema.topics).values({
    id: TEST_TOPIC,
    title: 'SI-2 test topic',
    creatorId: TEST_USER,
    inviteCode: 'si2-invite-code',
  });
});

afterAll(async () => {
  await resetGroup();
  await db.delete(schema.topics).where(eq(schema.topics.id, TEST_TOPIC));
  await db.delete(schema.users).where(eq(schema.users.id, TEST_USER));
  await pool.end();
});

beforeEach(async () => {
  await resetGroup();
});

describe('SI-2 — Commit epoch-CAS', () => {
  it('genesis commit (asserted 0) creates the group at epoch 1', async () => {
    const r = await cas(0);
    expect(r.ok).toBe(true);
    expect(r.newEpoch).toBe(1);
    expect(await currentEpoch()).toBe(1);
    expect(await commitCount()).toBe(1);
  });

  it('rejects genesis that does not assert epoch 0', async () => {
    const r = await cas(5);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-genesis');
    expect(await currentEpoch()).toBeNull();
  });

  it('advances monotonically when each Commit asserts the current epoch', async () => {
    expect((await cas(0)).newEpoch).toBe(1);
    expect((await cas(1)).newEpoch).toBe(2);
    expect((await cas(2)).newEpoch).toBe(3);
    expect(await currentEpoch()).toBe(3);
  });

  it('rejects a Commit whose group_id does not match the group', async () => {
    await cas(0); // genesis with GID
    const r = await cas(1, Buffer.from('different-group'));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('group-mismatch');
  });

  it('SI-2 safety: K concurrent Commits on the same epoch → exactly one wins, no fork', async () => {
    await cas(0); // group now at epoch 1
    const K = 8;
    const results = await Promise.all(Array.from({ length: K }, () => cas(1)));
    const winners = results.filter((r) => r.ok);
    const forks = results.filter((r) => !r.ok && r.reason === 'fork');
    expect(winners.length).toBe(1);
    expect(forks.length).toBe(K - 1);
    expect(winners[0].newEpoch).toBe(2);
    // No fork: epoch advanced exactly once; exactly one new commit row at epoch 2.
    expect(await currentEpoch()).toBe(2);
    expect(await commitCount()).toBe(2); // genesis(1) + the single winner(2)
  });

  it('SI-2 liveness (G3): K committers all succeed within bounded retries, no starvation', async () => {
    await cas(0); // group at epoch 1
    const K = 6;
    const maxRounds = 4 * K;
    async function committer() {
      for (let round = 1; round <= maxRounds; round++) {
        const asserted = (await currentEpoch()) ?? 0;
        const r = await applyCommitCas(db, TEST_TOPIC, asserted, GID, COMMIT, WELCOME, null, MLS_CIPHERSUITE);
        if (r.ok) return round;
      }
      return -1;
    }
    const rounds = await Promise.all(Array.from({ length: K }, () => committer()));
    expect(rounds.every((r) => r > 0)).toBe(true); // all eventually succeeded
    expect(await currentEpoch()).toBe(1 + K); // each advanced the epoch exactly once
    expect(await commitCount()).toBe(1 + K);
  });
});

describe('catch-up — getCommitsSince', () => {
  it('returns missed Commits in ascending epoch order', async () => {
    await cas(0);
    await cas(1);
    await cas(2);
    const all = await getCommitsSince(db, TEST_TOPIC, 0);
    expect(all.map((c) => c.epoch)).toEqual([1, 2, 3]);
    expect(all[0].welcome?.equals(WELCOME)).toBe(true);

    const since2 = await getCommitsSince(db, TEST_TOPIC, 2);
    expect(since2.map((c) => c.epoch)).toEqual([3]);
  });
});
