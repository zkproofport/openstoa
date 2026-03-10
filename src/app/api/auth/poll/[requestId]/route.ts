import { NextRequest, NextResponse } from 'next/server';
import { waitForProofResult, getServerRelayUrl } from '@/lib/relay';
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

const ROUTE = '/api/auth/poll/[requestId]';

function getRpcUrl(): string {
  const url = process.env.RPC_URL;
  if (!url) throw new Error('RPC_URL environment variable is required');
  return url;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
) {
  try {
    const { requestId } = await params;

    logger.info(ROUTE, 'Polling relay for proof result', { requestId });

    // Poll relay once (not long-poll — client retries)
    const relayUrl = getServerRelayUrl();
    const res = await fetch(
      `${relayUrl}/api/v1/proof/${requestId}`,
    );
    if (!res.ok) {
      logger.error(ROUTE, 'Relay returned non-OK response', { requestId, status: res.status });
      return NextResponse.json(
        { error: 'Failed to poll relay' },
        { status: 502 },
      );
    }

    const data = await res.json();

    logger.info(ROUTE, 'Relay response received', { requestId, status: data.status });

    if (data.status !== 'completed') {
      return NextResponse.json({ status: data.status });
    }

    // Verify proof on-chain
    const { proof, publicInputs, verifierAddress, chainId } = data;
    if (!proof || !publicInputs || !verifierAddress) {
      logger.error(ROUTE, 'Incomplete proof data from relay', { requestId, hasProof: !!proof, hasPublicInputs: !!publicInputs, hasVerifierAddress: !!verifierAddress });
      return NextResponse.json(
        { error: 'Incomplete proof data from relay' },
        { status: 502 },
      );
    }

    logger.info(ROUTE, 'Verifying proof on-chain', { requestId, verifierAddress, chainId, proofLength: proof.length, publicInputsLength: publicInputs.length });

    const verification = await verifyProofOnChain(
      proof,
      publicInputs,
      verifierAddress,
      getRpcUrl(),
    );
    if (!verification.valid) {
      logger.warn(ROUTE, 'Proof verification failed', { requestId, error: verification.error });
      return NextResponse.json(
        { error: 'Proof verification failed', details: verification.error },
        { status: 400 },
      );
    }

    logger.info(ROUTE, 'Proof verified on-chain', { requestId });

    // Verify scope
    const scope = extractScope(publicInputs, 'coinbase_attestation');
    const expectedScope = computeScopeHash(COMMUNITY_SCOPE);
    if (scope !== expectedScope) {
      logger.warn(ROUTE, 'Scope mismatch', { requestId, scope, expectedScope });
      return NextResponse.json(
        { error: 'Scope mismatch' },
        { status: 400 },
      );
    }

    // Extract nullifier as userId
    const nullifier = extractNullifier(publicInputs, 'coinbase_attestation');

    // Create or get user
    const existingUser = await db.query.users.findFirst({
      where: eq(users.id, nullifier),
    });

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
