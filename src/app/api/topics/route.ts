import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers } from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { logger } from '@/lib/logger';
import {
  verifyProofFromRelay,
  extractScope,
  extractIsIncluded,
  computeScopeHash,
  COMMUNITY_SCOPE,
} from '@/lib/proof';

const ROUTE = '/api/topics';

export async function GET(request: NextRequest) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const view = searchParams.get('view');

    if (view === 'all') {
      logger.info(ROUTE, 'Fetching all topics with member counts', { userId: session.userId });

      const allTopics = await db.query.topics.findMany({
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });

      const memberCounts = await db
        .select({ topicId: topicMembers.topicId, count: sql<number>`count(*)::int` })
        .from(topicMembers)
        .groupBy(topicMembers.topicId);

      const userMemberships = await db.query.topicMembers.findMany({
        where: eq(topicMembers.userId, session.userId),
      });

      const memberCountMap = Object.fromEntries(memberCounts.map((m) => [m.topicId, m.count]));
      const userTopicIds = new Set(userMemberships.map((m) => m.topicId));

      const result = allTopics.map((t) => ({
        ...t,
        memberCount: memberCountMap[t.id] ?? 0,
        isMember: userTopicIds.has(t.id),
      }));

      logger.info(ROUTE, 'All topics fetched', { userId: session.userId, count: result.length });
      return NextResponse.json({ topics: result });
    }

    // Default: only user's topics
    const memberships = await db.query.topicMembers.findMany({
      where: eq(topicMembers.userId, session.userId),
    });

    if (memberships.length === 0) {
      logger.info(ROUTE, 'User has no topic memberships', { userId: session.userId });
      return NextResponse.json({ topics: [] });
    }

    const topicIds = memberships.map((m) => m.topicId);
    const userTopics = await db.query.topics.findMany({
      where: (t, { inArray }) => inArray(t.id, topicIds),
    });

    logger.info(ROUTE, 'Topics fetched', { userId: session.userId, count: userTopics.length });
    return NextResponse.json({ topics: userTopics });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json();
    const { title, description, requiresCountryProof, allowedCountries, proof, publicInputs, verifierAddress, chainId } = body;

    if (!title || typeof title !== 'string') {
      logger.warn(ROUTE, 'Missing title in topic creation', { userId: session.userId });
      return NextResponse.json(
        { error: 'Title is required' },
        { status: 400 },
      );
    }

    // If topic requires country proof, verify it before creating
    if (requiresCountryProof) {
      logger.info(ROUTE, 'Topic requires country proof, verifying creator proof', { userId: session.userId });

      if (!proof || !publicInputs || !verifierAddress) {
        logger.warn(ROUTE, 'Missing country proof fields for topic creation', { userId: session.userId, hasProof: !!proof, hasPublicInputs: !!publicInputs, hasVerifierAddress: !!verifierAddress });
        return NextResponse.json(
          { error: 'Country proof required: proof, publicInputs, verifierAddress' },
          { status: 400 },
        );
      }

      logger.info(ROUTE, 'Verifying creator country proof on-chain', { userId: session.userId, proofLength: proof.length });

      const verification = await verifyProofFromRelay({
        status: 'completed',
        proof,
        publicInputs,
        verifierAddress,
        chainId,
        circuit: 'coinbase_country_attestation',
        requestId: session.userId,
      });

      if (!verification.valid) {
        logger.warn(ROUTE, 'Creator country proof verification failed', { userId: session.userId, error: verification.error });
        return NextResponse.json(
          { error: 'Country proof verification failed', details: verification.error },
          { status: 400 },
        );
      }

      logger.info(ROUTE, 'Creator country proof verified on-chain', { userId: session.userId });

      // Verify scope matches community scope
      const scope = extractScope(publicInputs, 'coinbase_country_attestation');
      const expectedScope = computeScopeHash(COMMUNITY_SCOPE);
      if (scope !== expectedScope) {
        logger.warn(ROUTE, 'Creator country proof scope mismatch', { userId: session.userId, scope, expectedScope });
        return NextResponse.json(
          { error: 'Country proof scope mismatch' },
          { status: 400 },
        );
      }

      // Verify is_included flag: confirms creator's country is in the allowed list
      const isIncluded = extractIsIncluded(publicInputs, 'coinbase_country_attestation');
      if (!isIncluded) {
        logger.warn(ROUTE, 'Creator country not in allowed list', { userId: session.userId });
        return NextResponse.json(
          { error: 'Your country is not allowed to create this topic' },
          { status: 403 },
        );
      }
    }

    const inviteCode = crypto.randomBytes(8).toString('hex');

    logger.info(ROUTE, 'Creating topic', { userId: session.userId, title, requiresCountryProof: requiresCountryProof ?? false, inviteCode });

    const [topic] = await db
      .insert(topics)
      .values({
        title,
        description: description ?? null,
        creatorId: session.userId,
        requiresCountryProof: requiresCountryProof ?? false,
        allowedCountries: allowedCountries ?? null,
        inviteCode,
      })
      .returning();

    // Auto-add creator as member
    await db.insert(topicMembers).values({
      topicId: topic.id,
      userId: session.userId,
    });

    logger.info(ROUTE, 'Topic created and creator added as member', { userId: session.userId, topicId: topic.id });
    return NextResponse.json({ topic }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
