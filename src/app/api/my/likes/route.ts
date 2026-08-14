import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, votes, users, tags, postTags } from '@/lib/db/schema';
import { eq, and, desc, ilike, or, inArray } from 'drizzle-orm';
import { normaliseSearchQuery } from '@/lib/search';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';

const ROUTE = '/api/my/likes';

/**
 * @openapi
 * /api/my/likes:
 *   get:
 *     tags: [MyActivity]
 *     summary: List my liked posts
 *     description: |
 *       Returns every post the calling user has upvoted (`value=1`), sorted by upvote-time
 *       newest-first. Supports cursor pagination via `cursor` + `limit`. Cast / clear a vote
 *       with `POST /api/posts/{postId}/vote`.
 *     operationId: listMyLikes
 *     x-related-skills: [toggle-vote, get-post]
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
 *         description: Posts upvoted by current user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 posts:
 *                   type: array
 *                   description: Upvoted posts sorted by newest first
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
    const qPattern = normaliseSearchQuery(searchParams.get('q'));

    logger.info(ROUTE, 'Fetching liked posts', { userId: session.userId, limit, offset });

    // Resolve post-tag matches for keyword search
    let qTagPostIds: Set<string> | null = null;
    if (qPattern) {
      const rows = await db
        .select({ postId: postTags.postId })
        .from(postTags)
        .innerJoin(tags, eq(postTags.tagId, tags.id))
        .where(or(ilike(tags.name, qPattern), ilike(tags.slug, qPattern))!);
      qTagPostIds = new Set(rows.map((r) => r.postId));
    }

    // Build WHERE: upvote filter + optional keyword search
    const likeClause = and(eq(votes.userId, session.userId), eq(votes.value, 1));
    const whereClause = (() => {
      if (!qPattern) return likeClause;
      const tagIdsArray = qTagPostIds ? [...qTagPostIds] : [];
      const tagMatchClause = tagIdsArray.length > 0 ? inArray(posts.id, tagIdsArray) : null;
      const titleContent = or(ilike(posts.title, qPattern), ilike(posts.content, qPattern));
      const qClause = tagMatchClause ? or(titleContent, tagMatchClause)! : titleContent!;
      return and(likeClause, qClause);
    })();

    const likedPosts = await db
      .select({
        id: posts.id,
        topicId: posts.topicId,
        title: posts.title,
        content: posts.content,
        media: posts.media,
        authorNickname: users.nickname,
        upvoteCount: posts.upvoteCount,
        commentCount: posts.commentCount,
        viewCount: posts.viewCount,
        createdAt: posts.createdAt,
      })
      .from(votes)
      .innerJoin(posts, eq(votes.postId, posts.id))
      .leftJoin(users, eq(posts.authorId, users.id))
      .where(whereClause)
      .orderBy(desc(posts.createdAt))
      .limit(limit)
      .offset(offset);

    logger.info(ROUTE, 'Liked posts fetched', { userId: session.userId, count: likedPosts.length });
    return NextResponse.json({ posts: likedPosts });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}
