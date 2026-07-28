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
import { db as sharedDb } from '@/lib/db';
import { apiKeys } from '@/lib/db/schema';
import { ALLOWED_CMDS } from '@/lib/aiPermissions';
import { isValidTakScope } from '@/lib/mls/http';

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

  if (isAI !== undefined && typeof isAI !== 'boolean') {
    throw new ApiKeyValidationError('isAI must be a boolean');
  }

  return { name: name.trim(), cmd: cmds, historyGrant: historyGrant as string, isAI: isAI === undefined ? true : isAI };
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
