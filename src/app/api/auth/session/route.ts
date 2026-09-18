import {authorizeApiRequest} from '@/lib/apiAuthorization';
import { withPublicIdentityBadges } from '@/lib/identity-badges';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/session';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';

const ROUTE = '/api/auth/session';

/**
 * @openapi
 * /api/auth/session:
 *   get:
 *     tags: [Auth]
 *     summary: Get current session info
 *     description: |
 *       Returns the current caller's session info — `userId`, `nickname`, and the
 *       enabled public verification badges, not hidden verification predicates. Works with both cookie and Bearer token auth and
 *       NEVER returns 401: unauthenticated callers get `{ authenticated: false }`. Useful
 *       right after `POST /api/auth/verify/ai` to confirm the token resolves and to check
 *       the current nickname. A default nickname is ready to use; changing it is optional.
 *       Returns `profileImage` and all enabled public verification `badges` (empty on badge lookup failure).
 *     operationId: getSession
 *     x-related-skills: [auth-details]
 *     responses:
 *       200:
 *         description: Current session information (or authenticated=false for guests)
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - $ref: '#/components/schemas/Session'
 *                 - type: object
 *                   properties:
 *                     authenticated:
 *                       type: boolean
 *                       example: false
 */
export async function GET(request: NextRequest) {
  const authorizationError = await authorizeApiRequest(request, '/api/auth/session');
  if (authorizationError) return authorizationError;

  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.info(ROUTE, 'No active session found, returning authenticated=false');
      return NextResponse.json({ authenticated: false });
    }

    /*
     * The NICKNAME COMES FROM THE TABLE, not from the token.
     *
     * It used to be read off the JWT claim, which meant a rename had to mint a
     * new token to be visible — and re-minting is where `deviceKind` got
     * rewritten. A phone that changed its display name came back as a browser
     * session and lost chat, for a reason with no connection to what the person
     * did. The claim is a snapshot from sign-in; the table is the answer.
     *
     * This row was already being fetched for `totalRecorded` and `role`, so the
     * nickname rides along on a query that was happening anyway.
     */
    const user = await db.select({ nickname: users.nickname, profileImage: users.profileImage, totalRecorded: users.totalRecorded, role: users.role }).from(users).where(eq(users.id, session.userId)).limit(1);
    const totalRecorded = user[0]?.totalRecorded ?? 0;
    const role = user[0]?.role ?? 'user';
    // Falls back to the claim only when the row is gone, which is a deleted
    // account mid-request — rare, and the claim is the last thing known to be true.
    const nickname = user[0]?.nickname ?? session.nickname;

    const [identity] = await withPublicIdentityBadges([{ userId: session.userId }], row => row.userId);

    logger.info(ROUTE, 'Session valid', { userId: session.userId, nickname, totalRecorded, role, isAI: session.isAI });
    return NextResponse.json({
      userId: session.userId,
      nickname,
      profileImage: user[0]?.profileImage ?? null,
      badges: identity.badges,
      verifiedAt: session.verifiedAt,
      totalRecorded,
      ...(role === 'admin' ? { role } : {}),
      ...(session.isAI ? { isAI: true } : {}),
    });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}
