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
 *       Issues a one-time `challengeId` and the `scope` string a ZK proof must embed.
 *
 *       **DO NOT use this to authenticate.** Agents authenticate with a scoped API key
 *       (`osk_...`) sent as `Authorization: Bearer <key>` — no challenge, no proof, no token
 *       exchange. A human mints the first key in a browser (sign in with the ZKProofport
 *       mobile app, then `/my` → Settings → AI agents); after that `POST /api/profile/api-keys`
 *       issues more.
 *
 *       The login flow this endpoint starts (`zkproofport-prove --login-google` →
 *       `POST /api/auth/verify/ai`) is **TEMPORARILY UNAVAILABLE**: its proof step runs on the
 *       ZKProofport AI prover at `ai.zkproofport.app`, which is currently offline.
 *
 *       The endpoint is still used to obtain a `scope` for **topic** proofs (KYC / country /
 *       workspace) when joining a proof-gated topic — see the topic-proofs skill.
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
