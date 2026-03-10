import { NextRequest, NextResponse } from 'next/server';
import { verifySession, setSessionCookie } from '@/lib/session';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/token-login';

export async function GET(request: NextRequest) {
  logger.info(ROUTE, 'GET request received');

  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    logger.warn(ROUTE, 'Missing token parameter');
    return NextResponse.json({ error: 'Missing token parameter' }, { status: 400 });
  }

  const session = await verifySession(token);
  if (!session) {
    logger.warn(ROUTE, 'Invalid or expired token');
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  logger.info(ROUTE, 'Token valid, setting cookie and redirecting', { userId: session.userId });

  const needsNickname = !session.nickname || session.nickname.startsWith('anon_');
  const redirectUrl = new URL(needsNickname ? '/profile' : '/topics', request.url);
  const response = NextResponse.redirect(redirectUrl);
  setSessionCookie(response, token);
  return response;
}
