import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, records, users } from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import {
  checkRecordPolicy,
  computeContentHash,
  incrementDailyCount,
} from '@/lib/record';
import { keccak256, toUtf8Bytes } from 'ethers';
import { recordOnChain } from '@/lib/contract';

const ROUTE = '/api/posts/[postId]/record';

/**
 * @openapi
 * /api/posts/{postId}/record:
 *   post:
 *     tags: [Records]
 *     summary: Record a post on-chain
 *     description: >-
 *       Records a post's content hash on-chain via the service wallet. Subject to policy
 *       checks: must not be your own post, post must be at least 1 hour old, you may not
 *       record the same post twice, and a daily limit of 3 recordings applies.
 *     operationId: recordPost
 *     parameters:
 *       - name: postId
 *         in: path
 *         required: true
 *         description: Post ID
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Post recorded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 record:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     contentHash:
 *                       type: string
 *                       description: keccak256 hash of post content at time of recording
 *                     recordCount:
 *                       type: integer
 *                       description: Updated total record count for the post
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Forbidden — policy check failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       404:
 *         description: Post not found
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { postId } = await params;

    logger.info(ROUTE, 'Checking record policy', { userId: session.userId, postId });

    // Policy check (includes post existence, age, duplicate, daily limit)
    const policy = await checkRecordPolicy(postId, session.userId);
    if (!policy.allowed) {
      logger.warn(ROUTE, 'Record policy denied', { userId: session.userId, postId, reason: policy.reason });
      return NextResponse.json({ error: policy.reason }, { status: 403 });
    }

    // Fetch the post to get content and authorId
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, postId),
    });

    if (!post) {
      logger.warn(ROUTE, 'Post not found', { postId });
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    // Compute hashes
    const contentHash = computeContentHash(post.content);
    // postIdHash is what the contract uses — keccak256 of the UUID string
    const postIdHash = keccak256(toUtf8Bytes(postId));
    const authorNullifierHash = keccak256(toUtf8Bytes(post.authorId));
    const recorderNullifierHash = keccak256(toUtf8Bytes(session.userId));

    // Insert record as 'pending' before submitting on-chain TX
    const [inserted] = await db
      .insert(records)
      .values({
        postId,
        recorderNullifier: session.userId,
        contentHash,
        txHash: null,
        method: 'service',
        status: 'pending',
      })
      .returning({ id: records.id });

    // Submit on-chain TX
    let txHash: string;
    try {
      const result = await recordOnChain(postIdHash, contentHash, authorNullifierHash, recorderNullifierHash);
      txHash = result.txHash;
    } catch (onChainError) {
      const errMsg = onChainError instanceof Error ? onChainError.message : String(onChainError);
      logger.error(ROUTE, 'On-chain TX failed', { userId: session.userId, postId, recordId: inserted.id, error: errMsg });
      await db
        .update(records)
        .set({ status: 'failed' })
        .where(eq(records.id, inserted.id));
      return NextResponse.json({ error: `On-chain transaction failed: ${errMsg}` }, { status: 500 });
    }

    // Update record with txHash and confirmed status
    await db
      .update(records)
      .set({ txHash, status: 'confirmed' })
      .where(eq(records.id, inserted.id));

    // Increment recorder's daily limit counter (after TX success only)
    await incrementDailyCount(session.userId);

    // Increment post's record count
    const [updatedPost] = await db
      .update(posts)
      .set({ recordCount: sql`${posts.recordCount} + 1` })
      .where(eq(posts.id, postId))
      .returning({ recordCount: posts.recordCount });

    // Increment author's total recorded count
    await db
      .update(users)
      .set({ totalRecorded: sql`${users.totalRecorded} + 1` })
      .where(eq(users.id, post.authorId));

    logger.info(ROUTE, 'Post recorded', { userId: session.userId, postId, recordId: inserted.id, txHash });

    return NextResponse.json({
      success: true,
      record: {
        id: inserted.id,
        contentHash,
        recordCount: updatedPost.recordCount,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
