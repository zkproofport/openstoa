import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { tags, postTags, posts } from '@/lib/db/schema';
import { desc, ilike, eq, and, sql, countDistinct } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/tags';

export async function GET(request: NextRequest) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q');
    const topicId = searchParams.get('topicId');

    logger.info(ROUTE, 'Fetching tags', { userId: session.userId, q, topicId });

    let result;

    if (topicId) {
      // Topic-scoped tags: only tags used in posts of this topic
      const baseQuery = db
        .select({
          id: tags.id,
          name: tags.name,
          slug: tags.slug,
          postCount: countDistinct(postTags.postId),
          createdAt: tags.createdAt,
        })
        .from(tags)
        .innerJoin(postTags, eq(postTags.tagId, tags.id))
        .innerJoin(posts, eq(postTags.postId, posts.id));

      if (q) {
        const escaped = q.replace(/%/g, '\\%').replace(/_/g, '\\_');
        result = await baseQuery
          .where(and(eq(posts.topicId, topicId), ilike(tags.slug, `${escaped}%`)))
          .groupBy(tags.id, tags.name, tags.slug, tags.createdAt)
          .limit(10);
      } else {
        result = await baseQuery
          .where(eq(posts.topicId, topicId))
          .groupBy(tags.id, tags.name, tags.slug, tags.createdAt)
          .orderBy(sql`count(distinct ${postTags.postId}) desc`)
          .limit(20);
      }
    } else {
      // Global tags (fallback)
      if (q) {
        const escaped = q.replace(/%/g, '\\%').replace(/_/g, '\\_');
        result = await db
          .select()
          .from(tags)
          .where(ilike(tags.slug, `${escaped}%`))
          .limit(10);
      } else {
        result = await db
          .select()
          .from(tags)
          .orderBy(desc(tags.postCount))
          .limit(20);
      }
    }

    logger.info(ROUTE, 'Tags fetched', { userId: session.userId, count: result.length });
    return NextResponse.json({ tags: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
