import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, users } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/my/posts';

/**
 * @openapi
 * /api/my/posts:
 *   get:
 *     tags: [MyActivity]
 *     summary: List my posts
 *     description: >-
 *       Lists the current user's own posts across all topics, sorted by newest first.
 *     operationId: listMyPosts
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
 *         description: Current user's posts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 posts:
 *                   type: array
 *                   description: User's posts sorted by newest first
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

    logger.info(ROUTE, 'Fetching my posts', { userId: session.userId, limit, offset });

    const result = await db
      .select({
        id: posts.id,
        topicId: posts.topicId,
        authorId: posts.authorId,
        title: posts.title,
        content: posts.content,
        upvoteCount: posts.upvoteCount,
        viewCount: posts.viewCount,
        commentCount: posts.commentCount,
        score: posts.score,
        createdAt: posts.createdAt,
        updatedAt: posts.updatedAt,
        authorNickname: users.nickname,
      })
      .from(posts)
      .leftJoin(users, eq(posts.authorId, users.id))
      .where(eq(posts.authorId, session.userId))
      .orderBy(desc(posts.createdAt))
      .limit(limit)
      .offset(offset);

    logger.info(ROUTE, 'My posts fetched', { userId: session.userId, count: result.length });
    return NextResponse.json({ posts: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
