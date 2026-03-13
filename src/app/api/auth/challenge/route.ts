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
 *     description: >-
 *       Creates a one-time challenge for AI agent authentication. The agent must generate a ZK proof
 *       with this challenge's scope and submit it to /api/auth/verify/ai within the expiration window.
 *       Challenge is single-use and expires in 5 minutes.
 *     operationId: createChallenge
 *     security: []
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
