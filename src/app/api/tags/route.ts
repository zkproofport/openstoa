import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/lib/session';
import { db } from '@/lib/db';
import { tags } from '@/lib/db/schema';
import { desc, ilike } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/tags';

export async function GET(request: NextRequest) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q');

    logger.info(ROUTE, 'Fetching tags', { userId: session.userId, q });

    let result;

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

    logger.info(ROUTE, 'Tags fetched', { userId: session.userId, count: result.length });
    return NextResponse.json({ tags: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
