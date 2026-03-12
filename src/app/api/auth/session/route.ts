import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/session';

export async function GET(request: NextRequest) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.info(ROUTE, 'No active session found, returning 401');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    logger.info(ROUTE, 'Session valid', { userId: session.userId, nickname: session.nickname });
    return NextResponse.json({
      userId: session.userId,
      nickname: session.nickname,
      verifiedAt: session.verifiedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
