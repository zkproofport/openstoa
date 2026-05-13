import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { bookmarks, posts, users, votes, topics } from '@/lib/db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { attachReactionsToPosts } from '@/lib/reactions';
import { attachUserFlagsToPosts } from '@/lib/userPostFlags';
import { logger } from '@/lib/logger';

const ROUTE = '/api/bookmarks';

/**
 * @openapi
 * /api/bookmarks:
 *   get:
 *     tags: [Bookmarks]
 *     summary: List bookmarked posts
 *     description: >-
 *       Lists all posts bookmarked by the current user, sorted by bookmark time (newest first).
 *     operationId: listBookmarks
 *     parameters:
 *       - name: limit
 *         in: query
 *         required: false
 *         description: Number of posts to return (max 100)
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *       - name: offset
 *         in: query
 *         required: false
 *         description: Number of posts to skip
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       '200':
 *         description: Bookmarked posts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 posts:
 *                   type: array
 *                   description: Bookmarked posts with bookmarkedAt timestamp
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/Post'
 *                       - type: object
 *                         properties:
 *                           bookmarkedAt:
 *                             type: string
 *                             format: date-time
 *                             description: When the post was bookmarked
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

    logger.info(ROUTE, 'Fetching bookmarked posts', { userId: session.userId, limit, offset });

    const result = await db
      .select({
        id: posts.id,
        topicId: posts.topicId,
        authorId: posts.authorId,
        title: posts.title,
        content: posts.content,
        media: posts.media,
        upvoteCount: posts.upvoteCount,
        viewCount: posts.viewCount,
        commentCount: posts.commentCount,
        recordCount: posts.recordCount,
        score: posts.score,
        createdAt: posts.createdAt,
        updatedAt: posts.updatedAt,
        authorNickname: users.nickname,
        bookmarkedAt: bookmarks.createdAt,
        userVoted: sql<number | null>`${votes.value}`,
        topicTitle: topics.title,
      })
      .from(bookmarks)
      .innerJoin(posts, eq(bookmarks.postId, posts.id))
      .leftJoin(users, eq(posts.authorId, users.id))
      .leftJoin(topics, eq(posts.topicId, topics.id))
      .leftJoin(
        votes,
        and(eq(votes.postId, posts.id), eq(votes.userId, session.userId)),
      )
      .where(eq(bookmarks.userId, session.userId))
      .orderBy(desc(bookmarks.createdAt))
      .limit(limit)
      .offset(offset);

    // Helper batches the bookmark + record flag lookup. Bookmark is
    // tautologically true here (every row is in the bookmarks table)
    // but using the same helper keeps the field set identical across
    // every list response.
    const withFlags = await attachUserFlagsToPosts(result, session.userId);
    const withReactions = await attachReactionsToPosts(withFlags, session.userId);

    logger.info(ROUTE, 'Bookmarked posts fetched', { userId: session.userId, count: result.length });
    return NextResponse.json({ posts: withReactions });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
