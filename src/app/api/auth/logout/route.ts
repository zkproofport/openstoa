import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookie, getSession } from '@/lib/session';
import { revokeSession } from '@/lib/sessionStore';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/logout';

/**
 * @openapi
 * /api/auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Logout (clears session cookie)
 *     description: |
 *       Ends the session on the server and clears the cookie. The token is revoked, so a Bearer
 *       caller that keeps its copy gains nothing by presenting it afterwards — the session record
 *       is gone and every route that verifies a session will answer 401. Safe to call without an
 *       active session.
 *     operationId: logout
 *     security: []
 *     x-related-skills: [auth-details]
 *     responses:
 *       200:
 *         description: Logged out successfully
 */
export async function POST(request: NextRequest) {
  logger.info(ROUTE, 'POST request received, ending session');

  /*
   * END IT, don't just forget the cookie.
   *
   * Logout used to clear a cookie and stop, which meant the token stayed
   * cryptographically valid for its full life: anyone holding a copy — a
   * proxy log, a second tab, the person who borrowed the laptop — could keep
   * using it. On a shared machine that is the whole of the protection failing
   * at exactly the moment someone thought they had used it.
   */
  const session = await getSession(request);
  if (session && typeof session.jti === 'string') {
    await revokeSession(session.jti, session.userId);
    logger.info(ROUTE, 'Session revoked', { userId: session.userId });
  }

  const response = NextResponse.json({ success: true });
  clearSessionCookie(response);
  logger.info(ROUTE, 'Logout complete, sending 200');
  return response;
}
