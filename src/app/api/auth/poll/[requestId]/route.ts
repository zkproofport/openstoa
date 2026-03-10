import { NextRequest, NextResponse } from 'next/server';
import { pollProofResult } from '@/lib/relay';
import {
  verifyProofFromRelay,
  extractNullifier,
  extractScope,
  computeScopeHash,
  COMMUNITY_SCOPE,
} from '@/lib/proof';
import { createSession, setSessionCookie } from '@/lib/session';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/poll/[requestId]';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
) {
  try {
    const { requestId } = await params;

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

    // Verify scope
    logger.info(ROUTE, 'Extracting scope', { requestId });
    const scope = extractScope(result.publicInputs, 'coinbase_attestation');
    const expectedScope = computeScopeHash(COMMUNITY_SCOPE);
    if (scope !== expectedScope) {
      logger.warn(ROUTE, 'Scope mismatch', { requestId, scope, expectedScope });
      return NextResponse.json(
        { error: 'Scope mismatch' },
        { status: 400 },
      );
    }

    // Extract nullifier as userId
    logger.info(ROUTE, 'Extracting nullifier', { requestId });
    const nullifier = extractNullifier(result.publicInputs, 'coinbase_attestation');
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
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
