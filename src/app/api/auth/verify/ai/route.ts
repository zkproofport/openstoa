import { NextRequest, NextResponse } from 'next/server';
import { consumeChallenge } from '@/lib/challenge';
import {
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
import { verifyProof } from '@zkproofport-ai/sdk';

const ROUTE = '/api/auth/verify/ai';

export async function POST(request: NextRequest) {
  logger.info(ROUTE, 'POST request received');
  try {
    const body = await request.json();
    const { challengeId, result } = body;

    if (!challengeId || !result) {
      logger.warn(ROUTE, 'Missing required fields', { hasChallengeId: !!challengeId, hasResult: !!result });
      return NextResponse.json(
        { error: 'Missing required fields: challengeId, result' },
        { status: 400 },
      );
    }

    if (!result.proof || !result.publicInputs || !result.verification) {
      logger.warn(ROUTE, 'Incomplete result', {
        hasProof: !!result.proof,
        hasPublicInputs: !!result.publicInputs,
        hasVerification: !!result.verification,
      });
      return NextResponse.json(
        { error: 'Incomplete result: proof, publicInputs, and verification are required' },
        { status: 400 },
      );
    }

    logger.info(ROUTE, 'Consuming challenge', { challengeId });

    const challengeValid = await consumeChallenge(challengeId);
    if (!challengeValid) {
      logger.warn(ROUTE, 'Invalid or expired challenge', { challengeId });
      return NextResponse.json(
        { error: 'Invalid or expired challenge' },
        { status: 401 },
      );
    }

    logger.info(ROUTE, 'Challenge consumed, verifying proof on-chain via AI SDK', { challengeId });

    // Verify proof on-chain using @zkproofport-ai/sdk
    const verification = await verifyProof(result);
    if (!verification.valid) {
      logger.warn(ROUTE, 'Proof verification failed', { challengeId, error: verification.error });
      return NextResponse.json(
        { error: 'Proof verification failed', details: verification.error },
        { status: 400 },
      );
    }

    logger.info(ROUTE, 'Proof verified on-chain', { challengeId });

    // Normalize publicInputs for scope/nullifier extraction
    const normalizedInputs = normalizePublicInputs(result.publicInputs);

    // Determine circuit from normalized array length
    const circuit = normalizedInputs.length > 10
      ? 'coinbase_country_attestation'
      : 'coinbase_attestation';

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
