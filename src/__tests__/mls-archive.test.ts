/**
 * Phase 3 TAK back-fill — server data layer (real local Postgres).
 *
 * Mirrors mls-commit-cas.test.ts: the invariants (idempotency, keyset
 * pagination exactness, single-winner holder lease, epoch-fence) live in SQL
 * and transactions, so they are exercised against a real DB, not mocks.
 * Requires the local dev DB (DATABASE_URL or default).
 *
 * Covers the Stage-A edge matrix: scope allowlist (hostile), bundle
 * deliver/fetch/ack (+ack scoping), archive idempotency + keyset integrity
 * (no skip/dup across ties), holder single-winner + lease takeover (SI-6),
 * coverage epoch-fence (SI-7 future-epoch guard + not-holder).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { isValidTakScope, MLS_CIPHERSUITE } from '@/lib/mls/http';
import {
  storeTakBundle,
  fetchUndeliveredBundles,
  markBundlesDelivered,
  storeArchiveRow,
  getArchiveSince,
  claimOrRenewHolder,
  updateHolderCoverage,
  getHolder,
  type ArchiveCursor,
} from '@/lib/mls/archive';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

const USER_A = 'tak-test-user-a';
const USER_B = 'tak-test-user-b';
const TOPIC = '00000000-0000-4000-8000-0000000071a3'; // fixed test uuid
const DEV_1 = 'device-1';
const DEV_2 = 'device-2';

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

async function clean() {
  await db.delete(schema.takBundles).where(eq(schema.takBundles.topicId, TOPIC));
  await db.delete(schema.chatArchive).where(eq(schema.chatArchive.topicId, TOPIC));
  await db.delete(schema.archiveHolders).where(eq(schema.archiveHolders.topicId, TOPIC));
  await db.delete(schema.mlsGroups).where(eq(schema.mlsGroups.topicId, TOPIC));
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
  db = drizzle(pool, { schema });
  await clean();
  await db.delete(schema.topics).where(eq(schema.topics.id, TOPIC));
  await db.delete(schema.users).where(eq(schema.users.id, USER_A));
  await db.delete(schema.users).where(eq(schema.users.id, USER_B));
  await db.insert(schema.users).values([
    { id: USER_A, nickname: 'tak_test_a' },
    { id: USER_B, nickname: 'tak_test_b' },
  ]);
  await db.insert(schema.topics).values({
    id: TOPIC,
    title: 'TAK test topic',
    creatorId: USER_A,
    inviteCode: 'tak-invite-code',
    visibility: 'public',
  });
});

afterAll(async () => {
  await clean();
  await db.delete(schema.topics).where(eq(schema.topics.id, TOPIC));
  await db.delete(schema.users).where(eq(schema.users.id, USER_A));
  await db.delete(schema.users).where(eq(schema.users.id, USER_B));
  await pool.end();
});

beforeEach(clean);

describe('TAK scope allowlist (SI-6/D4 hostile guard)', () => {
  it('accepts the allowed shapes', () => {
    for (const s of ['full', 'none', 'since_epoch:0', 'since_epoch:42', '30d', '1d', '100', '1']) {
      expect(isValidTakScope(s)).toBe(true);
    }
  });
  it('rejects empty, injection, and out-of-shape scopes', () => {
    for (const s of [
      '',
      ' ',
      'FULL',
      'all',
      'since_epoch:',
      'since_epoch:-1',
      'since_epoch:1.5',
      '0d',
      '0',
      "full; DROP TABLE chat_archive",
      'since_epoch:1 OR 1=1',
      'x'.repeat(65),
      123 as unknown,
      null as unknown,
      undefined as unknown,
    ]) {
      expect(isValidTakScope(s)).toBe(false);
    }
  });
});

describe('TAK bundle deliver / fetch / ack', () => {
  it('stores a bundle and returns it as undelivered, oldest first', async () => {
    await storeTakBundle(db, TOPIC, USER_B, DEV_1, Buffer.from('bundle-1'), 'full');
    await storeTakBundle(db, TOPIC, USER_B, DEV_1, Buffer.from('bundle-2'), 'since_epoch:3');
    const pending = await fetchUndeliveredBundles(db, TOPIC, DEV_1);
    expect(pending.map((p) => p.ciphertext.toString())).toEqual(['bundle-1', 'bundle-2']);
    expect(pending[1].scope).toBe('since_epoch:3');
  });

  it('isolates bundles by recipient device', async () => {
    await storeTakBundle(db, TOPIC, USER_B, DEV_1, Buffer.from('for-dev1'), 'full');
    await storeTakBundle(db, TOPIC, USER_B, DEV_2, Buffer.from('for-dev2'), 'full');
    const d1 = await fetchUndeliveredBundles(db, TOPIC, DEV_1);
    expect(d1.map((p) => p.ciphertext.toString())).toEqual(['for-dev1']);
  });

  it('ack marks delivered (so it stops appearing) and is scoped to the device', async () => {
    const id = await storeTakBundle(db, TOPIC, USER_B, DEV_1, Buffer.from('b'), 'full');
    // Another device cannot ack dev1's bundle.
    expect(await markBundlesDelivered(db, TOPIC, DEV_2, [id])).toBe(0);
    expect((await fetchUndeliveredBundles(db, TOPIC, DEV_1)).length).toBe(1);
    // The owning device acks it; re-ack is a no-op.
    expect(await markBundlesDelivered(db, TOPIC, DEV_1, [id])).toBe(1);
    expect(await markBundlesDelivered(db, TOPIC, DEV_1, [id])).toBe(0);
    expect((await fetchUndeliveredBundles(db, TOPIC, DEV_1)).length).toBe(0);
  });

  it('ack of an empty / unknown id list does nothing', async () => {
    expect(await markBundlesDelivered(db, TOPIC, DEV_1, [])).toBe(0);
    expect(
      await markBundlesDelivered(db, TOPIC, DEV_1, ['11111111-1111-4111-8111-111111111111']),
    ).toBe(0);
  });
});

describe('archive ingest idempotency + keyset pagination integrity', () => {
  it('is idempotent per (topic, message): second store is a no-op, no dup', async () => {
    const msg = '22222222-2222-4222-8222-222222222222';
    expect(await storeArchiveRow(db, TOPIC, msg, 1, Buffer.from('ct'))).toBe(true);
    expect(await storeArchiveRow(db, TOPIC, msg, 1, Buffer.from('ct-again'))).toBe(false);
    const rows = await getArchiveSince(db, TOPIC, null, 100);
    expect(rows.length).toBe(1);
    expect(rows[0].ciphertext.toString()).toBe('ct'); // first write wins
  });

  it('paginates every row exactly once even when rows share a timestamp', async () => {
    // Force a timestamp tie so the compound (created_at, message_id) cursor is
    // genuinely exercised — a created_at-only cursor would skip a sibling here.
    const ts = '2026-01-01T00:00:00.000Z';
    const ids = [
      '33333333-3333-4333-8333-333333333331',
      '33333333-3333-4333-8333-333333333332',
      '33333333-3333-4333-8333-333333333333',
      '33333333-3333-4333-8333-333333333334',
      '33333333-3333-4333-8333-333333333335',
    ];
    for (const id of ids) {
      await db.execute(sql`
        INSERT INTO chat_archive (topic_id, message_id, tak_version, ciphertext, created_at)
        VALUES (${TOPIC}, ${id}, 1, ${Buffer.from(id)}, ${ts}::timestamptz)
      `);
    }
    // Walk pages of 2 and collect everything via the keyset cursor.
    const seen: string[] = [];
    let cursor: ArchiveCursor | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page = await getArchiveSince(db, TOPIC, cursor, 2);
      if (page.length === 0) break;
      for (const r of page) seen.push(r.messageId);
      const last = page[page.length - 1];
      cursor = { createdAt: last.createdAt, messageId: last.messageId };
    }
    expect(seen.sort()).toEqual([...ids].sort()); // every row once
    expect(new Set(seen).size).toBe(ids.length); // no duplicates
  });
});

describe('archive-holder single-winner lease (SI-6)', () => {
  it('first claim wins; same device renews; a different device is rejected while the lease is valid', async () => {
    const first = await claimOrRenewHolder(db, TOPIC, USER_A, DEV_1, 0, 900);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.renewed).toBe(false);

    const renew = await claimOrRenewHolder(db, TOPIC, USER_A, DEV_1, 0, 900);
    expect(renew.ok).toBe(true);
    if (renew.ok) expect(renew.renewed).toBe(true);

    const other = await claimOrRenewHolder(db, TOPIC, USER_B, DEV_2, 1, 900);
    expect(other.ok).toBe(false);
    if (!other.ok) {
      expect(other.reason).toBe('held-by-other');
      expect(other.state.holderUserId).toBe(USER_A);
    }
  });

  it('a different device takes over once the lease expires (epoch_covered inherited)', async () => {
    await claimOrRenewHolder(db, TOPIC, USER_A, DEV_1, 0, 900);
    // Holder makes progress, then its lease expires. Expire it on the SERVER
    // clock (now() in SQL), not the Node clock — claimOrRenewHolder checks
    // validity against Postgres now(), and the container clock can skew from the
    // host by seconds under Docker, which would leave a Date.now()-based expiry
    // still "in the future" and flake the takeover.
    await db.execute(sql`
      UPDATE archive_holders SET epoch_covered = 7, holder_lease_expires_at = now() - make_interval(secs => 5)
      WHERE topic_id = ${TOPIC}
    `);

    const takeover = await claimOrRenewHolder(db, TOPIC, USER_B, DEV_2, 1, 900);
    expect(takeover.ok).toBe(true);
    const holder = await getHolder(db, TOPIC);
    expect(holder?.holderUserId).toBe(USER_B);
    expect(holder?.holderDeviceId).toBe(DEV_2);
    expect(holder?.epochCovered).toBe(7); // inherited so rewrap resumes, not restarts
  });

  it('only one of many concurrent first-claimers wins', async () => {
    const claimers = [
      () => claimOrRenewHolder(db, TOPIC, USER_A, DEV_1, 0, 900),
      () => claimOrRenewHolder(db, TOPIC, USER_B, DEV_2, 1, 900),
      () => claimOrRenewHolder(db, TOPIC, USER_A, 'device-3', 0, 900),
    ];
    const results = await Promise.all(claimers.map((c) => c()));
    const winners = results.filter((r) => r.ok);
    expect(winners.length).toBe(1);
    // Everyone agrees on the same holder afterwards.
    const holder = await getHolder(db, TOPIC);
    expect(holder).not.toBeNull();
  });
});

describe('holder coverage epoch-fence (SI-7)', () => {
  async function genesisGroup(epoch: number) {
    await db.insert(schema.mlsGroups).values({
      topicId: TOPIC,
      groupId: Buffer.from('gid'),
      currentEpoch: epoch,
      ciphersuite: MLS_CIPHERSUITE,
    });
  }

  it('records coverage up to the current epoch, rejects future-epoch claims', async () => {
    await genesisGroup(5);
    await claimOrRenewHolder(db, TOPIC, USER_A, DEV_1, 0, 900);

    const ok = await updateHolderCoverage(db, TOPIC, USER_A, DEV_1, 5);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.epochCovered).toBe(5);

    const future = await updateHolderCoverage(db, TOPIC, USER_A, DEV_1, 6);
    expect(future.ok).toBe(false);
    if (!future.ok) {
      expect(future.reason).toBe('future-epoch');
      expect(future.currentEpoch).toBe(5);
    }
    // The stored coverage was never advanced past a real committed epoch.
    expect((await getHolder(db, TOPIC))?.epochCovered).toBe(5);
  });

  it('rejects coverage from a non-holder device', async () => {
    await genesisGroup(3);
    await claimOrRenewHolder(db, TOPIC, USER_A, DEV_1, 0, 900);
    const res = await updateHolderCoverage(db, TOPIC, USER_B, DEV_2, 2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not-holder');
  });

  it('returns no-group when the topic has no MLS group yet', async () => {
    await claimOrRenewHolder(db, TOPIC, USER_A, DEV_1, 0, 900);
    const res = await updateHolderCoverage(db, TOPIC, USER_A, DEV_1, 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-group');
  });
});
