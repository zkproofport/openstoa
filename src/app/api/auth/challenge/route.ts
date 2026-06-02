import { NextResponse } from 'next/server';
import { createChallenge } from '@/lib/challenge';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/challenge';

/**
 * @openapi
 * /api/auth/challenge:
 *   post:
 *     tags: [Auth]
 *     summary: Create challenge for AI agent auth
 *     description: |
 *       Step 1 of the AI-agent login. Returns a one-time `challengeId` and the `scope` string
 *       the agent must embed in its ZK proof.
 *
 *       Workflow:
 *         1. `POST /api/auth/challenge` → `{ challengeId, scope, expiresIn }`.
 *         2. Generate a login proof with `proofport-cli prove <login-circuit> --scope <scope>`
 *            (typically `oidc_domain_attestation` for Google / Microsoft workspace agents).
 *         3. `POST /api/auth/verify/ai` with `{ challengeId, result: { proof, publicInputs, verification, ... } }`.
 *         4. Use the returned `token` as the Bearer token for every other OpenStoa call.
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
export async function POST() {
  logger.info(ROUTE, 'POST request received');
  try {
    const challenge = await createChallenge();
    logger.info(ROUTE, 'Challenge created', { challengeId: challenge.challengeId });
    return NextResponse.json(challenge);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Failed to create challenge', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
