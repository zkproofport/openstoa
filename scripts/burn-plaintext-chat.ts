/**
 * Burn & restart `chat_messages` for the E2EE migration (Phase 1).
 *
 * The plaintext chat era is over: user message bodies are now end-to-end
 * encrypted (see src/app/api/topics/[topicId]/chat/route.ts). There is no
 * migration of old plaintext rows — pre-launch, by design (dev plan §8). This
 * script deletes every existing chat row so the table restarts clean under the
 * ciphertext schema.
 *
 * DESTRUCTIVE + IRREVERSIBLE. The burn is the one Phase 1 step with no rollback,
 * so the guard is the only line of defense (dev plan M1): it runs only if at
 * least one of these holds, otherwise it refuses:
 *   1. NODE_ENV !== 'production'                       (dev / staging burn freely)
 *   2. operator confirmation: BURN_CONFIRM === EXPECTED (intentional prod burn)
 *   3. the table is already empty (row count === 0)     (no-op burn)
 *
 * Run: `DATABASE_URL=... npx tsx scripts/burn-plaintext-chat.ts`
 */
import { Pool } from 'pg';

export const BURN_CONFIRM_EXPECTED = 'burn-plaintext-chat';

export interface BurnGuardInput {
  nodeEnv: string | undefined;
  rowCount: number;
  confirmToken: string | undefined;
}

export interface BurnGuardResult {
  canBurn: boolean;
  isNonProd: boolean;
  hasToken: boolean;
  isEmpty: boolean;
  reason: string;
}

/**
 * Pure precondition check (dev plan M1). No DB or env access so it is unit
 * testable in isolation. The burn proceeds iff `canBurn` is true.
 */
export function evaluateBurnGuard({ nodeEnv, rowCount, confirmToken }: BurnGuardInput): BurnGuardResult {
  const isNonProd = nodeEnv !== 'production';
  const hasToken = confirmToken === BURN_CONFIRM_EXPECTED;
  const isEmpty = rowCount === 0;
  const canBurn = isNonProd || hasToken || isEmpty;
  const reason = canBurn
    ? isNonProd
      ? 'non-production environment'
      : hasToken
        ? 'operator confirmation token present'
        : 'table already empty (no-op)'
    : 'production environment with a non-empty table and no operator confirmation token';
  return { canBurn, isNonProd, hasToken, isEmpty, reason };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL environment variable is required');

  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const pool = new Pool({ connectionString: url });
  try {
    const { rows } = await pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM chat_messages',
    );
    const rowCount = Number(rows[0]?.count ?? 0);

    const guard = evaluateBurnGuard({
      nodeEnv,
      rowCount,
      confirmToken: process.env.BURN_CONFIRM,
    });

    console.log('[burn-plaintext-chat] preconditions', { nodeEnv, rowCount, ...guard });

    if (!guard.canBurn) {
      console.error(
        `[burn-plaintext-chat] REFUSED: ${guard.reason}. ` +
          `Set BURN_CONFIRM=${BURN_CONFIRM_EXPECTED} to confirm an intentional production burn.`,
      );
      process.exit(1);
      return;
    }

    if (guard.isEmpty) {
      console.log('[burn-plaintext-chat] table already empty — nothing to burn.');
      return;
    }

    const deleted = await pool.query('DELETE FROM chat_messages');
    console.log(
      `[burn-plaintext-chat] burned ${rowCount} plaintext chat rows (${deleted.rowCount} deleted), reason: ${guard.reason}.`,
    );
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('burn-plaintext-chat.ts')) {
  main().catch((err) => {
    console.error('[burn-plaintext-chat] failed:', err);
    process.exit(1);
  });
}
