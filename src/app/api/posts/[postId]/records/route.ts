import {canReadPost, NOT_A_MEMBER} from '@/lib/postReadable';
import {authorizeApiRequest} from '@/lib/apiAuthorization';
import { withPublicIdentityBadges } from '@/lib/identity-badges';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, records, users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { isValidUUID } from '@/lib/uuid';
import { isContentHashMatch } from '@/lib/record';
import { txExplorerUrl } from '@/lib/explorer';

const ROUTE = '/api/posts/[postId]/records';

/**
 * @openapi
 * /api/posts/{postId}/records:
 *   get:
 *     tags: [Records]
 *     summary: Get on-chain records for a post
 *     description: |
 *       Returns every on-chain record for a post — `[ { recorderId, txHash, contentHash,
 *       blockNumber, recordedAt, contentMatches } ]`. `contentMatches` is `false` if the post
 *       has been edited since this record was anchored (records become historical evidence,
 *       not live state). Guests can read public-topic records; private-topic posts require
 *       login and secret-topic posts require membership.
 *       authenticated callers additionally see `currentUserHasRecorded` to dim the record
 *       button. Use `POST /api/posts/{postId}/record` to add a record (policy-gated).
 *       Each recorder includes `recorderId` and visible-only `recorderBadges`.
 *     operationId: getPostRecords
 *     x-related-skills: [record-post, get-record-status, list-my-recorded]
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
 *                       recorderId:
 *                         type: string
 *                       recorderBadges:
 *                         type: array
 *                         items:
 *                           $ref: '#/components/schemas/PublicBadge'
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
  const authorizationError = await authorizeApiRequest(request, '/api/posts/[postId]/records');
  if (authorizationError) return authorizationError;

  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);

    const { postId } = await params;
    if (!isValidUUID(postId)) {
      return NextResponse.json({ error: 'Invalid postId' }, { status: 400 });
    }

    logger.info(ROUTE, 'Fetching records for post', { postId, userId: session?.userId ?? null });

    // Fetch the post to get current content for hash comparison
    const postResults = await db
      .select({ id: posts.id, content: posts.content, topicId: posts.topicId })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    if (postResults.length === 0) {
      logger.warn(ROUTE, 'Post not found', { postId });
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    const post = postResults[0];
    if (!await canReadPost(post.topicId, session?.userId)) {
      return NextResponse.json({ error: session ? NOT_A_MEMBER : 'Login required' }, { status: session ? 403 : 401 });
    }

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
    const recordersWithBadges = await withPublicIdentityBadges(recordResults, record => record.recorderNullifier);
    const mappedRecords = recordersWithBadges.map((record) => {
      const contentHashMatch = isContentHashMatch(post.content, record.contentHash);
      if (!contentHashMatch) postEdited = true;
      return {
        id: record.id,
        recorderId: record.recorderNullifier,
        recorderBadges: record.badges,
        recorderNickname: record.recorderNickname ?? null,
        recorderProfileImage: record.recorderProfileImage ?? null,
        txHash: record.txHash,
        // Pre-resolved BaseScan link; clients open it directly without
        // having to know which chain we're on.
        txExplorerUrl: txExplorerUrl(record.txHash),
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
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}
