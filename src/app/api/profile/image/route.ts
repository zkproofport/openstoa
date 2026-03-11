import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/lib/session';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/profile/image';

export async function PUT(request: NextRequest) {
  logger.info(ROUTE, 'PUT request received');
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json();
    const { imageUrl } = body;

    if (!imageUrl || typeof imageUrl !== 'string') {
      return NextResponse.json({ error: 'imageUrl is required and must be a string' }, { status: 400 });
    }

    await db
      .update(users)
      .set({ profileImage: imageUrl })
      .where(eq(users.id, session.userId));

    logger.info(ROUTE, 'Profile image updated', { userId: session.userId });
    return NextResponse.json({ success: true, profileImage: imageUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in PUT', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  logger.info(ROUTE, 'DELETE request received');
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    await db
      .update(users)
      .set({ profileImage: null })
      .where(eq(users.id, session.userId));

    logger.info(ROUTE, 'Profile image removed', { userId: session.userId });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in DELETE', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
