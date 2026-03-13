import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, records, users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { isContentHashMatch } from '@/lib/record';

const ROUTE = '/api/posts/[postId]/records';

/**
 * @openapi
 * /api/posts/{postId}/records:
 *   get:
 *     tags: [Records]
 *     summary: Get on-chain records for a post
 *     description: >-
 *       Returns the list of on-chain records for a post, including recorder info,
 *       tx hash, and whether the recorded content hash still matches the current content.
 *       Session is optional — if authenticated, also returns whether the current user
 *       has already recorded this post.
 *     operationId: getPostRecords
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
 *         description: List of on-chain records
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 records:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       recorderNickname:
 *                         type: string
 *                         nullable: true
 *                       recorderProfileImage:
 *                         type: string
 *                         nullable: true
 *                       txHash:
 *                         type: string
 *                         nullable: true
 *                       contentHash:
 *                         type: string
 *                       contentHashMatch:
 *                         type: boolean
 *                         description: Whether the recorded hash matches current post content
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                 recordCount:
 *                   type: integer
 *                   description: Total number of records
 *                 postEdited:
 *                   type: boolean
 *                   description: True if any record's hash does not match current content
 *                 userRecorded:
 *                   type: boolean
 *                   description: Whether the authenticated user has already recorded this post
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);

    const { postId } = await params;

    logger.info(ROUTE, 'Fetching records for post', { postId, userId: session?.userId ?? null });

    // Fetch the post to get current content for hash comparison
    const postResults = await db
      .select({ id: posts.id, content: posts.content })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    if (postResults.length === 0) {
      logger.warn(ROUTE, 'Post not found', { postId });
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    const post = postResults[0];

    // Query records JOIN with users
    const recordResults = await db
      .select({
        id: records.id,
        recorderNullifier: records.recorderNullifier,
        contentHash: records.contentHash,
        txHash: records.txHash,
        createdAt: records.createdAt,
        recorderNickname: users.nickname,
        recorderProfileImage: users.profileImage,
      })
      .from(records)
      .leftJoin(users, eq(records.recorderNullifier, users.id))
      .where(eq(records.postId, postId))
      .orderBy(records.createdAt);

    // Compute per-record hash match and postEdited flag
    let postEdited = false;
    const mappedRecords = recordResults.map((record) => {
      const contentHashMatch = isContentHashMatch(post.content, record.contentHash);
      if (!contentHashMatch) postEdited = true;
      return {
        id: record.id,
        recorderNickname: record.recorderNickname ?? null,
        recorderProfileImage: record.recorderProfileImage ?? null,
        txHash: record.txHash,
        contentHash: record.contentHash,
        contentHashMatch,
        createdAt: record.createdAt,
      };
    });

    // Determine if the current user has already recorded this post
    const userRecorded = session
      ? recordResults.some((r) => r.recorderNullifier === session.userId)
      : false;

    logger.info(ROUTE, 'Records fetched', { postId, count: mappedRecords.length, postEdited, userRecorded });

    return NextResponse.json({
      records: mappedRecords,
      recordCount: mappedRecords.length,
      postEdited,
      userRecorded,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
