/**
 * Durable, revocable API keys for CLI/MCP agents (design §7 follow-up).
 *
 * An agent authenticates with `Authorization: Bearer <rawKey>` in place of an
 * interactive login. Unlike a profile-level `isAI` JWT session (whose
 * capabilities are looked up fresh from `ai_permissions` on every request), an
 * API key IS the scoped credential: its OWN `cmd` allowlist + `historyGrant`
 * travel with it and gate requests directly (see `src/lib/session.ts` →
 * `getSession` and `src/lib/aiPermissions.ts` → `requireAiCapability`).
 *
 * SI-1/SI-4: only the SHA-256 hash of the raw key is ever stored. A DB dump
 * never yields a usable key. The raw key is generated here and returned to the
 * caller exactly once, at issuance — callers MUST persist it themselves (there
 * is no recovery path). Never log the raw key.
 */
import { randomBytes, createHash } from 'crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db as sharedDb } from '@/lib/db';
import { apiKeys } from '@/lib/db/schema';
import { ALLOWED_CMDS } from '@/lib/aiPermissions';
import { isValidTakScope } from '@/lib/mls/http';
import { hasNulByte } from '@/lib/textGuard';

type DB = typeof sharedDb;

/** Bearer tokens shaped like `osk_<hex>` are API keys, not JWTs. Kept as a
 * literal (not imported) in `src/middleware.ts`, which runs on the Edge
 * runtime and cannot pull in this module's `@/lib/db` import chain — keep the
 * two constants in sync if this ever changes. */
export const API_KEY_PREFIX = 'osk_';

// 192 bits of entropy — comfortably brute-force-resistant regardless of hash
// speed (see hashApiKey below).
const API_KEY_RANDOM_BYTES = 24;
// Chars of the raw key shown back to the user for identification (never
// enough to reconstruct the secret: prefix + 8 hex chars of the 48-char body).
const DISPLAY_PREFIX_LEN = API_KEY_PREFIX.length + 8;

export const MAX_NAME_LEN = 100;
export const MAX_CMD_COUNT = 32;

const ALLOWED_CMD_SET = new Set<string>(ALLOWED_CMDS);

export class ApiKeyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyValidationError';
  }
}

export interface CreateApiKeyInput {
  name: unknown;
  cmd: unknown;
  historyGrant: unknown;
  isAI?: unknown;
}

export interface NormalizedApiKeyInput {
  name: string;
  cmd: string[];
  historyGrant: string;
  isAI: boolean;
}

/** PATCH input — scope only (name/isAI are fixed at issuance, never re-editable). */
export interface UpdateApiKeyInput {
  cmd: unknown;
  historyGrant: unknown;
}

export interface NormalizedUpdateApiKeyInput {
  cmd: string[];
  historyGrant: string;
}

export interface ApiKeyRow {
  id: string;
  userId: string;
  name: string;
  keyHash: string;
  prefix: string;
  isAI: boolean;
  cmd: string[];
  historyGrant: string;
  createdAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** Metadata-only shape for API responses — NEVER includes keyHash or the raw key. */
export type ApiKeyMeta = Omit<ApiKeyRow, 'keyHash' | 'userId'>;

export function toApiKeyMeta(row: ApiKeyRow): ApiKeyMeta {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    isAI: row.isAI,
    cmd: row.cmd,
    historyGrant: row.historyGrant,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * Shared cmd/historyGrant validation for both create and update — the same
 * least-privilege rules apply whether a key is being minted or re-scoped.
 * Pure (no db). Throws ApiKeyValidationError on invalid input.
 */
function validateCmdAndHistoryGrant(cmd: unknown, historyGrant: unknown): NormalizedUpdateApiKeyInput {
  if (!Array.isArray(cmd)) {
    throw new ApiKeyValidationError('cmd must be an array');
  }
  if (cmd.length > MAX_CMD_COUNT) {
    throw new ApiKeyValidationError('too many cmd entries');
  }
  for (const c of cmd) {
    if (typeof c !== 'string' || c.length === 0) {
      throw new ApiKeyValidationError('each cmd must be a non-empty string');
    }
    if (!ALLOWED_CMD_SET.has(c)) {
      throw new ApiKeyValidationError(`unknown cmd: ${c}`);
    }
  }
  const cmds = Array.from(new Set(cmd as string[]));

  if (!isValidTakScope(historyGrant)) {
    throw new ApiKeyValidationError('historyGrant must be a valid scope: none | Nd | since_epoch:N | full');
  }

  return { cmd: cmds, historyGrant: historyGrant as string };
}

/**
 * Validate + normalize a key-creation request. Pure (no db) so it is
 * unit-testable in isolation. Throws ApiKeyValidationError on invalid input.
 */
export function validateCreateApiKeyInput(input: CreateApiKeyInput): NormalizedApiKeyInput {
  const { name, cmd, historyGrant, isAI } = input;

  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ApiKeyValidationError('name is required');
  }
  if (name.length > MAX_NAME_LEN) {
    throw new ApiKeyValidationError('name is too long');
  }
  if (hasNulByte(name)) {
    // Postgres text storage cannot hold a NUL byte at all (see textGuard.ts)
    // — without this check the insert reaches the driver and comes back as
    // a raw "invalid byte sequence for encoding "UTF8": 0x00" 500, which is
    // both a wrong status code and an information disclosure.
    throw new ApiKeyValidationError('name must not contain a NUL byte');
  }

  const scoped = validateCmdAndHistoryGrant(cmd, historyGrant);

  if (isAI !== undefined && typeof isAI !== 'boolean') {
    throw new ApiKeyValidationError('isAI must be a boolean');
  }

  return { name: name.trim(), ...scoped, isAI: isAI === undefined ? true : isAI };
}

/**
 * Validate + normalize a key-scope UPDATE request (PATCH). Pure (no db).
 * Deliberately narrower than create: no `name`/`isAI` — those are fixed at
 * issuance, only the scope itself (`cmd`/`historyGrant`) is re-editable.
 * Throws ApiKeyValidationError on invalid input.
 */
export function validateUpdateApiKeyInput(input: UpdateApiKeyInput): NormalizedUpdateApiKeyInput {
  return validateCmdAndHistoryGrant(input.cmd, input.historyGrant);
}

/**
 * Hash a raw API key for storage/lookup. SHA-256 (not bcrypt/scrypt) is the
 * right tool here — unlike a user password, a generated key already carries
 * API_KEY_RANDOM_BYTES*8 (192) bits of entropy, so a fast, indexable digest is
 * safe (this mirrors how GitHub/Stripe hash long-lived API tokens) and lets
 * `verifyApiKey` do a single indexed lookup instead of a slow per-row compare.
 */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/** True if `token` is shaped like an OpenStoa API key rather than a JWT. */
export function isApiKeyToken(token: unknown): token is string {
  return typeof token === 'string' && token.startsWith(API_KEY_PREFIX);
}

function generateRawKey(): { raw: string; prefix: string } {
  const raw = API_KEY_PREFIX + randomBytes(API_KEY_RANDOM_BYTES).toString('hex');
  return { raw, prefix: raw.slice(0, DISPLAY_PREFIX_LEN) };
}

/**
 * Route guard for every `/api/profile/api-keys*` handler (create/list/edit/
 * revoke). Key MANAGEMENT is an account-owner action — it belongs to a real
 * session (cookie, or a bare JWT such as `verify/ai`/dev-login), never to a
 * delegated API-key credential.
 *
 * Without this gate, an API key authenticates exactly like a session (see
 * `getApiKeySession` in `src/lib/session.ts`), and none of the four handlers
 * checked anything beyond "is there a session" — so a key with `cmd: []`
 * could still POST here to mint a NEW key with any scope it liked (including
 * every cmd, `isAI` aside), GET here to enumerate every sibling key's
 * metadata, and PATCH/DELETE a sibling key it never created. `cmd` is
 * supposed to be a containment boundary for a leaked key; none of that was
 * actually contained.
 *
 * Deliberately NOT solved by adding a `/openstoa/key/manage` cmd entry: that
 * would only move the boundary (a key holding that one ability would still
 * be able to mint itself a superset, or a key even wider than the account
 * intends for delegation) rather than close it. Key management stays an
 * action a delegated credential can never take, at any scope — the account
 * owner re-scopes or revokes keys from a real session instead.
 *
 * Checked by credential SHAPE (`session.apiKeyId` presence — set only by
 * `getApiKeySession` for an `Authorization: Bearer osk_...` request), not by
 * `isAI` — a human's own account-owner session may legitimately carry
 * `isAI: true` (e.g. a dev-login test fixture) and must still be able to
 * manage its own keys. Returns a 403 NextResponse if the caller authenticated
 * via an API key, else null so the route continues. Runs before any
 * body/keyId parsing, mirroring the existing "401 wins over 400" ordering —
 * a delegated key must not be able to probe validation shapes on an endpoint
 * it can never use either.
 *
 * This is not a gap an agent works around — an API key is a credential the
 * account owner hands to an agent to CALL the API with, not to manage
 * credentials with. The owner mints, re-scopes, and revokes keys from their
 * own signed-in session (browser, or a real session token); the agent is a
 * consumer of the key it was given. The error body says exactly that, in the
 * same flat `{ error: string }` shape every other 403 in this codebase uses
 * (see e.g. `'Only topic owner or admin can pin posts'`,
 * `'Not a member of this topic'`) — plain enough that an agent reading the
 * response knows to stop retrying and tell its owner, not guess at a
 * workaround.
 */
export function requireNonApiKeySession(session: { apiKeyId?: string }): NextResponse | null {
  if (session.apiKeyId) {
    return NextResponse.json(
      { error: 'API keys cannot manage API keys — ask your account owner to create, edit, or revoke keys from a signed-in session' },
      { status: 403 },
    );
  }
  return null;
}

/**
 * Issue a new API key for `userId`. Returns the RAW key exactly once — only
 * its SHA-256 hash is persisted. Throws ApiKeyValidationError on invalid input.
 */
export async function createApiKey(
  db: DB,
  userId: string,
  input: CreateApiKeyInput,
): Promise<{ row: ApiKeyRow; rawKey: string }> {
  const norm = validateCreateApiKeyInput(input);
  const { raw, prefix } = generateRawKey();
  const keyHash = hashApiKey(raw);
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId,
      name: norm.name,
      keyHash,
      prefix,
      isAI: norm.isAI,
      cmd: norm.cmd,
      historyGrant: norm.historyGrant,
    })
    .returning();
  return { row: row as ApiKeyRow, rawKey: raw };
}

/** List a user's API keys, newest first — metadata only (never keyHash/raw key). */
export async function listApiKeys(db: DB, userId: string): Promise<ApiKeyRow[]> {
  const rows = await db.query.apiKeys.findMany({
    where: eq(apiKeys.userId, userId),
    orderBy: [desc(apiKeys.createdAt)],
  });
  return rows as ApiKeyRow[];
}

/**
 * Update a key's scope (cmd + historyGrant) in place — the "edit" half of
 * "GitHub-PAT style: create with a scope, edit the scope, or revoke." Does
 * NOT touch name/isAI/keyHash — only the two fields that gate requests.
 * Scoping the WHERE by userId (and requiring non-revoked) means a foreign or
 * already-revoked keyId simply matches no row — same shape as revokeApiKey,
 * so a caller can't distinguish "not yours" from "doesn't exist" (no
 * ownership oracle). Throws ApiKeyValidationError on invalid input BEFORE
 * touching the db. Returns the updated row, or null if not found / not owned
 * / already revoked.
 */
export async function updateApiKey(
  db: DB,
  userId: string,
  keyId: string,
  input: UpdateApiKeyInput,
): Promise<ApiKeyRow | null> {
  const norm = validateUpdateApiKeyInput(input);
  const [row] = await db
    .update(apiKeys)
    .set({ cmd: norm.cmd, historyGrant: norm.historyGrant })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning();
  return (row as ApiKeyRow | undefined) ?? null;
}

/**
 * Revoke a key (idempotent). Only the owning user may revoke their own key —
 * scoping the WHERE by userId means a foreign keyId simply matches no row.
 * Returns the revoked row, or null if not found / not owned / already revoked.
 */
export async function revokeApiKey(db: DB, userId: string, keyId: string): Promise<ApiKeyRow | null> {
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning();
  return (row as ApiKeyRow | undefined) ?? null;
}

/** Verify a raw key against the DB. Returns the active (non-revoked) row, or null. */
export async function verifyApiKey(db: DB, rawKey: string): Promise<ApiKeyRow | null> {
  const keyHash = hashApiKey(rawKey);
  const row = await db.query.apiKeys.findFirst({
    where: and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)),
  });
  return (row as ApiKeyRow | undefined) ?? null;
}

/** Best-effort last_used_at bump. Never throws — callers fire-and-forget. */
export async function touchApiKeyLastUsed(db: DB, keyId: string): Promise<void> {
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, keyId));
}
