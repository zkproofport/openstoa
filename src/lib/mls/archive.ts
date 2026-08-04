/**
 * Phase 3 TAK back-fill — server-side Delivery Service data layer.
 *
 * The server stays crypto-free (C1) and plaintext-free (SI-1): it stores only
 * HPKE-wrapped TAK bundles and TAK-encrypted archive bodies as opaque bytes,
 * and never unwraps either. This module holds the SQL for:
 *   - tak_bundles: store / fetch-undelivered / ack-delivered (to-device, D5)
 *   - chat_archive: idempotent ingest / keyset-paginated read (back-fill)
 *   - archive_holders: single-winner lease succession (SI-6, public only) +
 *     epoch-fenced coverage update (SI-7)
 *
 * Structural `SqlExecutor` / `TxRunner` types (mirroring ./commits) so the
 * logic runs against the real `db` proxy in the route and an in-memory fake in
 * unit tests. The CVE-2024-47080/-47824 device-identity check (§5.5) is the
 * sender client's job (Stage B); the route enforces only the envelope here.
 */
import { sql } from 'drizzle-orm';

interface SqlExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}
interface TxRunner extends SqlExecutor {
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
interface Rows<T> {
  rows: T[];
}

// ---------------------------------------------------------------------------
// TAK bundles (to-device delivery)
// ---------------------------------------------------------------------------

/**
 * Store one HPKE-wrapped TAK bundle for a recipient device, DEDUPED: if an
 * undelivered bundle already exists for the same (topic, recipient device,
 * scope) it is NOT inserted again. This collapses the redundant re-distribution
 * a holder/granter does on every mount + join event (incl. React strict-mode
 * double-mounts) into one pending bundle per recipient. Returns the new id, or
 * '' when a duplicate was skipped.
 */
export async function storeTakBundle(
  executor: SqlExecutor,
  topicId: string,
  recipientUserId: string,
  recipientDeviceId: string,
  ciphertext: Buffer,
  scope: string,
): Promise<string> {
  const res = (await executor.execute(sql`
    INSERT INTO tak_bundles (topic_id, recipient_user_id, recipient_device_id, ciphertext, scope, created_at)
    SELECT ${topicId}, ${recipientUserId}, ${recipientDeviceId}, ${ciphertext}, ${scope}, now()
    WHERE NOT EXISTS (
      SELECT 1 FROM tak_bundles
      WHERE topic_id = ${topicId} AND recipient_device_id = ${recipientDeviceId}
        AND scope = ${scope} AND delivered_at IS NULL
    )
    RETURNING id
  `)) as Rows<{ id: string }>;
  return res.rows[0]?.id ?? '';
}

export interface PendingBundle {
  id: string;
  ciphertext: Buffer;
  scope: string;
  createdAt: string;
}

/**
 * Return a recipient device's not-yet-acked bundles, oldest first. This is
 * READ-ONLY — it does NOT stamp delivered_at, so a crash between fetch and
 * local persistence simply re-delivers on the next poll instead of silently
 * losing history (critical for private/secret tiers, where no other member can
 * re-derive the bundle). The recipient calls markBundlesDelivered after it has
 * durably stored the TAKs.
 */
export async function fetchUndeliveredBundles(
  executor: SqlExecutor,
  topicId: string,
  recipientDeviceId: string,
): Promise<PendingBundle[]> {
  // Addressed by device only. The MLS leaf credential is a device id, not the
  // user's nullifier, so a sender (which reads keys from the ratchet tree)
  // cannot know the recipient's user id — bundles are keyed by the leaf-derived
  // device id, and confidentiality comes from the HPKE wrap to that leaf's key.
  const res = (await executor.execute(sql`
    SELECT id, ciphertext, scope, created_at FROM tak_bundles
    WHERE topic_id = ${topicId}
      AND recipient_device_id = ${recipientDeviceId}
      AND delivered_at IS NULL
    ORDER BY created_at ASC, id ASC
  `)) as Rows<{ id: string; ciphertext: Buffer; scope: string; created_at: string | Date }>;
  return res.rows.map((r) => ({
    id: r.id,
    ciphertext: Buffer.from(r.ciphertext),
    scope: r.scope,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/**
 * Ack delivery: stamp delivered_at for the caller's own bundles after it has
 * persisted them. Scoped to (topic, recipient user, recipient device) so a
 * recipient can only ack its own bundles, never another device's. Returns the
 * count actually marked (already-acked / foreign ids are ignored).
 */
export async function markBundlesDelivered(
  executor: SqlExecutor,
  topicId: string,
  recipientDeviceId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  // Build an explicit `IN (...)` list. A bare `${ids}` array would be flattened
  // into multiple bind params by the sql tagger, and `= ANY(${ids})` mis-encodes
  // the array — so cast each id to uuid and join them.
  const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const res = (await executor.execute(sql`
    UPDATE tak_bundles SET delivered_at = now()
    WHERE topic_id = ${topicId}
      AND recipient_device_id = ${recipientDeviceId}
      AND delivered_at IS NULL
      AND id IN (${idList})
    RETURNING id
  `)) as Rows<{ id: string }>;
  return res.rows.length;
}

// ---------------------------------------------------------------------------
// Archive store (TAK-re-encrypted history)
// ---------------------------------------------------------------------------

/**
 * Idempotently store one TAK-encrypted archive body. One row per
 * (topic, message): a retry or two senders racing the same message do not
 * duplicate (ON CONFLICT DO NOTHING). Returns true if a new row was written.
 */
export async function storeArchiveRow(
  executor: SqlExecutor,
  topicId: string,
  messageId: string,
  takVersion: number,
  ciphertext: Buffer,
): Promise<boolean> {
  const res = (await executor.execute(sql`
    INSERT INTO chat_archive (topic_id, message_id, tak_version, ciphertext, created_at)
    VALUES (${topicId}, ${messageId}, ${takVersion}, ${ciphertext}, now())
    ON CONFLICT (topic_id, message_id) DO NOTHING
    RETURNING id
  `)) as Rows<{ id: string }>;
  return res.rows.length > 0;
}

export interface ArchiveCursor {
  createdAt: string; // ISO timestamp of the last row returned
  messageId: string; // tiebreak for rows sharing a timestamp
}

export interface ArchiveRow {
  messageId: string;
  takVersion: number;
  ciphertext: Buffer;
  createdAt: string;
}

/**
 * Keyset-paginated archive read, ascending by (created_at, message_id). The
 * compound cursor makes pagination exact even when rows share a timestamp — no
 * row is skipped or returned twice across pages (back-fill integrity). `cursor`
 * null reads from the beginning; `limit` bounds the page.
 */
export async function getArchiveSince(
  executor: SqlExecutor,
  topicId: string,
  cursor: ArchiveCursor | null,
  limit: number,
): Promise<ArchiveRow[]> {
  // created_at is returned with FULL microsecond precision via to_json — NOT
  // through a JS Date, which truncates to milliseconds. The cursor is fed back
  // verbatim and cast to timestamptz, so a row whose sub-millisecond fraction
  // differs from the truncated value can neither be skipped nor re-returned.
  const query = cursor
    ? sql`
        SELECT message_id, tak_version, ciphertext, to_json(created_at)#>>'{}' AS created_at FROM chat_archive
        WHERE topic_id = ${topicId}
          AND (created_at, message_id) > (${cursor.createdAt}::timestamptz, ${cursor.messageId}::uuid)
        ORDER BY created_at ASC, message_id ASC
        LIMIT ${limit}`
    : sql`
        SELECT message_id, tak_version, ciphertext, to_json(created_at)#>>'{}' AS created_at FROM chat_archive
        WHERE topic_id = ${topicId}
        ORDER BY created_at ASC, message_id ASC
        LIMIT ${limit}`;
  const res = (await executor.execute(query)) as Rows<{
    message_id: string;
    tak_version: number;
    ciphertext: Buffer;
    created_at: string;
  }>;
  return res.rows.map((r) => ({
    messageId: r.message_id,
    takVersion: Number(r.tak_version),
    ciphertext: Buffer.from(r.ciphertext),
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// public archive-root identity (§5.2 public tier)
// ---------------------------------------------------------------------------

export interface ArchiveRootIdentity {
  /** base64 HKDF tag of the topic's public archive root, or null if unclaimed. */
  fingerprint: string | null;
  /** How many archive rows this topic has. Non-zero PROVES a root already exists. */
  archiveCount: number;
}

/**
 * Read the public archive root's published identity together with the archive
 * row count — in ONE query, because a client must weigh both before it is
 * allowed to mint a root:
 *
 *   fingerprint != null            → a root is claimed; adopt it or prove you match
 *   fingerprint == null, count > 0 → a root exists but predates this column
 *                                    (every topic in production right now). Minting
 *                                    here is exactly the bug: the new random root
 *                                    orphans every existing row.
 *   fingerprint == null, count == 0 → genesis; minting is safe
 *
 * `COUNT(*)` is metadata the server already holds; it decrypts nothing, so this
 * keeps the DS crypto-free (C1). The count is deliberately taken from
 * `chat_archive` and not `tak_bundles`: bundle rows are DELETED on delivery, so
 * their absence proves nothing, whereas an archive row is permanent evidence.
 */
export async function getArchiveRootIdentity(
  executor: SqlExecutor,
  topicId: string,
): Promise<ArchiveRootIdentity> {
  const res = (await executor.execute(sql`
    SELECT t.archive_root_fingerprint AS fingerprint,
           (SELECT count(*) FROM chat_archive a WHERE a.topic_id = t.id) AS archive_count
    FROM topics t WHERE t.id = ${topicId}
  `)) as Rows<{ fingerprint: string | null; archive_count: string | number }>;
  const row = res.rows[0];
  if (!row) return { fingerprint: null, archiveCount: 0 };
  return { fingerprint: row.fingerprint ?? null, archiveCount: Number(row.archive_count) };
}

export interface RootClaimResult {
  /** The fingerprint now published for the topic — the caller's, or the winner's. */
  fingerprint: string;
  /** True when the caller's value is the one that took hold. */
  claimed: boolean;
}

/**
 * COMPARE-AND-SET the public archive root fingerprint: it is only ever written
 * over NULL, never over an existing value. First writer wins, permanently.
 *
 * This is the whole anti-clobber guarantee. Two devices racing to create the
 * first root both post their own fingerprint; exactly one UPDATE matches the
 * `IS NULL` predicate (Postgres re-evaluates it after taking the row lock), so
 * the loser gets the WINNER's fingerprint back and must adopt the winner's root
 * instead of archiving under its own — which is what previously produced rows
 * nobody could ever read. A later attempt to publish a different fingerprint is
 * likewise rejected, so a rogue or stale device can never re-point a topic's
 * archive identity at a root of its choosing.
 *
 * The server does NOT verify that the fingerprint corresponds to any real root —
 * it cannot (C1). Proving the root actually opens this topic's history is the
 * CLIENT's job before it calls this (see takSession.resolveRoot).
 */
export async function claimArchiveRootFingerprint(
  executor: SqlExecutor,
  topicId: string,
  fingerprint: string,
): Promise<RootClaimResult | null> {
  const upd = (await executor.execute(sql`
    UPDATE topics SET archive_root_fingerprint = ${fingerprint}
    WHERE id = ${topicId} AND archive_root_fingerprint IS NULL
    RETURNING archive_root_fingerprint
  `)) as Rows<{ archive_root_fingerprint: string }>;
  if (upd.rows.length > 0) return { fingerprint, claimed: true };

  // Lost the CAS (or the topic is gone). Re-read so the caller learns the
  // winning value and can adopt it rather than silently keep its own.
  const cur = (await executor.execute(sql`
    SELECT archive_root_fingerprint AS fingerprint FROM topics WHERE id = ${topicId}
  `)) as Rows<{ fingerprint: string | null }>;
  const row = cur.rows[0];
  if (!row || row.fingerprint == null) return null; // topic missing — caller 404s
  return { fingerprint: row.fingerprint, claimed: row.fingerprint === fingerprint };
}

// ---------------------------------------------------------------------------
// archive-holder succession (SI-6, public topics only)
// ---------------------------------------------------------------------------

export interface HolderState {
  holderUserId: string;
  holderDeviceId: string;
  epochCovered: number;
  successionRank: number;
  leaseExpiresAt: string | null;
}

export type HolderClaimResult =
  | { ok: true; renewed: boolean; state: HolderState }
  | { ok: false; reason: 'held-by-other'; state: HolderState };

/**
 * Claim or renew the archive-holder lease — SINGLE-WINNER (SI-6). The row lock
 * serializes competing claimers so the public seed chain never forks: at most
 * one holder exists at a time. Rules under the lock:
 *   - no row yet → this caller becomes holder (genesis; race-safe via ON CONFLICT).
 *   - caller already holds → renew the lease.
 *   - someone else holds and the lease is still valid → rejected (held-by-other).
 *   - the lease has expired → this caller takes over (epoch_covered is inherited;
 *     the new holder resumes forward-rewrap from there).
 * Succession ORDER (prefer lowest rank) is a client policy (Stage B): the server
 * only guarantees mutual exclusion, not who should win.
 */
export async function claimOrRenewHolder(
  db: TxRunner,
  topicId: string,
  userId: string,
  deviceId: string,
  successionRank: number,
  leaseSeconds: number,
): Promise<HolderClaimResult> {
  return db.transaction(async (tx) => {
    const read = async (): Promise<HolderState | null> => {
      const r = (await tx.execute(sql`
        SELECT holder_user_id, holder_device_id, epoch_covered, succession_rank, holder_lease_expires_at,
               (holder_lease_expires_at IS NOT NULL AND holder_lease_expires_at > now()) AS lease_valid
        FROM archive_holders WHERE topic_id = ${topicId} FOR UPDATE
      `)) as Rows<{
        holder_user_id: string;
        holder_device_id: string;
        epoch_covered: string | number;
        succession_rank: number;
        holder_lease_expires_at: string | Date | null;
        lease_valid: boolean;
      }>;
      const row = r.rows[0];
      if (!row) return null;
      return {
        holderUserId: row.holder_user_id,
        holderDeviceId: row.holder_device_id,
        epochCovered: Number(row.epoch_covered),
        successionRank: row.succession_rank,
        leaseExpiresAt: row.holder_lease_expires_at ? new Date(row.holder_lease_expires_at).toISOString() : null,
      };
    };
    const leaseValid = async (): Promise<boolean> => {
      const r = (await tx.execute(sql`
        SELECT (holder_lease_expires_at IS NOT NULL AND holder_lease_expires_at > now()) AS v
        FROM archive_holders WHERE topic_id = ${topicId}
      `)) as Rows<{ v: boolean }>;
      return r.rows[0]?.v === true;
    };

    const existing = await read();

    if (!existing) {
      // Genesis claim. FOR UPDATE can't lock a non-existent row, so two first
      // claimers can both reach here; ON CONFLICT DO NOTHING lets exactly one
      // win and the loser falls through to re-read the winner's row.
      const ins = (await tx.execute(sql`
        INSERT INTO archive_holders
          (topic_id, holder_user_id, holder_device_id, epoch_covered, succession_rank, holder_lease_expires_at, updated_at)
        VALUES (${topicId}, ${userId}, ${deviceId}, 0, ${successionRank}, now() + make_interval(secs => ${leaseSeconds}), now())
        ON CONFLICT (topic_id) DO NOTHING
        RETURNING holder_user_id
      `)) as Rows<unknown>;
      if (ins.rows.length > 0) {
        const state = await read();
        return { ok: true, renewed: false, state: state! };
      }
      // Lost the genesis race — fall through to the established-row branch.
    }

    const cur = (await read())!;
    const isSelf = cur.holderUserId === userId && cur.holderDeviceId === deviceId;
    const valid = await leaseValid();

    if (valid && !isSelf) {
      return { ok: false, reason: 'held-by-other', state: cur };
    }

    // Renew (self) or take over (expired lease). epoch_covered is preserved so a
    // new holder resumes forward-rewrap from where the previous one stopped.
    await tx.execute(sql`
      UPDATE archive_holders
      SET holder_user_id = ${userId}, holder_device_id = ${deviceId}, succession_rank = ${successionRank},
          holder_lease_expires_at = now() + make_interval(secs => ${leaseSeconds}), updated_at = now()
      WHERE topic_id = ${topicId}
    `);
    const state = await read();
    return { ok: true, renewed: isSelf, state: state! };
  });
}

export type CoverageResult =
  | { ok: true; epochCovered: number; currentEpoch: number }
  | { ok: false; reason: 'no-group' | 'not-holder' | 'future-epoch'; currentEpoch?: number };

/**
 * Record how far the holder has forward-rewrapped the seed chain — EPOCH-FENCED
 * (SI-7). It locks the mls_groups row (the SAME FOR UPDATE row applyCommitCas
 * locks), so a Commit cannot advance current_epoch while coverage is recorded.
 * Coverage above the current epoch is impossible (future-epoch rejected); when
 * the recorded coverage trails a freshly-advanced epoch the holder simply sees
 * the gap on its next read and rewraps forward. The fence guarantees the stored
 * epoch_covered always corresponds to a real committed epoch — never a torn
 * read straddling a concurrent Commit.
 */
export async function updateHolderCoverage(
  db: TxRunner,
  topicId: string,
  userId: string,
  deviceId: string,
  claimedEpoch: number,
): Promise<CoverageResult> {
  return db.transaction(async (tx) => {
    const grp = (await tx.execute(sql`
      SELECT current_epoch FROM mls_groups WHERE topic_id = ${topicId} FOR UPDATE
    `)) as Rows<{ current_epoch: string | number }>;
    if (!grp.rows[0]) return { ok: false, reason: 'no-group' as const };
    const current = Number(grp.rows[0].current_epoch);
    if (claimedEpoch > current) return { ok: false, reason: 'future-epoch' as const, currentEpoch: current };

    const upd = (await tx.execute(sql`
      UPDATE archive_holders SET epoch_covered = ${claimedEpoch}, updated_at = now()
      WHERE topic_id = ${topicId} AND holder_user_id = ${userId} AND holder_device_id = ${deviceId}
      RETURNING epoch_covered
    `)) as Rows<unknown>;
    if (upd.rows.length === 0) return { ok: false, reason: 'not-holder' as const, currentEpoch: current };
    return { ok: true, epochCovered: claimedEpoch, currentEpoch: current };
  });
}

/** Read the current holder state (or null if none assigned). */
export async function getHolder(executor: SqlExecutor, topicId: string): Promise<HolderState | null> {
  const r = (await executor.execute(sql`
    SELECT holder_user_id, holder_device_id, epoch_covered, succession_rank, holder_lease_expires_at
    FROM archive_holders WHERE topic_id = ${topicId}
  `)) as Rows<{
    holder_user_id: string;
    holder_device_id: string;
    epoch_covered: string | number;
    succession_rank: number;
    holder_lease_expires_at: string | Date | null;
  }>;
  const row = r.rows[0];
  if (!row) return null;
  return {
    holderUserId: row.holder_user_id,
    holderDeviceId: row.holder_device_id,
    epochCovered: Number(row.epoch_covered),
    successionRank: row.succession_rank,
    leaseExpiresAt: row.holder_lease_expires_at ? new Date(row.holder_lease_expires_at).toISOString() : null,
  };
}
