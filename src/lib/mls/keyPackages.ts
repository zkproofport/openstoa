/**
 * Atomic KeyPackage consume (SI-3). Extracted so the HTTP route and the
 * concurrency test exercise the exact same query.
 *
 * Picks exactly one unconsumed KeyPackage for `userId`, locks the row so a
 * concurrent consumer skips it (FOR UPDATE SKIP LOCKED), and marks it consumed
 * in the same statement — making double-consume impossible. Last-resort (AI)
 * packages are returned WITHOUT being consumed (they are reusable); single-use
 * packages are preferred (is_last_resort ASC) and oldest first.
 */
import { sql } from 'drizzle-orm';

export interface ConsumedKeyPackage {
  id: string;
  deviceId: string;
  keyPackage: Buffer;
  isLastResort: boolean;
}

interface ExecResult {
  rows: Array<{ id: string; device_id: string; key_package: Buffer; is_last_resort: boolean }>;
}

// Minimal structural type so this works with both `db` and a transaction `tx`.
interface Executor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

export async function consumeOneKeyPackage(
  executor: Executor,
  userId: string,
  deviceId?: string | null,
): Promise<ConsumedKeyPackage | null> {
  const deviceFilter = deviceId ? sql`AND device_id = ${deviceId}` : sql``;
  const result = (await executor.execute(sql`
    UPDATE device_key_packages
    SET consumed_at = CASE WHEN is_last_resort THEN consumed_at ELSE now() END
    WHERE id = (
      SELECT id FROM device_key_packages
      WHERE user_id = ${userId} AND consumed_at IS NULL ${deviceFilter}
      ORDER BY is_last_resort ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, device_id, key_package, is_last_resort
  `)) as unknown as ExecResult;

  const rows = result.rows;
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    deviceId: r.device_id,
    keyPackage: Buffer.from(r.key_package),
    isLastResort: r.is_last_resort,
  };
}
