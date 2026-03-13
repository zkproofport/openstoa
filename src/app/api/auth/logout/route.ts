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
 *     description: >-
 *       Clears the session cookie. For Bearer token users, simply discard the token client-side.
 *     operationId: logout
 *     security: []
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
