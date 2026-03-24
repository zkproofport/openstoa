import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, users, votes, topics, topicMembers, tags, postTags, categories } from '@/lib/db/schema';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { getBatchUserBadges } from '@/lib/verification-cache';
import { logger } from '@/lib/logger';

const ROUTE = '/api/feed';

/**
 * @openapi
 * /api/feed:
 *   get:
 *     tags: [Feed]
 *     summary: Get cross-topic posts feed
 *     description: >-
 *       Returns posts across all accessible topics (like Reddit's home feed).
 *       Guests see only posts from public topics. Authenticated users see posts
 *       from public topics plus topics where they are a member.
 *       Supports sorting, tag filtering, and category filtering.
 *     operationId: getFeed
 *     security: []
 *     parameters:
 *       - name: sort
 *         in: query
 *         required: false
 *         description: Sort order
 *         schema:
 *           type: string
 *           enum: [hot, new, top]
 *           default: hot
 *       - name: tag
 *         in: query
 *         required: false
 *         description: Filter by tag slug
 *         schema:
 *           type: string
 *       - name: category
 *         in: query
 *         required: false
 *         description: Filter by category slug
 *         schema:
 *           type: string
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
 *       200:
 *         description: Paginated feed of posts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 posts:
 *                   type: array
 *                   description: Posts sorted by requested order
 *                   items:
 *                     $ref: '#/components/schemas/Post'
 */
export async function GET(request: NextRequest) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const sort = url.searchParams.get('sort') ?? 'hot';
    const tagSlug = url.searchParams.get('tag') ?? null;
    const categorySlug = url.searchParams.get('category') ?? null;
    const view = url.searchParams.get('view') ?? null; // 'my' = only joined topics

    // --- Resolve tag filter ---
    let tagFilteredPostIds: string[] | null = null;
    if (tagSlug) {
      const tag = await db.query.tags.findFirst({ where: eq(tags.slug, tagSlug) });
      if (tag) {
        const rows = await db
          .select({ postId: postTags.postId })
          .from(postTags)
          .where(eq(postTags.tagId, tag.id));
        tagFilteredPostIds = rows.map((r) => r.postId);
      } else {
        tagFilteredPostIds = [];
      }
    }

    // --- Resolve category filter ---
    let categoryTopicIds: string[] | null = null;
    if (categorySlug) {
      const category = await db.query.categories.findFirst({ where: eq(categories.slug, categorySlug) });
      if (category) {
        const rows = await db
          .select({ id: topics.id })
          .from(topics)
          .where(eq(topics.categoryId, category.id));
        categoryTopicIds = rows.map((r) => r.id);
      } else {
        categoryTopicIds = [];
      }
    }

    // --- Build sort expression ---
    const sortExpr =
      sort === 'new' ? desc(posts.createdAt) :
      sort === 'top' ? desc(posts.upvoteCount) :
      desc(posts.score); // 'hot' default

    // --- Guest path ---
    if (!session) {
      logger.info(ROUTE, 'Guest fetching feed');

      // Accessible topics: public only
      const accessibleTopicIds = await resolvePublicTopicIds(categoryTopicIds);

      if (accessibleTopicIds.length === 0) {
        return NextResponse.json({ posts: [] });
      }

      const whereConditions = buildWhereConditions(accessibleTopicIds, tagFilteredPostIds);

      const feedPosts = await db
        .select({
          id: posts.id,
          topicId: posts.topicId,
          authorId: posts.authorId,
          title: posts.title,
          content: posts.content,
          createdAt: posts.createdAt,
          updatedAt: posts.updatedAt,
          authorNickname: users.nickname,
          authorProfileImage: users.profileImage,
          topicTitle: topics.title,
          upvoteCount: posts.upvoteCount,
          viewCount: posts.viewCount,
          commentCount: posts.commentCount,
          score: posts.score,
          isPinned: posts.isPinned,
          recordCount: posts.recordCount,
          userVoted: sql<number | null>`null`,
        })
        .from(posts)
        .innerJoin(topics, eq(posts.topicId, topics.id))
        .leftJoin(users, eq(posts.authorId, users.id))
        .where(whereConditions)
        .orderBy(sortExpr)
        .limit(limit)
        .offset(offset);

      const guestAuthorIds = feedPosts.map(p => p.authorId).filter(Boolean);
      const guestBadgeMap = await getBatchUserBadges(guestAuthorIds);
      const guestPostsWithBadges = feedPosts.map(p => ({
        ...p,
        badges: p.authorId ? (guestBadgeMap.get(p.authorId) ?? []) : [],
      }));

      logger.info(ROUTE, 'Guest feed fetched', { count: feedPosts.length });
      return NextResponse.json({ posts: guestPostsWithBadges });
    }

    // --- Authenticated path ---
    logger.info(ROUTE, 'Authenticated user fetching feed', { userId: session.userId, view });

    // view=my: only show posts from topics the user has joined
    let accessibleTopicIds: string[];
    if (view === 'my') {
      const memberships = await db.query.topicMembers.findMany({
        where: eq(topicMembers.userId, session.userId),
      });
      accessibleTopicIds = memberships.map(m => m.topicId);
      if (categoryTopicIds) {
        accessibleTopicIds = accessibleTopicIds.filter(id => categoryTopicIds.includes(id));
      }
    } else {
      // Accessible topics: public topics UNION topics where user is a member
      accessibleTopicIds = await resolveAccessibleTopicIds(session.userId, categoryTopicIds);
    }

    if (accessibleTopicIds.length === 0) {
      return NextResponse.json({ posts: [] });
    }

    const whereConditions = buildWhereConditions(accessibleTopicIds, tagFilteredPostIds);

    const feedPosts = await db
      .select({
        id: posts.id,
        topicId: posts.topicId,
        authorId: posts.authorId,
        title: posts.title,
        content: posts.content,
        createdAt: posts.createdAt,
        updatedAt: posts.updatedAt,
        authorNickname: users.nickname,
        authorProfileImage: users.profileImage,
        topicTitle: topics.title,
        upvoteCount: posts.upvoteCount,
        viewCount: posts.viewCount,
        commentCount: posts.commentCount,
        score: posts.score,
        isPinned: posts.isPinned,
        recordCount: posts.recordCount,
        userVoted: sql<number | null>`${votes.value}`,
      })
      .from(posts)
      .innerJoin(topics, eq(posts.topicId, topics.id))
      .leftJoin(users, eq(posts.authorId, users.id))
      .leftJoin(votes, and(eq(votes.postId, posts.id), eq(votes.userId, session.userId)))
      .where(whereConditions)
      .orderBy(sortExpr)
      .limit(limit)
      .offset(offset);

    const authAuthorIds = feedPosts.map(p => p.authorId).filter(Boolean);
    const authBadgeMap = await getBatchUserBadges(authAuthorIds);
    const authPostsWithBadges = feedPosts.map(p => ({
      ...p,
      badges: p.authorId ? (authBadgeMap.get(p.authorId) ?? []) : [],
    }));

    logger.info(ROUTE, 'Authenticated feed fetched', { userId: session.userId, count: feedPosts.length });
    return NextResponse.json({ posts: authPostsWithBadges });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Resolve public topic IDs, optionally filtered by category.
 */
async function resolvePublicTopicIds(categoryTopicIds: string[] | null): Promise<string[]> {
  if (categoryTopicIds !== null) {
    if (categoryTopicIds.length === 0) return [];
    const rows = await db
      .select({ id: topics.id })
      .from(topics)
      .where(and(eq(topics.visibility, 'public'), inArray(topics.id, categoryTopicIds)));
    return rows.map((r) => r.id);
  }

  const rows = await db
    .select({ id: topics.id })
    .from(topics)
    .where(eq(topics.visibility, 'public'));
  return rows.map((r) => r.id);
}

/**
 * Resolve accessible topic IDs for an authenticated user (public + member topics),
 * optionally filtered by category.
 */
async function resolveAccessibleTopicIds(userId: string, categoryTopicIds: string[] | null): Promise<string[]> {
  // Get user's member topics
  const memberships = await db
    .select({ topicId: topicMembers.topicId })
    .from(topicMembers)
    .where(eq(topicMembers.userId, userId));
  const memberTopicIds = memberships.map((m) => m.topicId);

  // Get public topics
  const publicRows = await db
    .select({ id: topics.id })
    .from(topics)
    .where(eq(topics.visibility, 'public'));
  const publicTopicIds = publicRows.map((r) => r.id);

  // Union (deduplicate)
  const allAccessible = [...new Set([...memberTopicIds, ...publicTopicIds])];

  // Apply category filter if present
  if (categoryTopicIds !== null) {
    if (categoryTopicIds.length === 0) return [];
    const categorySet = new Set(categoryTopicIds);
    return allAccessible.filter((id) => categorySet.has(id));
  }

  return allAccessible;
}

/**
 * Build the WHERE clause combining topic access and optional tag filter.
 */
function buildWhereConditions(accessibleTopicIds: string[], tagFilteredPostIds: string[] | null) {
  const topicCondition = inArray(posts.topicId, accessibleTopicIds);

  if (tagFilteredPostIds !== null) {
    if (tagFilteredPostIds.length === 0) {
      return and(topicCondition, sql`false`);
    }
    return and(topicCondition, inArray(posts.id, tagFilteredPostIds));
  }

  return topicCondition;
}
