import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, users, votes, topicMembers, topics } from '@/lib/db/schema';
import { eq, and, desc, gt, sql, inArray } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/recorded';

export async function GET(request: NextRequest) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

    // Get all topics where user is a member
    const memberships = await db
      .select({ topicId: topicMembers.topicId })
      .from(topicMembers)
      .where(eq(topicMembers.userId, session.userId));

    const memberTopicIds = memberships.map((m) => m.topicId);

    if (memberTopicIds.length === 0) {
      return NextResponse.json({ posts: [] });
    }

    const recordedPosts = await db
      .select({
        id: posts.id,
        topicId: posts.topicId,
        authorId: posts.authorId,
        title: posts.title,
        content: posts.content,
        createdAt: posts.createdAt,
        authorNickname: users.nickname,
        authorProfileImage: users.profileImage,
        upvoteCount: posts.upvoteCount,
        viewCount: posts.viewCount,
        commentCount: posts.commentCount,
        recordCount: posts.recordCount,
        isPinned: posts.isPinned,
        userVoted: sql<number | null>`${votes.value}`,
        topicTitle: topics.title,
      })
      .from(posts)
      .leftJoin(users, eq(posts.authorId, users.id))
      .leftJoin(votes, and(eq(votes.postId, posts.id), eq(votes.userId, session.userId)))
      .leftJoin(topics, eq(posts.topicId, topics.id))
      .where(
        and(
          gt(posts.recordCount, 0),
          inArray(posts.topicId, memberTopicIds),
        )
      )
      .orderBy(desc(posts.recordCount), desc(posts.createdAt))
      .limit(limit)
      .offset(offset);

    return NextResponse.json({ posts: recordedPosts });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
