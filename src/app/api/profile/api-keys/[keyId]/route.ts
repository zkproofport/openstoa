import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { revokeApiKey, updateApiKey, toApiKeyMeta, ApiKeyValidationError, requireNonApiKeySession } from '@/lib/apiKeys';

const ROUTE = '/api/profile/api-keys/[keyId]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @openapi
 * /api/profile/api-keys/{keyId}:
 *   patch:
 *     tags: [Profile]
 *     summary: Edit an API key's scope (cmd + historyGrant)
 *     description: |
 *       Re-scopes one of the caller's OWN, still-active API keys — the "edit" counterpart to
 *       revoke-and-reissue. Only `cmd` and `historyGrant` are editable; `name` and `isAI` are fixed
 *       at issuance and this endpoint never touches the key's secret or its hash (the raw key
 *       keeps working unchanged, only what it is ALLOWED to do changes). Takes effect immediately —
 *       the very next request authenticated with this key is gated by the new scope. Scoped by
 *       session user id, same as revoke: a foreign or revoked `keyId` returns 404, not a
 *       distinguishing 403 (no ownership oracle). Callable only from a real session — never from
 *       another API key, regardless of that key's own `cmd` (see the 403 below).
 *     operationId: updateApiKey
 *     x-related-skills: [create-api-key, list-api-keys, revoke-api-key]
 *     parameters:
 *       - name: keyId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [cmd, historyGrant]
 *             properties:
 *               cmd:
 *                 type: array
 *                 items: { type: string }
 *                 description: 'Replaces the key''s ability allowlist entirely — a (possibly empty) subset of the allowed commands. Unknown commands are rejected with 400.'
 *               historyGrant:
 *                 type: string
 *                 description: 'Replaces the chat archive scope this key may back-fill: none | Nd | since_epoch:N | full. Invalid scope → 400.'
 *     responses:
 *       200:
 *         description: Updated key metadata (never the raw key or its hash)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { key: { type: object, description: Metadata for the updated key (id, name, prefix, cmd, historyGrant, isAI, timestamps). } }
 *       400: { description: Invalid cmd (unknown/too many) or historyGrant scope }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { description: 'The caller authenticated with an API key. Key management belongs to the account owner: ask them to create, edit, or revoke keys from a signed-in session' }
 *       404: { description: Key not found, not owned by the caller, or already revoked }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ keyId: string }> },
): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const keyGate = requireNonApiKeySession(session);
    if (keyGate) return keyGate;

    const { keyId } = await params;
    if (!UUID_RE.test(keyId)) {
      return NextResponse.json({ error: 'keyId must be a uuid' }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { cmd, historyGrant } = body as Record<string, unknown>;

    let updated;
    try {
      updated = await updateApiKey(db, session.userId, keyId, { cmd, historyGrant });
    } catch (e) {
      if (e instanceof ApiKeyValidationError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      throw e;
    }
    if (!updated) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 });
    }

    logger.info(ROUTE, 'API key scope updated', { userId: session.userId, keyId, cmd: updated.cmd, historyGrant: updated.historyGrant });
    return NextResponse.json({ key: toApiKeyMeta(updated) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in PATCH', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/profile/api-keys/{keyId}:
 *   delete:
 *     tags: [Profile]
 *     summary: Revoke an API key
 *     description: |
 *       Revokes one of the caller's OWN API keys — a caller can never revoke another user's key
 *       (scoped by session user id, so a foreign or unknown `keyId` returns 404 either way, not a
 *       distinguishing 403). Revocation takes effect immediately: the next request made with this
 *       key gets 401. Idempotent — revoking an already-revoked key also returns 404. Callable only
 *       from a real session — never from another API key, regardless of that key's own `cmd` (see
 *       the 403 below): a delegated credential can never revoke a sibling key, including itself.
 *     operationId: revokeApiKey
 *     x-related-skills: [create-api-key, list-api-keys]
 *     parameters:
 *       - name: keyId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Key revoked
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { revoked: { type: boolean }, id: { type: string, format: uuid } } }
 *       400: { description: Invalid keyId }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { description: 'The caller authenticated with an API key. Key management belongs to the account owner: ask them to create, edit, or revoke keys from a signed-in session' }
 *       404: { description: Key not found, not owned by the caller, or already revoked }
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ keyId: string }> },
): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const keyGate = requireNonApiKeySession(session);
    if (keyGate) return keyGate;

    const { keyId } = await params;
    if (!UUID_RE.test(keyId)) {
      return NextResponse.json({ error: 'keyId must be a uuid' }, { status: 400 });
    }

    const revoked = await revokeApiKey(db, session.userId, keyId);
    if (!revoked) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 });
    }

    logger.info(ROUTE, 'API key revoked', { userId: session.userId, keyId });
    return NextResponse.json({ revoked: true, id: keyId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in DELETE', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
