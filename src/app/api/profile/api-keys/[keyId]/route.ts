import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { revokeApiKey } from '@/lib/apiKeys';

const ROUTE = '/api/profile/api-keys/[keyId]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 *       key gets 401. Idempotent — revoking an already-revoked key also returns 404.
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
