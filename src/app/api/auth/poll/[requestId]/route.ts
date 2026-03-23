import { NextRequest, NextResponse } from 'next/server';
import { pollProofResult } from '@/lib/relay';
import {
  verifyProofFromRelay,
  extractNullifier,
  extractScope,
  computeScopeHash,
  detectCircuit,
  COMMUNITY_SCOPE,
} from '@/lib/proof';
import { createSession, setSessionCookie } from '@/lib/session';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/poll/[requestId]';

/**
 * @openapi
 * /api/auth/poll/{requestId}:
 *   get:
 *     tags: [Auth]
 *     summary: Poll relay for proof result
 *     description: >-
 *       Polls the relay server for ZK proof generation status. When completed, verifies the proof
 *       on-chain, creates/retrieves the user account, and issues a session. Use mode=proof to get
 *       raw proof data without creating a session (used for country-gated topic operations).
 *     operationId: pollProofResult
 *     security: []
 *     parameters:
 *       - name: requestId
 *         in: path
 *         required: true
 *         description: Relay request ID from /api/auth/proof-request
 *         schema:
 *           type: string
 *       - name: mode
 *         in: query
 *         required: false
 *         description: Set to "proof" to get raw proof data without creating a session
 *         schema:
 *           type: string
 *           enum: [proof]
 *     responses:
 *       200:
 *         description: Poll result — status may be pending, failed, or completed
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   description: Proof generation still in progress or failed
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [pending, failed]
 *                       description: Current proof generation status
 *                 - type: object
 *                   description: Proof completed — session created (default mode)
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [completed]
 *                       description: Completed status
 *                     userId:
 *                       type: string
 *                       description: Authenticated user ID
 *                     needsNickname:
 *                       type: boolean
 *                       description: Whether the user still needs to set a nickname
 *                 - type: object
 *                   description: Proof completed — raw proof data (mode=proof)
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [completed]
 *                       description: Completed status
 *                     proof:
 *                       type: string
 *                       description: 0x-prefixed proof hex string
 *                     publicInputs:
 *                       type: array
 *                       items:
 *                         type: string
 *                       description: Array of 0x-prefixed public input hex strings
 *                     circuit:
 *                       type: string
 *                       description: Circuit type that was proven
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
) {
  try {
    const { requestId } = await params;

    const url = new URL(request.url);
    const mode = url.searchParams.get('mode');

    logger.info(ROUTE, 'Polling relay for proof result', { requestId });

    const result = await pollProofResult(requestId);

    logger.info(ROUTE, 'Relay response received', { requestId, status: result.status });

    if (result.status !== 'completed') {
      return NextResponse.json({ status: result.status });
    }

    if (!result.proof || !result.publicInputs) {
      logger.error(ROUTE, 'Incomplete proof data from relay', { requestId, hasProof: !!result.proof, hasPublicInputs: !!result.publicInputs });
      return NextResponse.json(
        { error: 'Incomplete proof data from relay' },
        { status: 502 },
      );
    }

    logger.info(ROUTE, 'Verifying proof on-chain', { requestId, proofLength: result.proof.length, publicInputsLength: result.publicInputs.length });

    const verification = await verifyProofFromRelay(result);
    if (!verification.valid) {
      logger.warn(ROUTE, 'Proof verification failed', { requestId, error: verification.error });
      return NextResponse.json(
        { error: 'Proof verification failed', details: verification.error },
        { status: 400 },
      );
    }

    logger.info(ROUTE, 'Proof verified on-chain', { requestId });

    // Proof-only mode: return raw proof data without creating session
    if (mode === 'proof') {
      logger.info(ROUTE, 'Returning proof data (proof mode)', { requestId });
      return NextResponse.json({
        status: 'completed',
        proof: result.proof,
        publicInputs: result.publicInputs,
        circuit: result.circuit,
      });
    }

    // Detect circuit type from public inputs or relay result
    const circuit = detectCircuit(result.publicInputs, result.verifierAddress);
    logger.info(ROUTE, 'Circuit detected', { requestId, circuit });

    // Verify scope
    logger.info(ROUTE, 'Extracting scope', { requestId, circuit });
    const scope = extractScope(result.publicInputs, circuit);
    const expectedScope = computeScopeHash(COMMUNITY_SCOPE);
    if (scope !== expectedScope) {
      logger.warn(ROUTE, 'Scope mismatch', { requestId, scope, expectedScope, circuit });
      return NextResponse.json(
        { error: 'Scope mismatch' },
        { status: 400 },
      );
    }

    // Extract nullifier as userId
    logger.info(ROUTE, 'Extracting nullifier', { requestId, circuit });
    const nullifier = extractNullifier(result.publicInputs, circuit);
    logger.info(ROUTE, 'Nullifier extracted', { requestId, nullifier });

    // Create or get user
    logger.info(ROUTE, 'Querying DB for user', { requestId, nullifier });
    const existingUser = await db.query.users.findFirst({
      where: eq(users.id, nullifier),
    });
    logger.info(ROUTE, 'DB query complete', { requestId, found: !!existingUser });

    const needsNickname = !existingUser;

    if (!existingUser) {
      // Insert with a temporary nickname that must be changed
      const tempNickname = `anon_${nullifier.slice(2, 10)}`;
      await db.insert(users).values({
        id: nullifier,
        nickname: tempNickname,
      });
      logger.info(ROUTE, 'New user created', { requestId, nullifier, tempNickname });
    } else {
      logger.info(ROUTE, 'Existing user found', { requestId, nullifier });
    }

    const nickname = existingUser?.nickname ?? `anon_${nullifier.slice(2, 10)}`;
    const token = await createSession(nullifier, nickname);

    logger.info(ROUTE, 'Session created, sending 200', { requestId, nullifier, needsNickname });

    const response = NextResponse.json({
      status: 'completed',
      userId: nullifier,
      needsNickname,
    });

    setSessionCookie(response, token);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found') || message.includes('expired')) {
      logger.warn(ROUTE, 'Request not found or expired', { error: message });
      return NextResponse.json({ error: message }, { status: 404 });
    }
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
