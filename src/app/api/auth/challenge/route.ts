import {authorizeApiRequest} from '@/lib/apiAuthorization';
import { getSession } from '@/lib/session';
import { topicProofScope } from '@/lib/topic-proof';
import { NextRequest, NextResponse } from 'next/server';
import { createChallenge } from '@/lib/challenge';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';

const ROUTE = '/api/auth/challenge';

/**
 * @openapi
 * /api/auth/challenge:
 *   post:
 *     tags: [Auth]
 *     summary: Create challenge for AI agent auth
 *     description: |
 *       Issues a one-time `challengeId` and the `scope` string a ZK proof must embed.
 *
 *       Login and topic proofs use different scopes. CLI/MCP proof login obtains
 *       a challenge, generates a Google login proof, then submits it to /api/auth/verify/ai.
 *       Authenticated topic-proof requests receive the account-bound topic scope.
 *       See /docs?topic=login#login and the corresponding proof subject.
 *
 *       Challenges are single-use and expire after ~5 minutes (`expiresIn`).
 *     operationId: createChallenge
 *     security: []
 *     x-related-skills: [auth-details, cli-auth-flow, topic-proofs]
 *     responses:
 *       200:
 *         description: Challenge created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 challengeId:
 *                   type: string
 *                   description: Unique challenge identifier
 *                 scope:
 *                   type: string
 *                   description: Scope string that must be included in the ZK proof
 *                 expiresIn:
 *                   type: number
 *                   description: Seconds until the challenge expires
 */
export async function POST(request: NextRequest) {
  const authorizationError = await authorizeApiRequest(request, '/api/auth/challenge');
  if (authorizationError) return authorizationError;

  logger.info(ROUTE, 'POST request received');
  try {
    let input: unknown = {};
    const text = await request.text();
    if (text) { try { input = JSON.parse(text); } catch { return NextResponse.json({error:'Invalid JSON'}, {status:400}); } }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return NextResponse.json({error:'Invalid challenge request'}, {status:400});
    const purpose = (input as {purpose?:unknown}).purpose;
    if (purpose !== undefined && purpose !== 'login' && purpose !== 'topic') return NextResponse.json({error:'purpose must be login or topic'}, {status:400});
    const challenge = await createChallenge();
    const session = await getSession(request);
    if (session && purpose !== 'login') challenge.scope = topicProofScope(session.userId);
    logger.info(ROUTE, 'Challenge created', { challengeId: challenge.challengeId });
    return NextResponse.json(challenge);
  } catch (error) {
    return unhandledRouteError(ROUTE, 'Failed to create challenge', error);
  }
}
