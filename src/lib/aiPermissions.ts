/**
 * Profile-level AI capability model (design §7).
 *
 * Replaces the earlier per-topic `ai_grants` delegation. The re-designed model:
 * an AI is not a separate account a topic owner grants into a topic — it is an
 * `isAI` session acting on a USER's own account (its nullifier may equal the
 * human owner's; the two are distinguished per-request by the session flag,
 * exactly like posts already do with `is_ai`). Therefore a user configures, in
 * their PROFILE, what their AI (any isAI session on their account) may do, and
 * that capability set applies across the whole app — not per-topic.
 *
 * This layer holds NO keys and NO plaintext (C1/SI-1) — it is pure access-
 * control metadata: an ability allowlist (`cmd`) and a chat-history scope
 * (`historyGrant` ↔ TAK scope). A db handle is passed in (mirrors aiGrants.ts /
 * keyBackupStore.ts) so routes and tests share one implementation.
 */
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db as sharedDb } from '@/lib/db';
import { aiPermissions } from '@/lib/db/schema';
import { isValidTakScope } from '@/lib/mls/http';

type DB = typeof sharedDb;

// Ability allowlist spanning the whole app. A permission set's `cmd` must be a
// (possibly empty) subset of this set — an unknown or free-form command is
// rejected at validation time (least-privilege, no silent-allow). Empty is
// valid and the most restrictive: the AI may do nothing.
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

// SI-4 caps on the metadata payload. A permission set carries a handful of
// command paths — cap generously, reject abuse/enumeration.
export const MAX_CMD_COUNT = 32;
export const MAX_CMD_LEN = 128;

export class AiPermissionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiPermissionValidationError';
  }
}

export interface AiPermissionInput {
  cmd: unknown;
  historyGrant: unknown;
}

export interface NormalizedAiPermission {
  cmd: string[];
  historyGrant: string;
}

export interface AiPermissionRow {
  userId: string;
  cmd: string[];
  historyGrant: string;
  updatedAt: Date | null;
}

const ALLOWED_CMD_SET = new Set<string>(ALLOWED_CMDS);

/**
 * Validate + normalize an AI-permission request. Pure (no db) so the guard is
 * unit-testable in isolation. Throws AiPermissionValidationError on any invalid
 * input so the route can map it to a 400.
 *
 * `cmd` may be an EMPTY array — that is a valid, safe "my AI can do nothing"
 * configuration (unlike the old per-action grant, which required ≥1 cmd).
 */
export function validateAiPermissionInput(input: AiPermissionInput): NormalizedAiPermission {
  const { cmd, historyGrant } = input;

  if (!Array.isArray(cmd)) {
    throw new AiPermissionValidationError('cmd must be an array');
  }
  if (cmd.length > MAX_CMD_COUNT) {
    throw new AiPermissionValidationError('too many cmd entries');
  }
  for (const c of cmd) {
    if (typeof c !== 'string' || c.length === 0 || c.length > MAX_CMD_LEN) {
      throw new AiPermissionValidationError('each cmd must be a non-empty string');
    }
    if (!ALLOWED_CMD_SET.has(c)) {
      throw new AiPermissionValidationError(`unknown cmd: ${c}`);
    }
  }
  // Dedupe while preserving order.
  const cmds = Array.from(new Set(cmd as string[]));

  // history_grant is the chat archive (TAK) scope the AI may back-fill —
  // validated by the same allowlist as TAK bundles (none | Nd | since_epoch:N | full | N).
  if (!isValidTakScope(historyGrant)) {
    throw new AiPermissionValidationError('historyGrant must be a valid scope: none | Nd | since_epoch:N | full');
  }

  return { cmd: cmds, historyGrant: historyGrant as string };
}

/** The AI-permission row for a user, or null if the user has never configured one. */
export async function getAiPermissions(db: DB, userId: string): Promise<AiPermissionRow | null> {
  const row = await db.query.aiPermissions.findFirst({
    where: eq(aiPermissions.userId, userId),
  });
  return (row as AiPermissionRow | undefined) ?? null;
}

/**
 * Upsert a user's AI-permission set after validating the input. Throws
 * AiPermissionValidationError on invalid input. The user always owns exactly
 * one row (keyed by userId), so this replaces the whole capability set.
 */
export async function setAiPermissions(db: DB, userId: string, input: AiPermissionInput): Promise<AiPermissionRow> {
  const norm = validateAiPermissionInput(input);
  const [row] = await db
    .insert(aiPermissions)
    .values({ userId, cmd: norm.cmd, historyGrant: norm.historyGrant, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: aiPermissions.userId,
      set: { cmd: norm.cmd, historyGrant: norm.historyGrant, updatedAt: new Date() },
    })
    .returning();
  return row as AiPermissionRow;
}

/** Pure predicate: does this permission set allow `cmd`? Missing set → false (no silent allow). */
export function permissionAllows(perm: AiPermissionRow | null, cmd: string): boolean {
  if (!perm) return false;
  return perm.cmd.includes(cmd);
}

/**
 * Enforcement lookup: does the user (`userId`) hold an AI-permission set whose
 * allowlist permits `cmd`? Used by `requireAiCapability` to 403 an isAI caller.
 */
export async function checkAiCapability(db: DB, userId: string, cmd: string): Promise<boolean> {
  const perm = await getAiPermissions(db, userId);
  return permissionAllows(perm, cmd);
}

/**
 * Route helper reused across every isAI-gated endpoint. Returns a 403
 * NextResponse if the session is an AI (`isAI`) that lacks `cmd`, else null so
 * the route continues. Humans (isAI falsy) are never gated here — they pass
 * through unchanged (membership / authorship rules still apply upstream).
 *
 * `session.apiKeyCmd` (present only for an API-key-authenticated request, see
 * `src/lib/session.ts` → `getSession`) is checked directly instead of a fresh
 * `ai_permissions` lookup — the key IS the scoped credential, so its own
 * allowlist is authoritative and never widened by the account's profile grant.
 */
export async function requireAiCapability(
  db: DB,
  session: { userId: string; isAI?: boolean; apiKeyCmd?: string[] },
  cmd: AllowedCmd | string,
): Promise<NextResponse | null> {
  if (!session.isAI) return null;
  const ok = session.apiKeyCmd ? session.apiKeyCmd.includes(cmd) : await checkAiCapability(db, session.userId, cmd);
  if (ok) return null;
  return NextResponse.json(
    { error: `AI capability required: ${cmd} not permitted` },
    { status: 403 },
  );
}
