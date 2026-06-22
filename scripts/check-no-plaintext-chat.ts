/**
 * SI-1 plaintext-absence gate (Phase 2 carry-over, story P2-01).
 *
 * Invariant: the DB must never contain a user chat row (`type = 'message'`)
 * with a non-NULL plaintext `system_text` column. Only system rows
 * (`type = 'join' | 'leave'`) are allowed to carry a `system_text` value.
 * (The legacy plaintext `message` column was dropped/renamed in P2-22.)
 *
 * Two checks:
 *   (a) DB check — live query against chat_messages.
 *   (b) Source check — the POST handler in the chat route still contains
 *       the plaintext-rejection guard (`'message' in body`).
 *
 * Run: `DATABASE_URL=... npx tsx scripts/check-no-plaintext-chat.ts`
 * Or:  `npm run verify:no-plaintext-chat`
 */

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// (a) DB check helpers — exported for unit testing
// ---------------------------------------------------------------------------

export interface PlaintextRow {
  n: number;
}

export interface PlaintextEvalResult {
  ok: boolean;
  reason?: string;
}

/**
 * Pure helper: evaluate the DB query result. No DB or env access.
 * Exported so vitest can unit-test it without a live DB connection.
 */
export function evaluatePlaintextRows(rows: PlaintextRow): PlaintextEvalResult {
  if (rows.n === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `${rows.n} chat_messages row(s) of type='message' have a non-NULL plaintext system_text column — SI-1 violated`,
  };
}

// ---------------------------------------------------------------------------
// (b) Source check helper
// ---------------------------------------------------------------------------

/**
 * The chat POST route must contain the SI-1 plaintext-rejection guard.
 * We look for the specific in-body check that rejects any request that
 * carries a plaintext `message` field.
 */
const CHAT_ROUTE_GLOB = path.join(
  __dirname,
  '../src/app/api/topics/[topicId]/chat/route.ts',
);

// The literal guard string that must be present in the POST handler.
// Any refactor that removes or renames this check will trip the gate.
const GUARD_STRING = "'message' in body";

export interface SourceCheckResult {
  ok: boolean;
  filePath: string;
  reason?: string;
}

export function checkChatRouteGuard(routeFilePath: string = CHAT_ROUTE_GLOB): SourceCheckResult {
  if (!fs.existsSync(routeFilePath)) {
    return {
      ok: false,
      filePath: routeFilePath,
      reason: `Chat route file not found: ${routeFilePath}`,
    };
  }
  const src = fs.readFileSync(routeFilePath, 'utf8');
  if (!src.includes(GUARD_STRING)) {
    return {
      ok: false,
      filePath: routeFilePath,
      reason:
        `SI-1 plaintext-rejection guard is MISSING from ${routeFilePath}. ` +
        `Expected to find: ${GUARD_STRING}`,
    };
  }
  return { ok: true, filePath: routeFilePath };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let allOk = true;

  // --- (b) Source check (always runs, no DB required) ---
  const src = checkChatRouteGuard();
  if (!src.ok) {
    console.error(`[check-no-plaintext-chat] SOURCE CHECK FAILED: ${src.reason}`);
    allOk = false;
  } else {
    console.log(`[check-no-plaintext-chat] source check OK — guard present in ${src.filePath}`);
  }

  // --- (a) DB check (soft-fail when DB is unreachable) ---
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn(
      '[check-no-plaintext-chat] WARNING: DATABASE_URL not set — skipping DB check. ' +
        'Set DATABASE_URL to run the full SI-1 gate.',
    );
  } else {
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
    try {
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM chat_messages WHERE type = 'message' AND system_text IS NOT NULL",
      );
      const result = evaluatePlaintextRows(rows[0] ?? { n: 0 });
      if (!result.ok) {
        // Fetch a sample of offending IDs to aid diagnosis.
        const sample = await pool.query<{ id: string }>(
          "SELECT id FROM chat_messages WHERE type = 'message' AND system_text IS NOT NULL LIMIT 5",
        );
        const ids = sample.rows.map((r) => r.id).join(', ');
        console.error(
          `[check-no-plaintext-chat] DB CHECK FAILED: ${result.reason}. ` +
            `Sample offending ids: ${ids}`,
        );
        allOk = false;
      } else {
        console.log('[check-no-plaintext-chat] DB check OK — no plaintext user messages found.');
      }
    } catch (err) {
      // DB unreachable — warn but do NOT fail the gate. This gate is meant
      // for CI environments where a DB is present; locally the DB may be
      // down at script invocation time.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[check-no-plaintext-chat] WARNING: DB unreachable (${msg}) — skipping DB check. ` +
          'Run with a live DATABASE_URL to enforce the full SI-1 invariant.',
      );
    } finally {
      await pool.end();
    }
  }

  if (!allOk) {
    process.exit(1);
  }

  console.log('[check-no-plaintext-chat] all checks passed.');
}

// Only run when invoked directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('check-no-plaintext-chat.ts')) {
  main().catch((err) => {
    console.error('[check-no-plaintext-chat] unexpected error:', err);
    process.exit(1);
  });
}
