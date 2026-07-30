/**
 * AI capability allowlist + enforcement gate (design §7, consolidated onto API
 * keys 2026-07-30).
 *
 * The scoped API key IS the sole authority for what an `isAI` session may do —
 * GitHub-PAT style: a token's own scope travels with it, and nothing above the
 * token widens it. There is NO account-level fallback grant any more. The
 * earlier per-account `ai_permissions` row (design §7's original "configure it
 * once in your profile, it applies to every isAI session") has been retired:
 * `PUT /api/profile/ai-permissions` no longer accepts writes and nothing reads
 * the table for authorization (see `src/app/api/profile/ai-permissions/route.ts`
 * and `src/lib/db/schema.ts` for the retirement notes). Scope now comes from
 * exactly one place: the key created via `POST /api/profile/api-keys`
 * (`src/lib/apiKeys.ts`), surfaced on the session as `apiKeyCmd` by
 * `getApiKeySession` in `src/lib/session.ts`.
 *
 * This module keeps only what is still load-bearing: the shared ability
 * allowlist (`ALLOWED_CMDS`, reused by `@/lib/apiKeys` for key-scope
 * validation) and `requireAiCapability`, the route guard every isAI-gated
 * endpoint calls.
 */
import { NextResponse } from 'next/server';
import { db as sharedDb } from '@/lib/db';

type DB = typeof sharedDb;

// Ability allowlist spanning the whole app. An API key's `cmd` must be a
// (possibly empty) subset of this set — an unknown or free-form command is
// rejected at validation time (least-privilege, no silent-allow). Empty is
// valid and the most restrictive: the key may do nothing.
export const ALLOWED_CMDS = [
  '/openstoa/topic/join',
  '/openstoa/topic/leave',
  '/openstoa/post/read',
  '/openstoa/post/write',
  '/openstoa/post/delete',
  '/openstoa/comment/read',
  '/openstoa/comment/write',
  '/openstoa/chat/read',
  '/openstoa/chat/send',
  '/openstoa/profile/read',
  '/openstoa/profile/edit',
  '/ai/summarize',
  '/ai/search',
] as const;

export type AllowedCmd = (typeof ALLOWED_CMDS)[number];

// SI-4 caps on the metadata payload. A key carries a handful of command
// paths — cap generously, reject abuse/enumeration.
export const MAX_CMD_COUNT = 32;
export const MAX_CMD_LEN = 128;

/**
 * Route helper reused across every isAI-gated endpoint. Returns a 403
 * NextResponse if the session is an AI (`isAI`) that lacks `cmd`, else null so
 * the route continues. Humans (isAI falsy) are never gated here — they pass
 * through unchanged (membership / authorship rules still apply upstream).
 *
 * Fail-closed, key-only: the ONLY scope an isAI session can carry is
 * `session.apiKeyCmd`, populated by `getApiKeySession` (`src/lib/session.ts`)
 * when the caller authenticated with `Authorization: Bearer osk_...`. An isAI
 * session with no key scope — e.g. a bare JWT minted by `/api/auth/dev-login`
 * (dev-only) or the currently-unreachable `/api/auth/verify/ai` — declares no
 * capabilities and is therefore DENIED, never granted an implicit account-wide
 * allowance. A credential with no declared scope must not inherit one.
 *
 * `db` is accepted for call-site/signature stability (14 routes already call
 * this with `db` as the first argument) but is intentionally unused: there is
 * no DB lookup left in this gate — see the module docstring for why.
 */
export async function requireAiCapability(
  db: DB,
  session: { userId: string; isAI?: boolean; apiKeyCmd?: string[] },
  cmd: AllowedCmd | string,
): Promise<NextResponse | null> {
  void db;
  if (!session.isAI) return null;
  const ok = (session.apiKeyCmd ?? []).includes(cmd);
  if (ok) return null;
  return NextResponse.json(
    { error: `AI capability required: ${cmd} not permitted` },
    { status: 403 },
  );
}
