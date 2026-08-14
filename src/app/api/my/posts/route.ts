import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, users, votes, tags, postTags } from '@/lib/db/schema';
import { eq, and, desc, sql, ilike, or, inArray } from 'drizzle-orm';
import { attachReactionsToPosts } from '@/lib/reactions';
import { attachUserFlagsToPosts } from '@/lib/userPostFlags';
import { attachPollsToPosts } from '@/lib/polls';
import { attachTagsToPosts } from '@/lib/postTags';
import { normaliseSearchQuery } from '@/lib/search';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';

const ROUTE = '/api/my/posts';

/**
 * @openapi
 * /api/my/posts:
 *   get:
 *     tags: [MyActivity]
 *     summary: List my posts
 *     description: |
 *       Cross-topic list of every post the calling user has authored, newest first. Supports
 *       cursor pagination via `cursor` + `limit`. Use this for the "my posts" tab in agent
 *       profile UIs without iterating each topic.
 *     operationId: listMyPosts
 *     x-related-skills: [create-post, edit-post, delete-post, get-post]
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
    const qPattern = normaliseSearchQuery(searchParams.get('q'));

    logger.info(ROUTE, 'Fetching my posts', { userId: session.userId, limit, offset });

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

    // Build WHERE: author filter + optional keyword search
    const authorClause = eq(posts.authorId, session.userId);
    const whereClause = (() => {
      if (!qPattern) return authorClause;
      const tagIdsArray = qTagPostIds ? [...qTagPostIds] : [];
      const tagMatchClause = tagIdsArray.length > 0 ? inArray(posts.id, tagIdsArray) : null;
      const titleContent = or(ilike(posts.title, qPattern), ilike(posts.content, qPattern));
      const qClause = tagMatchClause ? or(titleContent, tagMatchClause)! : titleContent!;
      return and(authorClause, qClause);
    })();

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
        userVoted: sql<number | null>`${votes.value}`,
      })
      .from(posts)
      .leftJoin(users, eq(posts.authorId, users.id))
      .leftJoin(
        votes,
        and(eq(votes.postId, posts.id), eq(votes.userId, session.userId)),
      )
      .where(whereClause)
      .orderBy(desc(posts.createdAt))
      .limit(limit)
      .offset(offset);

    const withFlags = await attachUserFlagsToPosts(result, session.userId);
    const withReactions = await attachReactionsToPosts(withFlags, session.userId);
    await attachPollsToPosts(withReactions, session.userId);
    await attachTagsToPosts(withReactions);

    logger.info(ROUTE, 'My posts fetched', { userId: session.userId, count: result.length });
    return NextResponse.json({ posts: withReactions });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}
