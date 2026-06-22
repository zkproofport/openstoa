/**
 * SI-3 integration test: KeyPackage atomic single-use consume under concurrency.
 *
 * Hits the REAL local Postgres (not mocks) because the invariant being proven —
 * "two concurrent consumers can never claim the same package" — lives in the
 * SQL (FOR UPDATE SKIP LOCKED + RETURNING), not in app code. Concurrent
 * consumeOneKeyPackage() calls over a pg Pool get separate connections, so this
 * is genuine concurrency. Requires the local dev DB (DATABASE_URL or default).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { consumeOneKeyPackage } from '@/lib/mls/keyPackages';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

const TEST_USER = 'si3-test-user';
const NICK = 'si3_test_user';

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

async function cleanup() {
  await db.delete(schema.deviceKeyPackages).where(eq(schema.deviceKeyPackages.userId, TEST_USER));
  await db.delete(schema.users).where(eq(schema.users.id, TEST_USER));
}

async function insertPackage(deviceId: string, isLastResort = false) {
  const [row] = await db
    .insert(schema.deviceKeyPackages)
    .values({
      userId: TEST_USER,
      deviceId,
      keyPackage: Buffer.from(`kp-${deviceId}`),
      isLastResort,
    })
    .returning({ id: schema.deviceKeyPackages.id });
  return row.id;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 12 });
  db = drizzle(pool, { schema });
  await cleanup();
  await db.insert(schema.users).values({ id: TEST_USER, nickname: NICK });
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe('SI-3 — KeyPackage atomic consume', () => {
  it('one package + K concurrent consumers → exactly one winner', async () => {
    await insertPackage('solo');
    const K = 8;
    const results = await Promise.all(
      Array.from({ length: K }, () => consumeOneKeyPackage(db, TEST_USER, 'solo')),
    );
    const winners = results.filter((r) => r !== null);
    expect(winners.length).toBe(1);
    // And it is now gone — a follow-up consume yields nothing.
    expect(await consumeOneKeyPackage(db, TEST_USER, 'solo')).toBeNull();
  });

  it('N packages + K>N concurrent consumers → exactly N distinct winners (no double-consume)', async () => {
    const ids = await Promise.all(['a', 'b', 'c'].map((d) => insertPackage(`multi-${d}`)));
    const K = 8;
    const results = await Promise.all(
      Array.from({ length: K }, () => consumeOneKeyPackage(db, TEST_USER)),
    );
    const winners = results.filter((r) => r !== null) as NonNullable<(typeof results)[number]>[];
    expect(winners.length).toBe(ids.length); // exactly 3
    const distinct = new Set(winners.map((w) => w.id));
    expect(distinct.size).toBe(ids.length); // every winner is a different package
    expect([...distinct].sort()).toEqual([...ids].sort());
  });

  it('last-resort package is reusable (returned without being consumed)', async () => {
    const id = await insertPackage('lastresort', true);
    const first = await consumeOneKeyPackage(db, TEST_USER, 'lastresort');
    const second = await consumeOneKeyPackage(db, TEST_USER, 'lastresort');
    expect(first?.id).toBe(id);
    expect(second?.id).toBe(id); // still available — not consumed
    expect(first?.isLastResort).toBe(true);
  });

  it('no available package → null', async () => {
    expect(await consumeOneKeyPackage(db, TEST_USER, 'does-not-exist')).toBeNull();
  });
});
