import { NextRequest, NextResponse } from 'next/server';
import { consumeChallenge } from '@/lib/challenge';
import {
  verifyProofFromRelay,
  extractNullifier,
  extractScope,
  computeScopeHash,
  normalizePublicInputs,
  COMMUNITY_SCOPE,
} from '@/lib/proof';
import { createSession, setSessionCookie } from '@/lib/session';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/verify';

export async function POST(request: NextRequest) {
  logger.info(ROUTE, 'POST request received');
  try {
    const body = await request.json();
    const { challengeId, proof, publicInputs } = body;

    if (!challengeId || !proof || !publicInputs) {
      logger.warn(ROUTE, 'Missing required fields', { hasChallengeId: !!challengeId, hasProof: !!proof, hasPublicInputs: !!publicInputs });
      return NextResponse.json(
        { error: 'Missing required fields: challengeId, proof, publicInputs' },
        { status: 400 },
      );
    }

    logger.info(ROUTE, 'Consuming challenge', { challengeId });

    // Consume challenge
    const challengeValid = await consumeChallenge(challengeId);
    if (!challengeValid) {
      logger.warn(ROUTE, 'Invalid or expired challenge', { challengeId });
      return NextResponse.json(
        { error: 'Invalid or expired challenge' },
        { status: 401 },
      );
    }

    // Normalize publicInputs: SDK may return a single hex string; downstream functions expect string[]
    const normalizedInputs = normalizePublicInputs(publicInputs);

    logger.info(ROUTE, 'Challenge consumed, verifying proof on-chain', { challengeId, proofLength: proof.length, publicInputsCount: normalizedInputs.length });

    // Determine circuit from normalized array length
    const circuit = normalizedInputs.length > 10
      ? 'coinbase_country_attestation'
      : 'coinbase_attestation';

    // Base mainnet verifier addresses (server-side only, not exposed to clients)
    const VERIFIERS: Record<string, string> = {
      coinbase_attestation: '0xF7dED73E7a7fc8fb030c35c5A88D40ABe6865382',
      coinbase_country_attestation: '0xF3D5A09d2C85B28C52EF2905c1BE3a852b609D0C',
    };

    // Verify proof on-chain
    const verification = await verifyProofFromRelay({
      status: 'completed',
      proof,
      publicInputs: normalizedInputs,
      circuit,
      requestId: challengeId,
      verifierAddress: VERIFIERS[circuit],
      chainId: 8453,
    } as any);
    if (!verification.valid) {
      logger.warn(ROUTE, 'Proof verification failed', { challengeId, error: verification.error });
      return NextResponse.json(
        { error: 'Proof verification failed', details: verification.error },
        { status: 400 },
      );
    }

    logger.info(ROUTE, 'Proof verified on-chain', { challengeId, circuit });

    // Verify scope
    const scope = extractScope(normalizedInputs, circuit);
    const expectedScope = computeScopeHash(COMMUNITY_SCOPE);
    if (scope !== expectedScope) {
      logger.warn(ROUTE, 'Scope mismatch', { challengeId, scope, expectedScope });
      return NextResponse.json(
        { error: 'Scope mismatch: proof was not generated for this community' },
        { status: 400 },
      );
    }

    // Extract nullifier as userId
    const nullifier = extractNullifier(normalizedInputs, circuit);

    // Create or get user
    const existingUser = await db.query.users.findFirst({
      where: eq(users.id, nullifier),
    });

    const needsNickname = !existingUser;

    if (!existingUser) {
      const tempNickname = `anon_${nullifier.slice(2, 10)}`;
      await db.insert(users).values({
        id: nullifier,
        nickname: tempNickname,
      });
      logger.info(ROUTE, 'New user created', { challengeId, nullifier, tempNickname });
    } else {
      logger.info(ROUTE, 'Existing user found', { challengeId, nullifier });
    }

    const nickname = existingUser?.nickname ?? `anon_${nullifier.slice(2, 10)}`;
    const token = await createSession(nullifier, nickname);

    logger.info(ROUTE, 'Session created, sending 200', { challengeId, nullifier, needsNickname });

    const response = NextResponse.json({
      userId: nullifier,
      needsNickname,
      token,
    });

    setSessionCookie(response, token);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
