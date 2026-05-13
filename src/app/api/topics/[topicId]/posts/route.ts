import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, topicMembers, users, tags, postTags, votes, topics } from '@/lib/db/schema';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { updateTopicScore } from '@/lib/topicScore';
import { extractAndUploadBase64Images } from '@/lib/base64-upload';

import { getBatchUserBadges, filterBadgesByTopicProofType, type Badge } from '@/lib/verification-cache';
import { attachReactionsToPosts } from '@/lib/reactions';
import { attachUserFlagsToPosts } from '@/lib/userPostFlags';
import { attachPollsToPosts, createPollForPost } from '@/lib/polls';

const ROUTE = '/api/topics/[topicId]/posts';

// Batch-load post→tag rows and mutate each post with a `tags` array. Mirrors
// the per-post tag block on the detail endpoint so PostCard's chip row has
// data to render without an extra round-trip per card.
async function attachTagsToPosts<T extends { id: string; tags?: { name: string; slug: string }[] }>(
  postsList: T[],
): Promise<void> {
  if (postsList.length === 0) return;
  const postIds = postsList.map((p) => p.id);
  const rows = await db
    .select({ postId: postTags.postId, name: tags.name, slug: tags.slug })
    .from(postTags)
    .innerJoin(tags, eq(postTags.tagId, tags.id))
    .where(inArray(postTags.postId, postIds));
  const tagMap = new Map<string, { name: string; slug: string }[]>();
  for (const row of rows) {
    const existing = tagMap.get(row.postId) ?? [];
    existing.push({ name: row.name, slug: row.slug });
    tagMap.set(row.postId, existing);
  }
  for (const post of postsList) {
    post.tags = tagMap.get(post.id) ?? [];
  }
}

/**
 * @openapi
 * /api/topics/{topicId}/posts:
 *   get:
 *     tags: [Posts]
 *     summary: List posts in topic
 *     description: >-
 *       Authentication optional for public topics. Guests can read posts in public topics.
 *       Private and secret topics require authentication and membership.
 *       Pinned posts always appear first regardless of sort order.
 *       Supports tag filtering and sorting by newest or popularity.
 *     operationId: listPosts
 *     security: []
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: Topic ID
 *         schema:
 *           type: string
 *           format: uuid
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
 *       - name: tag
 *         in: query
 *         required: false
 *         description: Filter by tag slug
 *         schema:
 *           type: string
 *       - name: sort
 *         in: query
 *         required: false
 *         description: Sort order
 *         schema:
 *           type: string
 *           enum: [new, popular, recorded]
 *           default: new
 *     responses:
 *       200:
 *         description: Paginated list of posts (pinned posts first)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 posts:
 *                   type: array
 *                   description: Posts in the topic
 *                   items:
 *                     $ref: '#/components/schemas/Post'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *   post:
 *     tags: [Posts]
 *     summary: Create post in topic
 *     description: >-
 *       Creates a new post in a topic. Supports up to 5 tags (created automatically if they don't
 *       exist). Triggers async topic score recalculation.
 *     operationId: createPost
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: Topic ID
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, content]
 *             properties:
 *               title:
 *                 type: string
 *                 description: Post title
 *               content:
 *                 type: string
 *                 description: Post body (HTML, base64 images auto-uploaded to CDN)
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *                 maxItems: 5
 *                 description: Tag names (max 5, auto-created if new)
 *     responses:
 *       201:
 *         description: Post created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 post:
 *                   $ref: '#/components/schemas/Post'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    const { topicId } = await params;

    // --- Guest (unauthenticated) access ---
    if (!session) {
      logger.info(ROUTE, 'Guest fetching posts', { topicId });

      // Guests can only read posts in public topics
      const topic = await db.query.topics.findFirst({
        where: eq(topics.id, topicId),
      });

      if (!topic) {
        return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
      }

      if (topic.visibility !== 'public') {
        logger.warn(ROUTE, 'Guest attempted to read non-public topic posts', { topicId, visibility: topic.visibility });
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      }

      const url = new URL(request.url);
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
      const tagSlug = url.searchParams.get('tag') ?? null;
      const sort = url.searchParams.get('sort') ?? 'new';

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

      const whereClause =
        tagFilteredPostIds !== null
          ? tagFilteredPostIds.length > 0
            ? and(eq(posts.topicId, topicId), inArray(posts.id, tagFilteredPostIds))
            : and(eq(posts.topicId, topicId), sql`false`)
          : eq(posts.topicId, topicId);

      // No userVoted join for guests
      const topicPosts = await db
        .select({
          id: posts.id,
          topicId: posts.topicId,
          authorId: posts.authorId,
          title: posts.title,
          content: posts.content,
          media: posts.media,
          createdAt: posts.createdAt,
          updatedAt: posts.updatedAt,
          authorNickname: users.nickname,
          authorProfileImage: users.profileImage,
          upvoteCount: posts.upvoteCount,
          viewCount: posts.viewCount,
          commentCount: posts.commentCount,
          score: posts.score,
          isPinned: posts.isPinned,
          recordCount: posts.recordCount,
          isAI: posts.isAI,
          userVoted: sql<number | null>`null`,
        })
        .from(posts)
        .leftJoin(users, eq(posts.authorId, users.id))
        .where(whereClause)
        .orderBy(
          desc(posts.isPinned),
          sort === 'popular' ? desc(posts.score) : sort === 'recorded' ? desc(posts.recordCount) : desc(posts.createdAt),
        )
        .limit(limit)
        .offset(offset);

      const guestAuthorIds = [...new Set(topicPosts.map((p) => p.authorId).filter(Boolean))] as string[];
      const guestBadgeMap = await getBatchUserBadges(guestAuthorIds);
      const guestPostsWithBadges = topicPosts.map((p) => ({
        ...p,
        badges: filterBadgesByTopicProofType(guestBadgeMap.get(p.authorId) ?? [], topic.proofType),
      }));

      const guestPostsWithReactions = await attachReactionsToPosts(guestPostsWithBadges, null);
      await attachPollsToPosts(guestPostsWithReactions, null);
      await attachTagsToPosts(guestPostsWithReactions);

      logger.info(ROUTE, 'Guest posts fetched', { topicId, count: topicPosts.length });
      return NextResponse.json({ posts: guestPostsWithReactions });
    }

    // --- Authenticated access ---

    // Check membership
    const membership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, session.userId),
      ),
    });

    if (!membership) {
      // Public topics: allow reading for non-members (write still requires membership)
      const topicCheck = await db.query.topics.findFirst({
        where: eq(topics.id, topicId),
        columns: { visibility: true },
      });
      if (!topicCheck || topicCheck.visibility !== 'public') {
        logger.warn(ROUTE, 'User is not a member of this topic', { userId: session.userId, topicId });
        return NextResponse.json(
          { error: 'Not a member of this topic' },
          { status: 403 },
        );
      }
    }

    // Pagination + tag filter
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const tagSlug = url.searchParams.get('tag') ?? null;
    const sort = url.searchParams.get('sort') ?? 'new';

    logger.info(ROUTE, 'Fetching posts', { userId: session.userId, topicId, limit, offset, tagSlug, sort });

    // When a tag filter is requested, resolve the tag and collect matching postIds
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
        // Tag doesn't exist — return empty result
        tagFilteredPostIds = [];
      }
    }

    const whereClause =
      tagFilteredPostIds !== null
        ? tagFilteredPostIds.length > 0
          ? and(eq(posts.topicId, topicId), inArray(posts.id, tagFilteredPostIds))
          : and(eq(posts.topicId, topicId), sql`false`)
        : eq(posts.topicId, topicId);

    const topicPosts = await db
      .select({
        id: posts.id,
        topicId: posts.topicId,
        authorId: posts.authorId,
        title: posts.title,
        content: posts.content,
        media: posts.media,
        createdAt: posts.createdAt,
        updatedAt: posts.updatedAt,
        authorNickname: users.nickname,
        authorProfileImage: users.profileImage,
        upvoteCount: posts.upvoteCount,
        viewCount: posts.viewCount,
        commentCount: posts.commentCount,
        score: posts.score,
        isPinned: posts.isPinned,
        recordCount: posts.recordCount,
        isAI: posts.isAI,
        userVoted: sql<number | null>`${votes.value}`,
      })
      .from(posts)
      .leftJoin(users, eq(posts.authorId, users.id))
      .leftJoin(votes, and(eq(votes.postId, posts.id), eq(votes.userId, session.userId)))
      .where(whereClause)
      .orderBy(
        desc(posts.isPinned),
        sort === 'popular' ? desc(posts.score) : sort === 'recorded' ? desc(posts.recordCount) : desc(posts.createdAt),
      )
      .limit(limit)
      .offset(offset);

    // Get topic proofType for badge filtering
    const topicForBadge = await db.query.topics.findFirst({
      where: eq(topics.id, topicId),
      columns: { proofType: true },
    });

    const authorIds = [...new Set(topicPosts.map((p) => p.authorId).filter(Boolean))] as string[];
    const badgeMap = await getBatchUserBadges(authorIds);
    const postsWithBadges = topicPosts.map((p) => ({
      ...p,
      badges: filterBadgesByTopicProofType(badgeMap.get(p.authorId) ?? [], topicForBadge?.proofType ?? null),
    }));

    const postsWithFlags = await attachUserFlagsToPosts(postsWithBadges, session.userId);
    const postsWithReactions = await attachReactionsToPosts(postsWithFlags, session.userId);
    await attachPollsToPosts(postsWithReactions, session.userId);
    await attachTagsToPosts(postsWithReactions);

    logger.info(ROUTE, 'Posts fetched', { userId: session.userId, topicId, count: topicPosts.length });
    return NextResponse.json({ posts: postsWithReactions });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { topicId } = await params;

    // Check membership
    const membership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, session.userId),
      ),
    });

    if (!membership) {
      logger.warn(ROUTE, 'User is not a member of this topic', { userId: session.userId, topicId });
      return NextResponse.json(
        { error: 'Not a member of this topic' },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { title, content, tags: tagNames, media: mediaIn, poll: pollIn } = body;

    if (!title || typeof title !== 'string') {
      logger.warn(ROUTE, 'Missing title', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }
    if (!content || typeof content !== 'string') {
      logger.warn(ROUTE, 'Missing content', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Content is required' }, { status: 400 });
    }

    // Extract base64 images from content and upload to R2
    const processedContent = await extractAndUploadBase64Images(content, session.userId);

    // Normalise media payload: accept { images?: string[], videos?: string[] }
    // and discard anything else. Null when neither array has any entries so the
    // column stays NULL (cheaper to query, signals "no attachments" cleanly).
    const media = (() => {
      if (!mediaIn || typeof mediaIn !== 'object') return null;
      const images = Array.isArray(mediaIn.images)
        ? (mediaIn.images as unknown[]).filter((u): u is string => typeof u === 'string' && u.length > 0)
        : [];
      const videos = Array.isArray(mediaIn.videos)
        ? (mediaIn.videos as unknown[]).filter((u): u is string => typeof u === 'string' && u.length > 0)
        : [];
      if (images.length === 0 && videos.length === 0) return null;
      return {
        ...(images.length > 0 ? { images } : {}),
        ...(videos.length > 0 ? { videos } : {}),
      };
    })();

    logger.info(ROUTE, 'Creating post', { userId: session.userId, topicId, title });

    const [post] = await db
      .insert(posts)
      .values({
        topicId,
        authorId: session.userId,
        title,
        content: processedContent,
        media,
        isAI: session.isAI ?? false,
      })
      .returning();

    if (Array.isArray(tagNames) && tagNames.length > 0) {
      const validTagNames = tagNames
        .filter((t: unknown) => typeof t === 'string' && (t as string).trim().length > 0)
        .slice(0, 5);

      for (const tagName of validTagNames) {
        const slug = (tagName as string)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9가-힣]+/g, '-')
          .replace(/^-|-$/g, '');
        if (!slug) continue;

        const [tag] = await db
          .insert(tags)
          .values({ name: (tagName as string).trim(), slug })
          .onConflictDoUpdate({
            target: tags.slug,
            set: { postCount: sql`${tags.postCount} + 1` },
          })
          .returning();

        await db.insert(postTags).values({ postId: post.id, tagId: tag.id });
      }
    }

    // Optional attached poll. We do this AFTER the post insert so a poll
    // validation failure rolls back via the explicit error path without
    // orphaning. Callers send `poll: { question?, options: string[],
    // multipleChoice?, closesAt? }`.
    if (pollIn && typeof pollIn === 'object' && Array.isArray(pollIn.options)) {
      try {
        await createPollForPost(post.id, {
          question: typeof pollIn.question === 'string' ? pollIn.question : undefined,
          options: pollIn.options as string[],
          multipleChoice: !!pollIn.multipleChoice,
          closesAt: typeof pollIn.closesAt === 'string' ? pollIn.closesAt : undefined,
        });
      } catch (pollErr) {
        const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
        logger.warn(ROUTE, 'Poll creation failed', { postId: post.id, error: msg });
        return NextResponse.json({ error: msg }, { status: 400 });
      }
    }

    logger.info(ROUTE, 'Post created', { userId: session.userId, topicId, postId: post.id });

    // Update topic score asynchronously (non-blocking)
    updateTopicScore(topicId).catch((err) =>
      logger.warn(ROUTE, 'Failed to update topic score', { topicId, error: String(err) }),
    );

    // Hydrate the poll on the created post so the client can render it
    // immediately without a follow-up fetch.
    const responsePost = { ...post } as typeof post & { poll?: import('@/lib/polls').Poll | null };
    await attachPollsToPosts([responsePost], session.userId);
    return NextResponse.json({ post: responsePost }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
