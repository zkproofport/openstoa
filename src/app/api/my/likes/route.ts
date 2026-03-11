import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, votes, users } from '@/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/my/likes';

export async function GET(request: NextRequest) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10);

    logger.info(ROUTE, 'Fetching liked posts', { userId: session.userId, limit, offset });

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
      .where(and(eq(votes.userId, session.userId), eq(votes.value, 1)))
      .orderBy(desc(posts.createdAt))
      .limit(limit)
      .offset(offset);

    logger.info(ROUTE, 'Liked posts fetched', { userId: session.userId, count: likedPosts.length });
    return NextResponse.json({ posts: likedPosts });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
