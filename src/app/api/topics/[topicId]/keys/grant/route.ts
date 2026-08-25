/**
 * Answering "please unlock the history for me".
 *
 * WHAT THIS ROUTE DOES, and what it deliberately does not. It marks a request
 * answered. It does NOT carry the keys: the granting client has already sealed
 * them to the requester's leaf and posted them as a `tak_bundles` row, which
 * the server cannot open. This endpoint exists so the asker stops asking and
 * the row leaves the list a member is looking at.
 *
 * ORDER MATTERS AND IS THE CALLER'S RESPONSIBILITY: post the bundle first, mark
 * granted second. A request marked granted with no bundle behind it is worse
 * than an open one, because the person stops waiting and nothing ever arrives.
 * The comment sits here as well as in the store because this is the endpoint a
 * new client will find first.
 *
 * ONLY MEMBERS. There is no role check beyond membership, and that is correct
 * for the thing being granted: these are keys every member of the room already
 * holds. An owner-only rule would not protect anything — it would just mean the
 * one person able to help is the one least likely to be online.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topicMembers } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { isValidUUID } from '@/lib/uuid';
import { checkRateLimit, type RateLimit } from '@/lib/mls/http';
import { markGranted } from '@/lib/keyRequestStore';

const ROUTE = '/api/topics/[topicId]/keys/grant';
const RATE: RateLimit = { max: 60, windowSec: 60 };

/**
 * POST — body `{ requestId }`.
 *
 * Answers 200 with `{ ok, alreadyGranted }` rather than an error when the
 * request was already answered: two members tapping at the same moment is a
 * normal thing to happen, and the second one has not done anything wrong.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    if (!isValidUUID(topicId)) {
      return NextResponse.json({ error: 'Invalid topic id' }, { status: 400 });
    }
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    if (!(await checkRateLimit('keygrant', session.userId, RATE))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const member = await db.query.topicMembers.findFirst({
      where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
    });
    if (!member) return NextResponse.json({ error: 'Not a member' }, { status: 403 });

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
    if (!isValidUUID(requestId)) {
      return NextResponse.json({ error: 'Valid requestId is required' }, { status: 400 });
    }

    const changed = await markGranted(db, requestId, session.userId);
    logger.info(ROUTE, changed ? 'key request granted' : 'key request already granted', {
      topicId,
      requestId,
      userId: session.userId,
    });
    return NextResponse.json({ ok: true, alreadyGranted: !changed });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}
