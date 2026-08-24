/**
 * WHICH rows `scripts/delete-dm-chat-archive.ts` reaches — against a real
 * database, using the statements the script itself ships.
 *
 * This test exists because the first version of that script was WRONG in the
 * one direction a migration script must never be wrong in, and every test that
 * existed at the time passed anyway. Its scope was `topics.kind = 'dm'`, which
 * was correct on the day the tier fix landed and stopped being correct the
 * moment that fix reached an environment: DMs created afterwards mint a root
 * with `archiveCount === 0`, and their archive rows are sealed under it and
 * perfectly readable. Measured before this file existed — staging held 24 DM
 * archive rows of which 22 were readable, and the local database held 227 of
 * which 172 were readable. The script would have destroyed all of them.
 *
 * So the assertion that matters is not "the dead rows go". It is "the READABLE
 * rows stay", and it is written first below.
 *
 * WHY A REAL DATABASE. The scope is a SQL predicate. A mocked client would
 * record that a query was issued and could not tell a predicate that spares a
 * row from one that deletes it — which is exactly the distinction that was
 * wrong. Same reasoning, and the same local-Postgres pattern, as
 * `chatDeliveryPurge.test.ts` and `archiveRetentionSweep.test.ts`.
 *
 * Nothing here commits: every case runs inside a transaction that is rolled
 * back, so the script's real behaviour is observed without changing a row.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   integrity (THE guard) → a DM WITH a fingerprint and rows is not matched
 *   contract              → a DM without one IS matched
 *   authorization/scope   → a public topic with rows and no fingerprint is not
 *                           matched, even though it fits the fingerprint half
 *   boundary              → tak_version 0 rows on both sides of the boundary are
 *                           decided by the fingerprint, never by the version
 *   boundary              → a DM with a fingerprint and NO rows is a no-op
 *   empty                 → an empty scope deletes nothing
 *   race/idempotence      → a second run inside the same transaction deletes 0
 *   hostile / UTF-8 / large → N/A: this statement reads `kind`, a fingerprint
 *                           and foreign keys. It never touches user text.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  DEAD_DM_ARCHIVE_WHERE,
  countDeadDmArchive,
  countReadableDmArchive,
  deleteDeadDmArchive,
} from '../../scripts/delete-dm-chat-archive';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

const USER = `scope-test-${randomUUID().slice(0, 8)}`;

let pool: Pool;
let client: PoolClient;

/** ids seeded per case, so assertions can name exactly which rows survived. */
interface Seeded {
  topicId: string;
  messageIds: string[];
}

async function seedTopic(opts: {
  kind: 'dm' | 'topic';
  fingerprint: string | null;
  rows: number;
  takVersion?: number;
}): Promise<Seeded> {
  const topicId = randomUUID();
  await client.query(
    `INSERT INTO topics (id, title, creator_id, invite_code, kind, visibility, archive_root_fingerprint)
     VALUES ($1::uuid, 'scope test', $2, $3, $4, 'secret', $5)`,
    [topicId, USER, `inv-${topicId.slice(-8)}`, opts.kind, opts.fingerprint],
  );
  const messageIds: string[] = [];
  for (let i = 0; i < opts.rows; i++) {
    const messageId = randomUUID();
    messageIds.push(messageId);
    await client.query(
      `INSERT INTO chat_archive (topic_id, message_id, tak_version, ciphertext)
       VALUES ($1::uuid, $2::uuid, $3, $4)`,
      [topicId, messageId, opts.takVersion ?? 0, Buffer.from(`sealed-${i}`)],
    );
  }
  return { topicId, messageIds };
}

/** Archive rows still present for a topic, after whatever just ran. */
async function rowsLeft(topicId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM chat_archive WHERE topic_id = $1::uuid',
    [topicId],
  );
  return rows[0].n;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  client = await pool.connect();
  await client.query(
    `INSERT INTO users (id, nickname) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [USER, `anon_${USER.slice(-8)}`],
  );
});

afterAll(async () => {
  await client.query('DELETE FROM users WHERE id = $1', [USER]).catch(() => {});
  client.release();
  await pool.end();
});

/*
 * Every case is a transaction that is rolled back. The seeded rows and the
 * delete are both inside it, so the shipped statement runs for real against
 * real rows and the database is unchanged afterwards.
 */
async function inRolledBackTx(body: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await body();
  } finally {
    await client.query('ROLLBACK');
  }
}

describe('delete-dm-chat-archive — what the scope reaches', () => {
  it('INTEGRITY: a DM that HAS a fingerprint keeps every row', async () => {
    /*
     * THE case the first version of this script failed, and the reason this
     * file exists. A fingerprint means a root was claimed, which means these
     * rows were sealed under it, which means they are readable history. There
     * is no version, count or date that distinguishes them from the dead ones —
     * only this column does.
     */
    await inRolledBackTx(async () => {
      const readable = await seedTopic({ kind: 'dm', fingerprint: 'ZmluZ2VycHJpbnQxMjM0', rows: 4 });
      const readableBefore = await countReadableDmArchive(client);

      await deleteDeadDmArchive(client);

      expect(await rowsLeft(readable.topicId), 'readable DM history was deleted').toBe(4);
      expect(await countReadableDmArchive(client)).toBe(readableBefore);
    });
  });

  it('CONTRACT: a DM with NO fingerprint loses its rows', async () => {
    await inRolledBackTx(async () => {
      const dead = await seedTopic({ kind: 'dm', fingerprint: null, rows: 3, takVersion: 2 });

      const deleted = await deleteDeadDmArchive(client);

      expect(deleted).toBeGreaterThanOrEqual(3);
      expect(await rowsLeft(dead.topicId)).toBe(0);
    });
  });

  it('BOUNDARY: tak_version 0 on both sides — the fingerprint decides, not the version', async () => {
    /*
     * A DM's first MLS epoch IS 0, so these two topics hold rows that are
     * byte-for-byte indistinguishable by version. A `tak_version = 0` filter —
     * the other scope that was considered — deletes both. Measured on the local
     * corpus: 172 readable rows and 7 dead ones share version 0.
     */
    await inRolledBackTx(async () => {
      const readable = await seedTopic({ kind: 'dm', fingerprint: 'ZmluZ2VycHJpbnQ1Njc4', rows: 2, takVersion: 0 });
      const dead = await seedTopic({ kind: 'dm', fingerprint: null, rows: 2, takVersion: 0 });

      await deleteDeadDmArchive(client);

      expect(await rowsLeft(readable.topicId), 'version 0 was treated as dead').toBe(2);
      expect(await rowsLeft(dead.topicId)).toBe(0);
    });
  });

  it('SCOPE: a public topic with rows and no fingerprint is never touched', async () => {
    /*
     * The fingerprint half alone would match this. A public topic's archive is
     * sealed under a SERVER-held root (`computeServerRoot`), which is why it can
     * have rows and a null fingerprint and still be entirely readable — the
     * fingerprint mechanism is not what settles a public root any more. `kind`
     * is what keeps this script off it.
     */
    await inRolledBackTx(async () => {
      const publicTopic = await seedTopic({ kind: 'topic', fingerprint: null, rows: 5 });

      await deleteDeadDmArchive(client);

      expect(await rowsLeft(publicTopic.topicId), 'a public topic archive was deleted').toBe(5);
    });
  });

  it('BOUNDARY: a fingerprinted DM with no rows at all is a no-op', async () => {
    await inRolledBackTx(async () => {
      const quiet = await seedTopic({ kind: 'dm', fingerprint: 'ZmluZ2VycHJpbnQ5OTk5', rows: 0 });
      await deleteDeadDmArchive(client);
      expect(await rowsLeft(quiet.topicId)).toBe(0);
    });
  });

  it('IDEMPOTENCE: a second pass deletes nothing', async () => {
    await inRolledBackTx(async () => {
      await seedTopic({ kind: 'dm', fingerprint: null, rows: 3 });

      const first = await deleteDeadDmArchive(client);
      const second = await deleteDeadDmArchive(client);

      expect(first).toBeGreaterThanOrEqual(3);
      expect(second).toBe(0);
      expect((await countDeadDmArchive(client)).rows).toBe(0);
    });
  });

  it('CONTRACT: the count and the delete are the same scope', async () => {
    /*
     * They are two statements sharing one exported fragment, and the failure
     * that matters is them disagreeing: a count that reports a safe number
     * while the delete reaches further is a script that gets approved and then
     * destroys something. Pinned at the DEFINITION, not at a repeated literal.
     */
    expect(DEAD_DM_ARCHIVE_WHERE).toContain('archive_root_fingerprint IS NULL');
    await inRolledBackTx(async () => {
      await seedTopic({ kind: 'dm', fingerprint: null, rows: 3 });
      await seedTopic({ kind: 'dm', fingerprint: 'ZmluZ2VycHJpbnRhYWFh', rows: 4 });

      const counted = (await countDeadDmArchive(client)).rows;
      const deleted = await deleteDeadDmArchive(client);

      expect(deleted).toBe(counted);
    });
  });
});
