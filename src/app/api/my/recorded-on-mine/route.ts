import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, users, topics, votes } from '@/lib/db/schema';
import { eq, and, desc, gt, sql } from 'drizzle-orm';
import { attachReactionsToPosts } from '@/lib/reactions';
import { attachUserFlagsToPosts } from '@/lib/userPostFlags';
import { logger } from '@/lib/logger';

const ROUTE = '/api/my/recorded-on-mine';

/**
 * @openapi
 * /api/my/recorded-on-mine:
 *   get:
 *     tags: [MyActivity]
 *     summary: List the current user's posts that have been recorded on-chain
 *     description: >-
 *       Returns posts authored by the current user that have at least one
 *       on-chain record (recordCount > 0), sorted by recordCount desc.
 *       This is the "my achievement" view, distinct from /api/my/recorded
 *       which lists posts the user themselves has recorded.
 *     operationId: listMyPostsRecorded
 *     parameters:
 *       - name: limit
 *         in: query
 *         required: false
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *       - name: offset
 *         in: query
 *         required: false
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       '200':
 *         description: My posts with on-chain records
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 posts:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Post'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function GET(request: NextRequest) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10);

    const rows = await db
      .select({
        id: posts.id,
        topicId: posts.topicId,
        authorId: posts.authorId,
        title: posts.title,
        content: posts.content,
        media: posts.media,
        createdAt: posts.createdAt,
        authorNickname: users.nickname,
        authorProfileImage: users.profileImage,
        upvoteCount: posts.upvoteCount,
        viewCount: posts.viewCount,
        commentCount: posts.commentCount,
        recordCount: posts.recordCount,
        isPinned: posts.isPinned,
        isAI: posts.isAI,
        userVoted: sql<number | null>`${votes.value}`,
        topicTitle: topics.title,
      })
      .from(posts)
      .leftJoin(users, eq(posts.authorId, users.id))
      .leftJoin(topics, eq(posts.topicId, topics.id))
      .leftJoin(
        votes,
        and(eq(votes.postId, posts.id), eq(votes.userId, session.userId)),
      )
      .where(
        and(eq(posts.authorId, session.userId), gt(posts.recordCount, 0)),
      )
      .orderBy(desc(posts.recordCount), desc(posts.createdAt))
      .limit(limit)
      .offset(offset);

    const flagged = await attachUserFlagsToPosts(rows, session.userId);
    const postsWithReactions = await attachReactionsToPosts(flagged, session.userId);

    logger.info(ROUTE, 'My recorded posts fetched', {
      userId: session.userId,
      count: rows.length,
    });
    return NextResponse.json({ posts: postsWithReactions });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
