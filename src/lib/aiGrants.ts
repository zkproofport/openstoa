/**
 * Data-access + validation for Phase 5 AI-member grants (design §7, D9/D11).
 *
 * A grant is a UCAN-shaped scoped delegation (docs/research/openstoa-ucan-
 * capability-schema.md) from a human OWNER to an AI member: an ability
 * allowlist (`cmd`), a history scope (`historyGrant` ↔ TAK scope), a max
 * delegation depth (≤3), and optional key-theft binding (`dpopJkt`) / consent
 * anchor (`consentAnchor`). This layer holds NO keys and NO plaintext (C1/
 * SI-1) — it is pure access-control metadata. A db handle is passed in (mirrors
 * keyBackupStore.ts) so routes and tests share one implementation.
 *
 * D11 revocation semantics: `revokeGrant` sets `revoked_at`, which makes
 * `checkGrantAllows` return false immediately — future AI actions 403. It does
 * NOT (and cannot) unshare plaintext the AI already received; revocation =
 * server access-gating + client-driven MLS Remove (future PCS) + grant revoke.
 */
import { and, eq, isNull, desc } from 'drizzle-orm';
import { db as sharedDb } from '@/lib/db';
import { aiGrants } from '@/lib/db/schema';
import { isValidTakScope } from '@/lib/mls/http';

type DB = typeof sharedDb;

// Ability allowlist (UCAN `cmd` hierarchy, research §5.1). A grant's `cmd` must
// be a non-empty subset of this set — an unknown or free-form command is
// rejected at validation time (least-privilege, no silent-allow).
export const ALLOWED_CMDS = [
  '/openstoa/chat/send',
  '/openstoa/chat/read',
  '/openstoa/post/read',
  '/openstoa/post/write',
  '/openstoa/comment/read',
  '/openstoa/comment/write',
  '/openstoa/search/topic',
  '/ai/summarize',
  '/ai/search',
] as const;

export type AllowedCmd = (typeof ALLOWED_CMDS)[number];

// UCAN §7.2 + integration checklist: reject delegation depth > 3. depth 0 is
// valid and the most restrictive (AI may not sub-delegate at all); 1 is the
// default direct User→AI grant.
export const MAX_GRANT_DEPTH = 3;

// SI-4 caps on the metadata payload. A grant carries a handful of command
// paths and short identifiers — cap generously, reject abuse/enumeration.
export const MAX_CMD_COUNT = 32;
export const MAX_CMD_LEN = 128;
export const MAX_ID_LEN = 256;

export class GrantValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrantValidationError';
  }
}

export interface CreateGrantInput {
  topicId: string;
  granterUserId: string;
  aiUserId: unknown;
  cmd: unknown;
  historyGrant: unknown;
  depth?: unknown;
  dpopJkt?: unknown;
  consentAnchor?: unknown;
}

export interface NormalizedGrant {
  aiUserId: string;
  cmd: string[];
  historyGrant: string;
  depth: number;
  dpopJkt: string | null;
  consentAnchor: string | null;
}

export interface GrantRow {
  id: string;
  topicId: string;
  granterUserId: string;
  aiUserId: string;
  cmd: string[];
  historyGrant: string;
  depth: number;
  dpopJkt: string | null;
  consentAnchor: string | null;
  revokedAt: Date | null;
  createdAt: Date | null;
}

const ALLOWED_CMD_SET = new Set<string>(ALLOWED_CMDS);

/**
 * Validate + normalize a grant request. Pure (no db) so the guard is unit-
 * testable in isolation. Throws GrantValidationError on any invalid input so
 * the route can map it to a 400.
 */
export function validateGrantInput(input: CreateGrantInput): NormalizedGrant {
  const { aiUserId, cmd, historyGrant, depth, dpopJkt, consentAnchor } = input;

  if (typeof aiUserId !== 'string' || aiUserId.trim().length === 0) {
    throw new GrantValidationError('aiUserId is required');
  }
  if (aiUserId.length > MAX_ID_LEN) {
    throw new GrantValidationError('aiUserId is too long');
  }

  if (!Array.isArray(cmd) || cmd.length === 0) {
    throw new GrantValidationError('cmd must be a non-empty array');
  }
  if (cmd.length > MAX_CMD_COUNT) {
    throw new GrantValidationError('too many cmd entries');
  }
  for (const c of cmd) {
    if (typeof c !== 'string' || c.length === 0 || c.length > MAX_CMD_LEN) {
      throw new GrantValidationError('each cmd must be a non-empty string');
    }
    if (!ALLOWED_CMD_SET.has(c)) {
      throw new GrantValidationError(`unknown cmd: ${c}`);
    }
  }
  // Dedupe while preserving order.
  const cmds = Array.from(new Set(cmd as string[]));

  // history_grant is the TAK scope the AI may back-fill — validated by the same
  // allowlist as TAK bundles (none | Nd | since_epoch:N | full | N).
  if (!isValidTakScope(historyGrant)) {
    throw new GrantValidationError('historyGrant must be a valid scope: none | Nd | since_epoch:N | full');
  }

  // depth: default 1; accept 0..MAX_GRANT_DEPTH; reject anything above (>3) or
  // negative/non-integer.
  let d = 1;
  if (depth !== undefined && depth !== null) {
    if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0 || depth > MAX_GRANT_DEPTH) {
      throw new GrantValidationError(`depth must be an integer between 0 and ${MAX_GRANT_DEPTH}`);
    }
    d = depth;
  }

  const jkt = normalizeOptionalId(dpopJkt, 'dpopJkt');
  const anchor = normalizeOptionalId(consentAnchor, 'consentAnchor');

  return { aiUserId, cmd: cmds, historyGrant: historyGrant as string, depth: d, dpopJkt: jkt, consentAnchor: anchor };
}

function normalizeOptionalId(v: unknown, name: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length === 0) {
    throw new GrantValidationError(`${name} must be a non-empty string when provided`);
  }
  if (v.length > MAX_ID_LEN) {
    throw new GrantValidationError(`${name} is too long`);
  }
  return v;
}

/** Create a grant after validating the input. Throws GrantValidationError on invalid input. */
export async function createGrant(db: DB, input: CreateGrantInput): Promise<GrantRow> {
  const norm = validateGrantInput(input);
  const [row] = await db
    .insert(aiGrants)
    .values({
      topicId: input.topicId,
      granterUserId: input.granterUserId,
      aiUserId: norm.aiUserId,
      cmd: norm.cmd,
      historyGrant: norm.historyGrant,
      depth: norm.depth,
      dpopJkt: norm.dpopJkt,
      consentAnchor: norm.consentAnchor,
    })
    .returning();
  return row as GrantRow;
}

/** The most recent active (non-revoked) grant for an AI in a topic, or null. */
export async function getActiveGrant(db: DB, topicId: string, aiUserId: string): Promise<GrantRow | null> {
  const row = await db.query.aiGrants.findFirst({
    where: and(eq(aiGrants.topicId, topicId), eq(aiGrants.aiUserId, aiUserId), isNull(aiGrants.revokedAt)),
    orderBy: [desc(aiGrants.createdAt)],
  });
  return (row as GrantRow | undefined) ?? null;
}

/** All active (non-revoked) grants in a topic, newest first. */
export async function listGrants(db: DB, topicId: string): Promise<GrantRow[]> {
  const rows = await db.query.aiGrants.findMany({
    where: and(eq(aiGrants.topicId, topicId), isNull(aiGrants.revokedAt)),
    orderBy: [desc(aiGrants.createdAt)],
  });
  return rows as GrantRow[];
}

/**
 * Revoke a grant (idempotent). Only flips a still-active row so a concurrent
 * revoke is deterministic — the first sets revoked_at, the second returns null.
 * Returns the revoked row, or null if the grant does not exist in this topic or
 * was already revoked.
 */
export async function revokeGrant(db: DB, topicId: string, grantId: string): Promise<GrantRow | null> {
  const [row] = await db
    .update(aiGrants)
    .set({ revokedAt: new Date() })
    .where(and(eq(aiGrants.id, grantId), eq(aiGrants.topicId, topicId), isNull(aiGrants.revokedAt)))
    .returning();
  return (row as GrantRow | undefined) ?? null;
}

/** Pure predicate: does this grant (if active) allow `cmd`? Missing/revoked → false (no silent allow). */
export function grantAllows(grant: GrantRow | null, cmd: string): boolean {
  if (!grant) return false;
  if (grant.revokedAt) return false;
  return grant.cmd.includes(cmd);
}

/**
 * Enforcement entry point: does the AI (`aiUserId`) hold an active grant in
 * `topicId` whose allowlist permits `cmd`? Used by chat send / history read to
 * 403 an ungranted or revoked AI caller.
 */
export async function checkGrantAllows(db: DB, topicId: string, aiUserId: string, cmd: string): Promise<boolean> {
  const grant = await getActiveGrant(db, topicId, aiUserId);
  return grantAllows(grant, cmd);
}
