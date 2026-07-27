import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topicMembers, aiGrants } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { revokeGrant } from '@/lib/aiGrants';

const ROUTE = '/api/topics/[topicId]/ai/grants/[grantId]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @openapi
 * /api/topics/{topicId}/ai/grants/{grantId}:
 *   delete:
 *     tags: [AI]
 *     summary: Revoke an AI grant (owner or the bot itself)
 *     description: |
 *       Revokes a grant by setting `revoked_at`, which immediately makes the AI's future chat
 *       sends / history reads 403 (design §7, D11). Allowed callers: the topic **owner/admin**, or
 *       **the AI itself** (a bot may relinquish its own capability). Idempotent — revoking an
 *       already-revoked or unknown grant returns 404.
 *
 *       **D11 (documented cost):** this gates FUTURE server-mediated actions and pairs with a
 *       client-driven MLS Remove (future PCS). Past plaintext the AI already received is NOT
 *       cryptographically revocable — revocation = server access-gating + MLS Remove(future) +
 *       grant revoke, never a retroactive unshare.
 *     operationId: revokeAiGrant
 *     x-related-skills: [create-ai-grant, list-ai-grants]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - name: grantId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Grant revoked
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { revoked: { type: boolean }, id: { type: string, format: uuid } } }
 *       400: { description: Invalid grantId }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { description: Caller is neither the topic owner/admin nor the granted AI }
 *       404: { description: Grant not found (or already revoked) }
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string; grantId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId, grantId } = await params;

    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    if (!UUID_RE.test(grantId)) {
      return NextResponse.json({ error: 'grantId must be a uuid' }, { status: 400 });
    }

    const grant = await db.query.aiGrants.findFirst({
      where: and(eq(aiGrants.id, grantId), eq(aiGrants.topicId, topicId)),
    });
    if (!grant) {
      return NextResponse.json({ error: 'Grant not found' }, { status: 404 });
    }

    // Authz: the granted AI can revoke its own grant; otherwise the caller must
    // be the topic owner/admin.
    const isBotItself = session.userId === grant.aiUserId;
    if (!isBotItself) {
      const membership = await db.query.topicMembers.findFirst({
        where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
      });
      const isOwner = membership?.role === 'owner' || membership?.role === 'admin';
      if (!isOwner) {
        return NextResponse.json({ error: 'Only the topic owner/admin or the AI itself can revoke this grant' }, { status: 403 });
      }
    }

    const revoked = await revokeGrant(db, topicId, grantId);
    if (!revoked) {
      // Lost the race or already revoked — nothing active to flip.
      return NextResponse.json({ error: 'Grant not found' }, { status: 404 });
    }

    logger.info(ROUTE, 'AI grant revoked', { topicId, grantId, by: session.userId });
    return NextResponse.json({ revoked: true, id: grantId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in DELETE', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
