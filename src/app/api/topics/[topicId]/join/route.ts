import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import {
  verifyProofFromRelay,
  extractScope,
  extractIsIncluded,
  computeScopeHash,
  COMMUNITY_SCOPE,
} from '@/lib/proof';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics/[topicId]/join';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { topicId } = await params;

    logger.info(ROUTE, 'Join attempt', { userId: session.userId, topicId });

    const topic = await db.query.topics.findFirst({
      where: eq(topics.id, topicId),
    });

    if (!topic) {
      logger.warn(ROUTE, 'Topic not found', { topicId });
      return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
    }

    // Check if already a member
    const existingMembership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, session.userId),
      ),
    });

    if (existingMembership) {
      logger.warn(ROUTE, 'User is already a member', { userId: session.userId, topicId });
      return NextResponse.json(
        { error: 'Already a member of this topic' },
        { status: 409 },
      );
    }

    // If topic requires country proof, verify it
    if (topic.requiresCountryProof) {
      logger.info(ROUTE, 'Topic requires country proof, verifying', { userId: session.userId, topicId });

      const body = await request.json();
      const { proof, publicInputs } = body;

      if (!proof || !publicInputs) {
        logger.warn(ROUTE, 'Missing country proof fields', { userId: session.userId, topicId, hasProof: !!proof, hasPublicInputs: !!publicInputs });
        return NextResponse.json(
          { error: 'Country proof required: proof, publicInputs' },
          { status: 400 },
        );
      }

      logger.info(ROUTE, 'Verifying country proof on-chain', { userId: session.userId, topicId, proofLength: proof.length });

      const verification = await verifyProofFromRelay({
        status: 'completed',
        proof,
        publicInputs,
        circuit: 'coinbase_country_attestation',
        requestId: topicId,
      });

      if (!verification.valid) {
        logger.warn(ROUTE, 'Country proof verification failed', { userId: session.userId, topicId, error: verification.error });
        return NextResponse.json(
          { error: 'Country proof verification failed', details: verification.error },
          { status: 400 },
        );
      }

      logger.info(ROUTE, 'Country proof verified on-chain', { userId: session.userId, topicId });

      // Verify scope matches community scope
      const scope = extractScope(publicInputs, 'coinbase_country_attestation');
      const expectedScope = computeScopeHash(COMMUNITY_SCOPE);
      if (scope !== expectedScope) {
        logger.warn(ROUTE, 'Country proof scope mismatch', { userId: session.userId, topicId, scope, expectedScope });
        return NextResponse.json(
          { error: 'Country proof scope mismatch' },
          { status: 400 },
        );
      }

      // Verify is_included flag: the prover built the country_list from
      // topic.allowedCountries, so is_included=1 means the user's country
      // is in that list.
      const isIncluded = extractIsIncluded(publicInputs, 'coinbase_country_attestation');
      if (!isIncluded) {
        logger.warn(ROUTE, 'Country not in allowed list', { userId: session.userId, topicId });
        return NextResponse.json(
          { error: 'Country not allowed for this topic' },
          { status: 403 },
        );
      }
    }

    await db.insert(topicMembers).values({
      topicId,
      userId: session.userId,
    });

    logger.info(ROUTE, 'User joined topic successfully', { userId: session.userId, topicId });
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
