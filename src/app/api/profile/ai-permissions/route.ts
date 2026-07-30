import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { logger } from '@/lib/logger';

const ROUTE = '/api/profile/ai-permissions';

/**
 * RETIRED (2026-07-30, design §7 consolidation onto API keys). The old model —
 * one account-wide `cmd`/`historyGrant` grant applying to every `isAI` session
 * — has been replaced by per-key scope: `POST /api/profile/api-keys` mints a
 * key whose OWN `cmd`/`historyGrant` travel with it and are the only thing
 * `requireAiCapability` (`src/lib/aiPermissions.ts`) ever consults. Kept as a
 * 410 (not a bare 404) so an existing caller — old mobile builds, cached agent
 * docs — gets an actionable, self-explanatory error instead of "not found",
 * per the OpenStoa agent-UX rule (CLAUDE.md).
 */
function retired(method: 'GET' | 'PUT'): NextResponse {
  return NextResponse.json(
    {
      error: 'This endpoint has been retired. AI capability is now scoped to individual API keys.',
      migrateTo: {
        create: 'POST /api/profile/api-keys — issue a key with its own cmd + historyGrant',
        list: 'GET /api/profile/api-keys',
        revoke: 'DELETE /api/profile/api-keys/{keyId}',
      },
      method,
    },
    { status: 410 },
  );
}

/**
 * @openapi
 * /api/profile/ai-permissions:
 *   get:
 *     tags: [Profile]
 *     summary: 'RETIRED — use API keys instead'
 *     deprecated: true
 *     description: |
 *       **Retired.** Always returns 410. AI capability used to be a single account-wide grant
 *       applying to every `isAI` session; it is now scoped to individual API keys instead
 *       (GitHub-PAT style — the key's own `cmd`/`historyGrant` gate its requests, nothing wider).
 *       Use `POST /api/profile/api-keys` to create a scoped key, `GET /api/profile/api-keys` to
 *       list them, and `DELETE /api/profile/api-keys/{keyId}` to revoke one.
 *     operationId: getAiPermissions
 *     x-related-skills: [create-api-key, list-api-keys]
 *     responses:
 *       410:
 *         description: Retired — see `migrateTo` in the response body for the replacement endpoints.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  logger.info(ROUTE, 'Retired endpoint hit', { userId: session.userId, method: 'GET' });
  return retired('GET');
}

/**
 * @openapi
 * /api/profile/ai-permissions:
 *   put:
 *     tags: [Profile]
 *     summary: 'RETIRED — use API keys instead'
 *     deprecated: true
 *     description: |
 *       **Retired.** Always returns 410 — writes are rejected outright rather than silently
 *       accepted, because an account-wide grant no longer has any effect (see GET for the
 *       replacement). Accepting writes to an inert setting would be misleading: a caller could
 *       believe they narrowed their AI's access when nothing enforces it any more.
 *     operationId: setAiPermissions
 *     x-related-skills: [create-api-key, list-api-keys]
 *     responses:
 *       410:
 *         description: Retired — see `migrateTo` in the response body for the replacement endpoints.
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  logger.info(ROUTE, 'Retired endpoint hit', { userId: session.userId, method: 'PUT' });
  return retired('PUT');
}
