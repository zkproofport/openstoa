/**
 * Delete the `chat_archive` rows of a DM that NOTHING can ever decrypt.
 *
 * WHY THESE ROWS ARE NOT HISTORY. Before the chat-tier fix, a DM's key model was
 * read from its topic ROW, which carries `visibility: 'secret'` — so every DM
 * message was archived under a PER-EPOCH key, while `chatTierPolicy` declared
 * DMs seal their whole conversation under one topic-wide root. A DM now resolves
 * as `topic-root`, and `TakSessionStore.backfill` never reaches for an epoch key
 * on a topic-root tier. Those rows are therefore unreadable to every device
 * including the one that wrote them, and no future key delivery changes that:
 * the epoch exporter secret is gone once the epoch advances, and the root that
 * gets minted was never the key they were sealed under. Dead ciphertext wearing
 * the shape of history.
 *
 * WHY DELETE RATHER THAN LEAVE. Two reasons, and the second is the one that
 * makes this more than tidying:
 *
 *  - `chat_archive` is UNIQUE on (topic_id, message_id). A dead row therefore
 *    OCCUPIES the one archive slot its message will ever get, so
 *    `backfillMissingArchive` — the self-healing pass that puts a readable
 *    message back into the archive under the key the room can actually open —
 *    skips it forever. Leaving the row does not preserve history; it prevents
 *    the history from being restored.
 *  - A device that opens such a DM sees rows it cannot decrypt and reports
 *    "history is still syncing" indefinitely, because from the client's side an
 *    undecryptable row is indistinguishable from one whose key has not arrived.
 *
 * OpenStoa has not launched. Legacy data is disposable here, and a compatibility
 * path for ciphertext nobody holds a key to would be a path to nothing.
 *
 * ── THE SCOPE, AND THE TWO SCOPES THAT WERE REJECTED ──────────────────────
 *
 * IN SCOPE:  `topics.kind = 'dm' AND topics.archive_root_fingerprint IS NULL`
 *
 * The fingerprint is the whole predicate, and it is exact rather than heuristic.
 * A row can only be sealed under a topic root once that root is VERIFIED
 * (`currentArchiveKey` refuses every other state); `verified` on the DM path is
 * reachable only through `claimRoot`; and `claimRoot` PUBLISHES the fingerprint
 * before it returns. The column is write-once and is never set back to NULL. So
 * `archive_root_fingerprint IS NULL` ⟹ no row on that topic was ever sealed
 * under a root ⟹ every row it has is per-epoch-era ciphertext. There is no
 * arrangement in which this deletes a readable row.
 *
 * `kind = 'dm'` stays alongside it. It is the tier whose key model changed, it
 * is the only tier that can be in this state, and narrowing to it costs nothing.
 *
 * REJECTED — `kind = 'dm'` ALONE. This is what the first version of this script
 * did, and it was wrong. The tier fix is already deployed, so DMs created since
 * then minted roots with `archiveCount === 0` and their rows are sealed under
 * those roots and perfectly readable. Measured rather than argued:
 *
 *     staging   24 DM archive rows: 2 dead, 22 readable  → destroys 22 to clear 2
 *     local    227 DM archive rows: 55 dead, 172 readable → destroys 172 to clear 55
 *
 * REJECTED — `tak_version = 0`. A DM's first MLS epoch IS 0, so a topic-root row
 * and a legacy epoch-0 row carry the same version and the filter cuts across the
 * real boundary rather than along it. Measured on the local corpus:
 *
 *     tak_version = 0, fingerprint set   → 172 rows, ALL READABLE
 *     tak_version = 0, fingerprint NULL  →   7 rows, all dead
 *     tak_version > 0, fingerprint NULL  →  48 rows, all dead
 *
 * It would delete 172 readable rows and spare 48 dead ones — wrong in both
 * directions at once. (An earlier note in this file claimed the 179 version-0
 * rows were "all per-epoch ciphertext". That was false; 172 of them are the
 * readable topic-root rows this scope now protects.)
 *
 * ── SAFE ALWAYS, COMPLETE ONLY FOR A WHILE ────────────────────────────────
 *
 * These are different properties and only one of them is unconditional.
 *
 * SAFETY is permanent: by the argument above, this can never delete a readable
 * row, whenever it is run and however many times.
 *
 * COMPLETENESS has a horizon. Once the `computePeerRoot` guard fix ships, a
 * deadlocked DM finally mints and claims a root — which SETS its fingerprint
 * while its legacy dead rows are still sitting there. From that moment those
 * rows stop matching this predicate, and nothing can separate them from the
 * topic's new readable rows: `topics` has no claim timestamp to date-split on,
 * and the server cannot try a key it is not allowed to hold. So run this while
 * the deadlocked conversations are still deadlocked. Anything missed is inert
 * ciphertext that keeps blocking `backfillMissingArchive` for those messages —
 * bad, but bounded, and never a wrong deletion.
 *
 * ORPHANED ATTACHMENTS. Deleting an archive row does not delete the object it
 * referenced — the object key lives inside the sealed body, which the server
 * cannot read. That is the same position the retention sweep is in, and
 * reclaiming those bytes is the unclaimed-media sweep's job, not this script's.
 *
 * Idempotent: a second run matches nothing, deletes nothing, and prints zero.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/delete-dm-chat-archive.ts            # dry run
 *   DATABASE_URL=... npx tsx scripts/delete-dm-chat-archive.ts --apply    # writes
 */
import { Pool, type PoolClient } from 'pg';
import { pathToFileURL } from 'node:url';

const TAG = '[delete-dm-chat-archive]';

/**
 * The rows this script acts on, as ONE fragment shared by the count, the report
 * and the delete.
 *
 * Written once and exported because the scope IS the correctness argument here:
 * a predicate that drifted between "what we counted" and "what we deleted"
 * would report a safe number and perform an unsafe deletion.
 * `deleteDmChatArchiveScope.test.ts` runs THIS constant against a real database,
 * so the test cannot pass while the shipped statement disagrees with it.
 */
export const DEAD_DM_ARCHIVE_WHERE = `t.kind = 'dm' AND t.archive_root_fingerprint IS NULL`;

export interface DeadArchiveCounts {
  rows: number;
  topics: number;
  newestCreatedAt: string | null;
}

/** How much is in scope right now. */
export async function countDeadDmArchive(client: PoolClient): Promise<DeadArchiveCounts> {
  const { rows } = await client.query<{ rows: string; topics: string; newest: Date | null }>(
    `SELECT count(*)::text AS rows,
            count(DISTINCT a.topic_id)::text AS topics,
            max(a.created_at) AS newest
       FROM chat_archive a
       JOIN topics t ON t.id = a.topic_id
      WHERE ${DEAD_DM_ARCHIVE_WHERE}`,
  );
  return {
    rows: Number(rows[0].rows),
    topics: Number(rows[0].topics),
    newestCreatedAt: rows[0].newest ? rows[0].newest.toISOString() : null,
  };
}

/** Delete them. Returns the row count; the caller owns the transaction. */
export async function deleteDeadDmArchive(client: PoolClient): Promise<number> {
  const res = await client.query(
    `DELETE FROM chat_archive a
       USING topics t
      WHERE t.id = a.topic_id
        AND ${DEAD_DM_ARCHIVE_WHERE}`,
  );
  return res.rowCount ?? 0;
}

/** How many readable DM archive rows exist — the number this must never move. */
export async function countReadableDmArchive(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM chat_archive a
       JOIN topics t ON t.id = a.topic_id
      WHERE t.kind = 'dm' AND t.archive_root_fingerprint IS NOT NULL`,
  );
  return rows[0].n;
}

function report(label: string, c: DeadArchiveCounts): void {
  console.log(`${TAG} ${label}: ${c.rows} rows across ${c.topics} DM topics`);
  console.log(`${TAG}   newest row in scope: ${c.newestCreatedAt ?? '(none)'}`);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL environment variable is required');

  const APPLY = process.argv.includes('--apply');
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    console.log(`${TAG} mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
    console.log(`${TAG} scope: ${DEAD_DM_ARCHIVE_WHERE}`);
    const before = await countDeadDmArchive(client);
    const readableBefore = await countReadableDmArchive(client);
    report('BEFORE', before);
    console.log(`${TAG} readable DM archive rows (MUST NOT CHANGE): ${readableBefore}`);
    if (before.rows === 0) {
      console.log(`${TAG} nothing to do.`);
      return;
    }

    await client.query('BEGIN');
    const deleted = await deleteDeadDmArchive(client);
    // Read INSIDE the transaction, so a scope that reached too far is visible
    // here and can still be rolled back rather than reported afterwards.
    const readableAfter = await countReadableDmArchive(client);
    if (readableAfter !== readableBefore) {
      await client.query('ROLLBACK');
      throw new Error(
        `refusing to proceed: readable DM archive rows changed ${readableBefore} → ${readableAfter}`,
      );
    }

    if (APPLY) {
      await client.query('COMMIT');
      console.log(`${TAG} COMMITTED — ${deleted} rows deleted`);
      report('AFTER', await countDeadDmArchive(client));
      console.log(`${TAG} readable DM archive rows: ${await countReadableDmArchive(client)}`);
    } else {
      await client.query('ROLLBACK');
      console.log(`${TAG} DRY-RUN rolled back — would delete ${deleted} rows.`);
      console.log(`${TAG} readable rows untouched by the trial delete: ${readableAfter}`);
      console.log(`${TAG} pass --apply to write this change.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

/*
 * Only when RUN, never when imported. The test imports the statements above to
 * exercise the shipped scope against a real database; an unguarded `main()`
 * would make that import connect to `DATABASE_URL` and start deleting.
 */
const invokedDirectly =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`${TAG} failed:`, err);
    process.exit(1);
  });
}
