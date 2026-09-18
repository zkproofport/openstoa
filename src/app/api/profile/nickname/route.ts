import {authorizeApiRequest} from '@/lib/apiAuthorization';
import { NextRequest, NextResponse } from 'next/server';
import { isReservedNickname } from '@/lib/defaultNickname';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { requireAiCapability } from '@/lib/aiPermissions';

const ROUTE = '/api/profile/nickname';

const NICKNAME_REGEX = /^[a-zA-Z0-9_]{2,20}$/;

/**
 * @openapi
 * /api/profile/nickname:
 *   put:
 *     tags: [Profile]
 *     summary: Set or update nickname
 *     description: |
 *       Sets or updates the display nickname (2–20 alphanumeric/underscore characters).
 *       New accounts already have a usable default nickname; changing it is optional.
 *       Returns only the updated nickname. The existing session remains valid and is not
 *       reissued; this endpoint does not replace the Bearer token or reset its cookie.
 *     operationId: setNickname
 *     x-related-skills: [auth-details, create-post]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nickname]
 *             properties:
 *               nickname:
 *                 type: string
 *                 pattern: "^[a-zA-Z0-9_]{2,20}$"
 *                 description: Display name (2-20 chars, alphanumeric + underscore)
 *     responses:
 *       200:
 *         description: Nickname updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nickname:
 *                   type: string
 *                   description: The updated nickname
 *       400:
 *         description: Invalid nickname format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error400'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       409:
 *         description: Nickname already taken
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error409'
 */
export async function PUT(request: NextRequest) {
  const authorizationError = await authorizeApiRequest(request, '/api/profile/nickname');
  if (authorizationError) return authorizationError;

  logger.info(ROUTE, 'PUT request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // Profile-level AI capability (design §7): an isAI caller editing profile
    // must hold the profile/edit capability. Humans unaffected.
    const editGate = await requireAiCapability(db, session, '/openstoa/profile/edit');
    if (editGate) {
      logger.warn(ROUTE, 'AI caller lacks profile/edit capability', { userId: session.userId });
      return editGate;
    }

    const body = await request.json();
    const { nickname } = body;

    if (!nickname || typeof nickname !== 'string') {
      logger.warn(ROUTE, 'Missing or invalid nickname field', { userId: session.userId });
      return NextResponse.json(
        { error: 'Nickname is required' },
        { status: 400 },
      );
    }

    if (isReservedNickname(nickname)) {
      // Held back for accounts this project runs. Compared case-insensitively,
      // because `openstoa_admin` impersonates as well as `OpenStoa_Admin`.
      return NextResponse.json(
        { error: 'That name is reserved.' },
        { status: 400 },
      );
    }
    if (!NICKNAME_REGEX.test(nickname)) {
      logger.warn(ROUTE, 'Nickname failed validation', { userId: session.userId, nickname });
      return NextResponse.json(
        { error: 'Nickname must be 2-20 characters, alphanumeric and underscore only' },
        { status: 400 },
      );
    }

    logger.info(ROUTE, 'Updating nickname', { userId: session.userId, nickname });

    try {
      await db
        .update(users)
        .set({ nickname })
        .where(eq(users.id, session.userId));
    } catch (error: unknown) {
      const pgError = error as { code?: string };
      if (pgError.code === '23505') {
        logger.warn(ROUTE, 'Nickname already taken', { userId: session.userId, nickname });
        return NextResponse.json(
          { error: 'Nickname already taken' },
          { status: 409 },
        );
      }
      throw error;
    }

    logger.info(ROUTE, 'Nickname updated, reissuing JWT', { userId: session.userId, nickname });

    // Reissue JWT with new nickname. Web clients pick the new token up via
    // Set-Cookie; mobile mini-apps use Bearer auth and ignore Set-Cookie,
    // so we also include the token in the response body so the mini-app
    // can swap its persisted token. Without this, the mini-app keeps
    // using the OLD JWT (stale nickname) and the next /api/auth/session
    // refetch rolls the UI back to the previous nickname.
    /*
     * A RENAME IS NOT A NEW SESSION.
     *
     * The new name has to go into a new token — it is a JWT claim — but the
     * session behind it is the same one. Revoking the old record here killed
     * the OLD token, and every other holder of it was signed out without being
     * told: a second tab, an in-flight request, a test suite sharing it. The
     * shape of the bug was that changing a display name logged people out.
     *
     * Re-minting under the same `jti` gives one record, both tokens valid, and
     * no accumulation — which was the only thing the revoke was for.
     */
    /*
     * NO NEW TOKEN. A rename is not a new session.
     *
     * The nickname was a JWT claim, so changing it meant re-minting — and
     * re-minting is where `deviceKind` was rewritten. The old line read
     *
     *     deviceKind: session.deviceKind ?? (session.isAI === true ? 'agent' : 'web')
     *
     * which is a safe default when READING a token that predates the claim, and
     * a verdict when WRITING one. A phone whose session predated it came back
     * from a rename as a browser session and lost chat — for a reason with no
     * connection to what the person did. Measured: `/api/topics` 200 while
     * `chat`, `chat/subscribe` and `mls/group-info` all answered 403.
     *
     * `GET /api/auth/session` now reads the nickname from the users table, so
     * the claim on the existing token is merely stale and nothing consults it.
     * The session record, the device kind and the expiry stay exactly as they
     * were — which is the truth. Nothing about the session changed.
     */
    return NextResponse.json({ nickname });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'PUT', error);
  }
}
