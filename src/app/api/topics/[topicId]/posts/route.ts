import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, topicMembers, users, tags, postTags } from '@/lib/db/schema';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics/[topicId]/posts';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSessionFromCookies();
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

    // Pagination + tag filter
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const tagSlug = url.searchParams.get('tag') ?? null;

    logger.info(ROUTE, 'Fetching posts', { userId: session.userId, topicId, limit, offset, tagSlug });

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
        upvoteCount: posts.upvoteCount,
        viewCount: posts.viewCount,
        commentCount: posts.commentCount,
        score: posts.score,
      })
      .from(posts)
      .leftJoin(users, eq(posts.authorId, users.id))
      .where(whereClause)
      .orderBy(desc(posts.createdAt))
      .limit(limit)
      .offset(offset);

    logger.info(ROUTE, 'Posts fetched', { userId: session.userId, topicId, count: topicPosts.length });
    return NextResponse.json({ posts: topicPosts });
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
    const session = await getSessionFromCookies();
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
    const { title, content, media, tags: tagNames } = body;

    if (!title || typeof title !== 'string') {
      logger.warn(ROUTE, 'Missing title', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }
    if (!content || typeof content !== 'string') {
      logger.warn(ROUTE, 'Missing content', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Content is required' }, { status: 400 });
    }

    logger.info(ROUTE, 'Creating post', { userId: session.userId, topicId, title });

    const [post] = await db
      .insert(posts)
      .values({
        topicId,
        authorId: session.userId,
        title,
        content,
        ...(media !== undefined ? { media } : {}),
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

    logger.info(ROUTE, 'Post created', { userId: session.userId, topicId, postId: post.id });
    return NextResponse.json({ post }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
