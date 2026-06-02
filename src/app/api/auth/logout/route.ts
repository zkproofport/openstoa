import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/session';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/logout';

/**
 * @openapi
 * /api/auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Logout (clears session cookie)
 *     description: |
 *       Clears the server-side session cookie. Bearer-token callers should additionally drop the
 *       token from their own storage — there is no server-side blacklist; logout is purely a
 *       client-side concern for Bearer flows. Safe to call without an active session.
 *     operationId: logout
 *     security: []
 *     x-related-skills: [auth-details]
 *     responses:
 *       200:
 *         description: Logged out successfully
 */
export async function POST() {
  logger.info(ROUTE, 'POST request received, clearing session cookie');
  const response = NextResponse.json({ success: true });
  clearSessionCookie(response);
  logger.info(ROUTE, 'Logout complete, sending 200');
  return response;
}
