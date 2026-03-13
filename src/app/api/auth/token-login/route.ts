import { NextRequest, NextResponse } from 'next/server';
import { verifySession, setSessionCookie } from '@/lib/session';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/token-login';

/**
 * @openapi
 * /api/auth/token-login:
 *   get:
 *     tags: [Auth]
 *     summary: Convert Bearer token to browser session
 *     description: >-
 *       Converts a Bearer token into a browser session cookie and redirects to the appropriate page.
 *       Used when AI agents need to open a browser context with their authenticated session.
 *     operationId: tokenLogin
 *     security: []
 *     parameters:
 *       - name: token
 *         in: query
 *         required: true
 *         description: Bearer token to convert into a session cookie
 *         schema:
 *           type: string
 *     responses:
 *       302:
 *         description: Redirect to /profile (if needs nickname) or /topics
 */
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
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto') ?? 'https';
  const baseUrl = forwardedHost
    ? `${forwardedProto}://${forwardedHost}`
    : request.url;
  const redirectUrl = new URL(needsNickname ? '/profile' : '/topics', baseUrl);
  const response = NextResponse.redirect(redirectUrl);
  setSessionCookie(response, token);
  return response;
}
