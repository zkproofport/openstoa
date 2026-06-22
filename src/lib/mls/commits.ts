/**
 * MLS Commit epoch-CAS (SI-2) + handshake catch-up log, shared by the HTTP
 * route and the concurrency test.
 *
 * SI-2 (safety): at most one Commit is accepted per epoch, so the group never
 * forks. The server reads the asserted epoch from the Commit framing
 * (crypto-free, see ./framing) and advances the authoritative `current_epoch`
 * only when it still equals that asserted value — an atomic compare-and-swap.
 *
 * Concurrency: `SELECT ... FOR UPDATE` on the mls_groups row serializes
 * competing committers; the loser re-reads the now-advanced epoch and gets a
 * clean `fork` result to retry on (SI-2 liveness / G3 — bounded retries, no
 * starvation, since every accepted Commit advances the epoch by exactly one).
 *
 * The Commit + Welcome are persisted to `mls_commits` in the SAME transaction
 * as the epoch advance; Redis fan-out happens OUTSIDE the transaction (G7), so
 * a mid-fan-out crash leaves consistent state that offline members recover by
 * pulling missed epochs via getCommitsSince().
 */
import { sql } from 'drizzle-orm';

export type CommitCasReason = 'fork' | 'group-mismatch' | 'bad-genesis';

export interface CommitCasResult {
  ok: boolean;
  newEpoch?: number;
  reason?: CommitCasReason;
}

// Structural types so this works with the `db` proxy and a tx alike.
interface SqlExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}
interface TxRunner {
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

interface Rows<T> {
  rows: T[];
}

export async function applyCommitCas(
  db: TxRunner,
  topicId: string,
  assertedEpoch: number,
  groupId: Buffer,
  commitBytes: Buffer,
  welcomeBytes: Buffer | null,
  groupInfoBytes: Buffer | null,
  ciphersuite: string,
): Promise<CommitCasResult> {
  return db.transaction(async (tx) => {
    const existing = (await tx.execute(sql`
      SELECT current_epoch, group_id FROM mls_groups WHERE topic_id = ${topicId} FOR UPDATE
    `)) as Rows<{ current_epoch: string | number; group_id: Buffer }>;
    const row = existing.rows[0];

    if (!row) {
      // Genesis — only valid when the Commit builds on epoch 0. ON CONFLICT
      // guards a concurrent genesis race: if another writer created the row
      // first, our insert affects 0 rows and we report `fork` so the loser
      // re-reads and retries against the now-existing group.
      if (assertedEpoch !== 0) return { ok: false, reason: 'bad-genesis' as const };
      const newEpoch = 1;
      const ins = (await tx.execute(sql`
        INSERT INTO mls_groups (topic_id, group_id, current_epoch, ciphersuite, group_info, created_at, updated_at)
        VALUES (${topicId}, ${groupId}, ${newEpoch}, ${ciphersuite}, ${groupInfoBytes}, now(), now())
        ON CONFLICT (topic_id) DO NOTHING
        RETURNING current_epoch
      `)) as Rows<unknown>;
      if (!ins.rows || ins.rows.length === 0) return { ok: false, reason: 'fork' as const };
      await tx.execute(sql`
        INSERT INTO mls_commits (topic_id, epoch, commit, welcome, created_at)
        VALUES (${topicId}, ${newEpoch}, ${commitBytes}, ${welcomeBytes}, now())
      `);
      return { ok: true, newEpoch };
    }

    // Established group — group_id must match, then epoch-CAS.
    if (!Buffer.from(row.group_id).equals(groupId)) {
      return { ok: false, reason: 'group-mismatch' as const };
    }
    const current = Number(row.current_epoch);
    if (current !== assertedEpoch) return { ok: false, reason: 'fork' as const };
    const newEpoch = assertedEpoch + 1;

    // CAS advance. WHERE current_epoch = assertedEpoch means a duplicate Commit
    // at the same epoch updates 0 rows (it lost). With the FOR UPDATE lock
    // above, exactly one concurrent committer advances per epoch.
    const upd = (await tx.execute(sql`
      UPDATE mls_groups
      SET current_epoch = ${newEpoch},
          group_info = COALESCE(${groupInfoBytes}, group_info),
          updated_at = now()
      WHERE topic_id = ${topicId} AND current_epoch = ${assertedEpoch}
      RETURNING current_epoch
    `)) as Rows<unknown>;
    if (!upd.rows || upd.rows.length === 0) return { ok: false, reason: 'fork' as const };

    await tx.execute(sql`
      INSERT INTO mls_commits (topic_id, epoch, commit, welcome, created_at)
      VALUES (${topicId}, ${newEpoch}, ${commitBytes}, ${welcomeBytes}, now())
    `);
    return { ok: true, newEpoch };
  });
}

export interface StoredCommit {
  epoch: number;
  commit: Buffer;
  welcome: Buffer | null;
}

/** Catch-up: every Commit with epoch strictly greater than `sinceEpoch`, in order. */
export async function getCommitsSince(
  executor: SqlExecutor,
  topicId: string,
  sinceEpoch: number,
): Promise<StoredCommit[]> {
  const res = (await executor.execute(sql`
    SELECT epoch, commit, welcome FROM mls_commits
    WHERE topic_id = ${topicId} AND epoch > ${sinceEpoch}
    ORDER BY epoch ASC
  `)) as Rows<{ epoch: string | number; commit: Buffer; welcome: Buffer | null }>;
  return res.rows.map((r) => ({
    epoch: Number(r.epoch),
    commit: Buffer.from(r.commit),
    welcome: r.welcome ? Buffer.from(r.welcome) : null,
  }));
}
