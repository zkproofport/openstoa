import { NextRequest, NextResponse } from 'next/server';
import { consumeChallenge } from '@/lib/challenge';
import {
  verifyProofOnChain,
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

const ROUTE = '/api/auth/verify';

function getRpcUrl(): string {
  const url = process.env.RPC_URL;
  if (!url) throw new Error('RPC_URL environment variable is required');
  return url;
}

export async function POST(request: NextRequest) {
  logger.info(ROUTE, 'POST request received');
  try {
    const body = await request.json();
    const { challengeId, proof, publicInputs, verifierAddress, chainId } = body;

    if (!challengeId || !proof || !publicInputs || !verifierAddress) {
      logger.warn(ROUTE, 'Missing required fields', { hasChallengeId: !!challengeId, hasProof: !!proof, hasPublicInputs: !!publicInputs, hasVerifierAddress: !!verifierAddress });
      return NextResponse.json(
        { error: 'Missing required fields: challengeId, proof, publicInputs, verifierAddress' },
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

    logger.info(ROUTE, 'Challenge consumed, verifying proof on-chain', { challengeId, verifierAddress, chainId, proofLength: proof.length, publicInputsLength: publicInputs.length });

    // Verify proof on-chain
    const verification = await verifyProofOnChain(
      proof,
      publicInputs,
      verifierAddress,
      getRpcUrl(),
    );
    if (!verification.valid) {
      logger.warn(ROUTE, 'Proof verification failed', { challengeId, error: verification.error });
      return NextResponse.json(
        { error: 'Proof verification failed', details: verification.error },
        { status: 400 },
      );
    }

    logger.info(ROUTE, 'Proof verified on-chain', { challengeId });

    // Determine circuit from publicInputs length
    const circuit = publicInputs.length > 128
      ? 'coinbase_country_attestation'
      : 'coinbase_attestation';

    logger.info(ROUTE, 'Detected circuit', { challengeId, circuit, publicInputsLength: publicInputs.length });

    // Verify scope
    const scope = extractScope(publicInputs, circuit);
    const expectedScope = computeScopeHash(COMMUNITY_SCOPE);
    if (scope !== expectedScope) {
      logger.warn(ROUTE, 'Scope mismatch', { challengeId, scope, expectedScope });
      return NextResponse.json(
        { error: 'Scope mismatch: proof was not generated for this community' },
        { status: 400 },
      );
    }

    // Extract nullifier as userId
    const nullifier = extractNullifier(publicInputs, circuit);

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
