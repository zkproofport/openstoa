import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, users } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/my/posts';

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
        media: posts.media,
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
