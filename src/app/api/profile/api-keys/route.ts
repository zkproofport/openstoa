import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  createApiKey,
  listApiKeys,
  toApiKeyMeta,
  ApiKeyValidationError,
} from '@/lib/apiKeys';
import { ALLOWED_CMDS } from '@/lib/aiPermissions';

const ROUTE = '/api/profile/api-keys';

/**
 * @openapi
 * /api/profile/api-keys:
 *   post:
 *     tags: [Profile]
 *     summary: Issue a new scoped API key
 *     description: |
 *       Creates a durable, revocable API key an agent can use in place of an interactive login —
 *       send `Authorization: Bearer <key>` on any request instead of a JWT. The key itself is the
 *       scoped credential: its `cmd` allowlist and `historyGrant` gate requests directly (never a
 *       fresh profile `ai_permissions` lookup), so a key can be narrower than the account's own AI
 *       permissions. **The raw key is returned in this response ONLY — it is never shown again and
 *       the server stores only its SHA-256 hash.** Save it immediately; there is no recovery path,
 *       only revoke-and-reissue.
 *     operationId: createApiKey
 *     x-related-skills: [list-api-keys, revoke-api-key, get-ai-permissions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, cmd, historyGrant]
 *             properties:
 *               name:
 *                 type: string
 *                 description: A short label to identify this key later (e.g. "laptop CLI"). Max 100 chars.
 *               cmd:
 *                 type: array
 *                 items: { type: string }
 *                 description: 'Ability allowlist bound to THIS key — a (possibly empty) subset of the allowed commands, e.g. ["/openstoa/chat/read", "/openstoa/post/write"]. Unknown commands are rejected with 400.'
 *               historyGrant:
 *                 type: string
 *                 description: >
 *                   How much chat history this key may read. ENFORCED on every history surface
 *                   (`GET /api/topics/{id}/chat`, `/archive`, `/tak/bundles`) in addition to the
 *                   `cmd` check — `/openstoa/chat/read` lets the key call those endpoints, this
 *                   decides how far back it sees. Values: `full` (everything), `none` (403 — no
 *                   history at all; use it for send-only or write-only keys), `Nd` (last N days,
 *                   e.g. `7d`), `since_epoch:N` (from MLS group epoch N onward), `N` (the newest N
 *                   messages, e.g. `100`). Invalid scope → 400.
 *               isAI:
 *                 type: boolean
 *                 description: Whether requests authenticated with this key set session.isAI=true. Defaults to true (the whole point of an API key is scripted/agent access).
 *     responses:
 *       201:
 *         description: Key created — `rawKey` is shown exactly once
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 rawKey:
 *                   type: string
 *                   description: The full secret key. Store it now — it cannot be retrieved again.
 *                 key:
 *                   type: object
 *                   description: Metadata for the created key (id, name, prefix, cmd, historyGrant, isAI, createdAt). Never includes the raw key or its hash.
 *       400: { description: Invalid name, cmd (unknown/too many), or historyGrant scope }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { name, cmd, historyGrant, isAI } = body as Record<string, unknown>;

    let result: Awaited<ReturnType<typeof createApiKey>>;
    try {
      result = await createApiKey(db, session.userId, { name, cmd, historyGrant, isAI });
    } catch (e) {
      if (e instanceof ApiKeyValidationError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      throw e;
    }

    // Log metadata only — NEVER the raw key.
    logger.info(ROUTE, 'API key created', {
      userId: session.userId,
      keyId: result.row.id,
      name: result.row.name,
      cmd: result.row.cmd,
      historyGrant: result.row.historyGrant,
      isAI: result.row.isAI,
    });
    return NextResponse.json({ rawKey: result.rawKey, key: toApiKeyMeta(result.row) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/profile/api-keys:
 *   get:
 *     tags: [Profile]
 *     summary: List your API keys
 *     description: |
 *       Returns the caller's API keys — metadata only (id, name, `prefix` for display/identification,
 *       `cmd`, `historyGrant`, `isAI`, timestamps). **Never includes the raw key or its hash** — a
 *       revoked-or-lost key cannot be recovered, only replaced with a new one.
 *     operationId: listApiKeys
 *     x-related-skills: [create-api-key, revoke-api-key]
 *     responses:
 *       200:
 *         description: The caller's API keys, newest first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 apiKeys:
 *                   type: array
 *                   items: { type: object }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const rows = await listApiKeys(db, session.userId);
    return NextResponse.json({ apiKeys: rows.map(toApiKeyMeta), allowedCmd: ALLOWED_CMDS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
