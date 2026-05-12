import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { checkRecordPolicy } from '@/lib/record';
import { logger } from '@/lib/logger';

const ROUTE = '/api/posts/[postId]/record-status';

/**
 * @openapi
 * /api/posts/{postId}/record-status:
 *   get:
 *     tags: [Records]
 *     summary: Check whether the current user can record this post
 *     description: >-
 *       Reports whether the calling user is currently allowed to record
 *       this post on-chain, and if not, the specific reason (already
 *       recorded, daily limit hit, post too new, etc.). Clients use this
 *       to disable / annotate the record action BEFORE the user taps,
 *       so we never hit them with a confirmation prompt followed by a
 *       403 rejection.
 *     operationId: getRecordStatus
 *     parameters:
 *       - name: postId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       '200':
 *         description: Record eligibility for the current user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 allowed:
 *                   type: boolean
 *                 reason:
 *                   type: string
 *                   nullable: true
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const { postId } = await params;
    const result = await checkRecordPolicy(postId, session.userId);
    logger.info(ROUTE, 'Record status fetched', {
      userId: session.userId,
      postId,
      allowed: result.allowed,
    });
    return NextResponse.json({
      allowed: result.allowed,
      reason: result.reason ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
