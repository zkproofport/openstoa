import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, topicMembers, users, tags, postTags, votes, topics } from '@/lib/db/schema';
import { eq, and, desc, sql, inArray, ilike, or } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { isValidUUID } from '@/lib/uuid';
import { normaliseSearchQuery } from '@/lib/search';
import { updateTopicScore } from '@/lib/topicScore';
import { extractAndUploadBase64Images } from '@/lib/base64-upload';
import { requireAiCapability } from '@/lib/aiPermissions';

import { getBatchUserBadges, filterBadgesByTopicProofType, type Badge } from '@/lib/verification-cache';
import { attachReactionsToPosts } from '@/lib/reactions';
import { attachUserFlagsToPosts } from '@/lib/userPostFlags';
import { attachPollsToPosts, createPollForPost } from '@/lib/polls';
import { isSupportedVideoUrl } from '@/lib/videoUrls';
import { hasNulByte } from '@/lib/textGuard';

const ROUTE = '/api/topics/[topicId]/posts';

const VALID_POST_SORTS = ['hot', 'new', 'top', 'active', 'recorded'] as const;
type PostSort = typeof VALID_POST_SORTS[number];

function buildPostSortExpr(sort: PostSort) {
  return sort === 'new' ? desc(posts.createdAt)
    : sort === 'top' ? desc(posts.upvoteCount)
    : sort === 'active' ? desc(posts.lastActivityAt)
    : sort === 'recorded' ? desc(posts.recordCount)
    : desc(posts.score); // 'hot' default
}

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
 *       `public` topics are readable by anyone, signed in or not. `private` topics are readable
 *       by any SIGNED-IN user, member or not — the members-only part of a private topic is its
 *       chat, not its posts. `secret` topics require membership. Writing always requires
 *       membership, in every tier.
 *       Pinned posts always appear first regardless of sort order.
 *       Supports tag filtering and sorting by newest or popularity.
 *     operationId: listPosts
 *     x-related-skills: [create-post, get-post, list-topics]
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
 *           enum: [hot, new, top, active, recorded]
 *           default: hot
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
 *       Creates a new post in a topic. The caller must already be a member of the topic and have
 *       a non-anonymous nickname set (`PUT /api/profile/nickname`).
 *
 *       `content` is HTML. To attach images, upload each file first via `POST /api/upload`
 *       (returns `{ publicUrl }`) and embed it as `<img src="$publicUrl">` in `content`. Inline
 *       `data:image/...;base64,...` is accepted as a fallback — the server extracts and uploads
 *       any base64 images on receive — but URL-embed is the recommended path the mobile and web
 *       clients use.
 *
 *       `tags` is an array of plain strings (max 5). Unknown tag names are auto-created. The
 *       post body triggers an async topic score recalculation; it is not synchronous.
 *     operationId: createPost
 *     x-related-skills: [upload-image, set-nickname]
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
 *                 description: >-
 *                   Post body as HTML. Images should be embedded as
 *                   `<img src="$publicUrl">` after uploading the file via
 *                   `POST /api/upload` (returns `{ publicUrl }`). The
 *                   mobile + web clients use this URL-embed flow.
 *                   Inline `data:image/...;base64,...` is also accepted —
 *                   the server extracts and uploads any base64 images to
 *                   CDN, then rewrites the src — but it is a fallback,
 *                   not the recommended path.
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
    if (!isValidUUID(topicId)) {
      return NextResponse.json({ error: 'Invalid topicId' }, { status: 400 });
    }

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
      const sortParam = url.searchParams.get('sort') ?? 'hot';
      const qPattern = normaliseSearchQuery(url.searchParams.get('q'));
      if (!VALID_POST_SORTS.includes(sortParam as PostSort)) {
        logger.warn(ROUTE, 'Invalid sort value (guest)', { sort: sortParam });
        return NextResponse.json(
          { error: `Invalid sort. Must be one of: ${VALID_POST_SORTS.join(', ')}` },
          { status: 400 },
        );
      }
      const sort: PostSort = sortParam as PostSort;

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

      // Resolve post-tag matches for keyword search (same pattern as feed/route.ts)
      let qTagPostIds: Set<string> | null = null;
      if (qPattern) {
        const rows = await db
          .select({ postId: postTags.postId })
          .from(postTags)
          .innerJoin(tags, eq(postTags.tagId, tags.id))
          .where(or(ilike(tags.name, qPattern), ilike(tags.slug, qPattern))!);
        qTagPostIds = new Set(rows.map((r) => r.postId));
      }

      const whereClause = buildWhereClause(topicId, tagFilteredPostIds, qPattern, qTagPostIds);

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
        // Pin priority applies ONLY to sort=new. Other sorts respect their
        // own ordering (score / votes / activity / record count).
        .orderBy(...(sort === 'new' ? [desc(posts.isPinned), buildPostSortExpr(sort)] : [buildPostSortExpr(sort)]))
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
      /*
       * Public AND private topics are readable by any signed-in user; writing
       * still requires membership (the POST handler below re-checks). This is
       * the line that makes `private` mean "the CONVERSATION is members-only",
       * not "the topic is hidden": posts stay open, chat does not — the chat
       * route answers 403 to a non-member in every tier, and that distinction
       * is what the whole tier design rests on.
       *
       * `secret` stays members-only here, and guests are handled above: signing
       * in is the price of reading a private topic's posts.
       */
      const topicCheck = await db.query.topics.findFirst({
        where: eq(topics.id, topicId),
        columns: { visibility: true },
      });
      const readableToSignedIn =
        topicCheck?.visibility === 'public' || topicCheck?.visibility === 'private';
      if (!topicCheck || !readableToSignedIn) {
        logger.warn(ROUTE, 'User is not a member of this topic', { userId: session.userId, topicId });
        return NextResponse.json(
          { error: 'Not a member of this topic' },
          { status: 403 },
        );
      }
    }

    // Pagination + tag filter + keyword search
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const tagSlug = url.searchParams.get('tag') ?? null;
    const sortParam = url.searchParams.get('sort') ?? 'hot';
    const qPattern = normaliseSearchQuery(url.searchParams.get('q'));
    if (!VALID_POST_SORTS.includes(sortParam as PostSort)) {
      logger.warn(ROUTE, 'Invalid sort value', { userId: session.userId, sort: sortParam });
      return NextResponse.json(
        { error: `Invalid sort. Must be one of: ${VALID_POST_SORTS.join(', ')}` },
        { status: 400 },
      );
    }
    const sort: PostSort = sortParam as PostSort;

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

    const whereClause = buildWhereClause(topicId, tagFilteredPostIds, qPattern, qTagPostIds);

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
      // Pin priority applies ONLY to sort=new. Other sorts (hot/top/active/
      // recorded) ignore isPinned so the underlying ranking isn't disturbed.
      .orderBy(...(sort === 'new' ? [desc(posts.isPinned), buildPostSortExpr(sort)] : [buildPostSortExpr(sort)]))
      .limit(limit)
      .offset(offset);

    // Get topic proofType for badge filtering
    const topicForBadge = await db.query.topics.findFirst({
      where: eq(topics.id, topicId),
      columns: { proofType: true },
    });

    const authorIds = [...new Set(topicPosts.map((p) => p.authorId).filter(Boolean))] as string[];
    const badgeMap = await getBatchUserBadges(authorIds);
    // Membership is uniform across a single topic, so the badge applies
    // to every row in the response when the viewer is a member. W03 surfaces
    // the same green pill in topic feeds that PostDetail already shows.
    const isJoinedTopic = !!membership;
    const postsWithBadges = topicPosts.map((p) => ({
      ...p,
      badges: filterBadgesByTopicProofType(badgeMap.get(p.authorId) ?? [], topicForBadge?.proofType ?? null),
      isJoinedTopic,
    }));

    const postsWithFlags = await attachUserFlagsToPosts(postsWithBadges, session.userId);
    const postsWithReactions = await attachReactionsToPosts(postsWithFlags, session.userId);
    await attachPollsToPosts(postsWithReactions, session.userId);
    await attachTagsToPosts(postsWithReactions);

    logger.info(ROUTE, 'Posts fetched', { userId: session.userId, topicId, count: topicPosts.length });
    return NextResponse.json({ posts: postsWithReactions });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}

/**
 * Build the WHERE clause for topic post queries combining topic scope,
 * optional tag filter, and optional keyword search (title / content / tags).
 */
function buildWhereClause(
  topicId: string,
  tagFilteredPostIds: string[] | null,
  qPattern: string | null,
  qTagPostIds: Set<string> | null,
) {
  // Base: posts in this topic
  const base = eq(posts.topicId, topicId);

  // Tag filter: when tag slug provided but resolves to nothing, return nothing
  if (tagFilteredPostIds !== null) {
    if (tagFilteredPostIds.length === 0) return and(base, sql`false`);
    const tagClause = and(base, inArray(posts.id, tagFilteredPostIds));
    if (!qPattern) return tagClause;
    // Combine tag filter AND keyword search
    const tagIdsArray = qTagPostIds ? [...qTagPostIds] : [];
    const tagMatchClause = tagIdsArray.length > 0 ? inArray(posts.id, tagIdsArray) : null;
    const titleContent = or(ilike(posts.title, qPattern), ilike(posts.content, qPattern));
    const qClause = tagMatchClause ? or(titleContent, tagMatchClause)! : titleContent!;
    return and(base, inArray(posts.id, tagFilteredPostIds), qClause);
  }

  // No tag filter — just keyword search if present
  if (qPattern) {
    const tagIdsArray = qTagPostIds ? [...qTagPostIds] : [];
    const tagMatchClause = tagIdsArray.length > 0 ? inArray(posts.id, tagIdsArray) : null;
    const titleContent = or(ilike(posts.title, qPattern), ilike(posts.content, qPattern));
    const qClause = tagMatchClause ? or(titleContent, tagMatchClause)! : titleContent!;
    return and(base, qClause);
  }

  return base;
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
    if (!isValidUUID(topicId)) {
      return NextResponse.json({ error: 'Invalid topicId' }, { status: 400 });
    }

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

    // Profile-level AI capability (design §7): an isAI author must hold the
    // post/write capability in its owner's profile. Humans unaffected.
    const writeGate = await requireAiCapability(db, session, '/openstoa/post/write');
    if (writeGate) {
      logger.warn(ROUTE, 'AI caller lacks post/write capability', { userId: session.userId, topicId });
      return writeGate;
    }

    const body = await request.json();
    const { title, content, tags: tagNames, media: mediaIn, poll: pollIn } = body;

    if (!title || typeof title !== 'string') {
      logger.warn(ROUTE, 'Missing title', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }
    if (title.length > 200) {
      return NextResponse.json({ error: 'Title must be 200 characters or less' }, { status: 400 });
    }
    // Postgres text storage cannot hold a NUL byte (see src/lib/textGuard.ts)
    // — reject before it ever reaches the insert, same rule as apiKeys.name.
    if (hasNulByte(title)) {
      return NextResponse.json({ error: 'Title must not contain a NUL byte' }, { status: 400 });
    }
    if (!content || typeof content !== 'string') {
      logger.warn(ROUTE, 'Missing content', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Content is required' }, { status: 400 });
    }
    // 50,000 chars (~200KB UTF-8 worst case). Big enough for long-form
    // posts; small enough that ilike search stays cheap and a single
    // payload can't degrade the topic detail render.
    const MAX_CONTENT_LENGTH = 50_000;
    if (content.length > MAX_CONTENT_LENGTH) {
      return NextResponse.json(
        { error: `Content must be ${MAX_CONTENT_LENGTH} characters or less` },
        { status: 400 },
      );
    }
    if (hasNulByte(content)) {
      return NextResponse.json({ error: 'Content must not contain a NUL byte' }, { status: 400 });
    }

    // Extract base64 images from content and upload to R2
    const processedContent = await extractAndUploadBase64Images(content, session.userId, topicId);

    // Server-side caps mirror the mobile composer so an AI / CLI / direct
    // API client can't bypass them. Returning 400 with a specific error
    // message means E2E tests and AI agents can recover gracefully.
    const MAX_IMAGES = 10;
    const MAX_VIDEOS = 3;
    const MAX_TAGS = 5;

    // Normalise media payload: accept { images?: string[], videos?: string[] }
    // and discard anything else. Null when neither array has any entries so the
    // column stays NULL (cheaper to query, signals "no attachments" cleanly).
    let mediaParseError: string | null = null;
    const media = (() => {
      if (!mediaIn || typeof mediaIn !== 'object') return null;
      const images = Array.isArray(mediaIn.images)
        ? (mediaIn.images as unknown[]).filter((u): u is string => typeof u === 'string' && u.length > 0)
        : [];
      const videos = Array.isArray(mediaIn.videos)
        ? (mediaIn.videos as unknown[]).filter((u): u is string => typeof u === 'string' && u.length > 0)
        : [];
      if (images.length > MAX_IMAGES) {
        mediaParseError = `Too many images (max ${MAX_IMAGES})`;
        return null;
      }
      if (videos.length > MAX_VIDEOS) {
        mediaParseError = `Too many videos (max ${MAX_VIDEOS})`;
        return null;
      }
      // Image URLs must look like http(s) — guards against
      // `javascript:` / `data:` / arbitrary strings making it past the
      // composer into the DB. Mobile uploads always come back as R2
      // https URLs so this never trips for legit flows.
      const badImage = images.find((u) => !/^https?:\/\//i.test(u));
      if (badImage) {
        mediaParseError = `Invalid image URL: ${badImage}`;
        return null;
      }
      // Videos must be YouTube/Vimeo — same regex as the mobile modal.
      const badVideo = videos.find((u) => !isSupportedVideoUrl(u));
      if (badVideo) {
        mediaParseError = `Unsupported video URL (YouTube or Vimeo only): ${badVideo}`;
        return null;
      }
      if (images.length === 0 && videos.length === 0) return null;
      return {
        ...(images.length > 0 ? { images } : {}),
        ...(videos.length > 0 ? { videos } : {}),
      };
    })();
    if (mediaParseError) {
      return NextResponse.json({ error: mediaParseError }, { status: 400 });
    }
    if (Array.isArray(tagNames) && tagNames.length > MAX_TAGS) {
      return NextResponse.json(
        { error: `Too many tags (max ${MAX_TAGS})` },
        { status: 400 },
      );
    }

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
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}
