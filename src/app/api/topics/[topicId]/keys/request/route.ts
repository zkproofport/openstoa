/**
 * "Please unlock the history for me" — the ask, and the list of asks to answer.
 *
 * WHAT THIS IS FOR. After a recovery on a new phone, `public` rooms come back in
 * full because the server holds the archive root. `private`, `secret` and `dm`
 * come back only as far as the OLD phone's last backup: epochs that advanced
 * while it was off never reached that device's keychain, so they were never in
 * the blob. Backing up more often does not help — you cannot upload a key you
 * never received.
 *
 * The keys still exist on the devices of members who were online. The missing
 * step is not cryptography, it is ASKING, and the ask has to outlive the moment
 * because the member who can grant is rarely looking at their phone right then.
 *
 * WHAT THE SERVER LEARNS: that a device would like keys for a topic. Never the
 * keys. A grant travels as an HPKE-sealed `tak_bundles` row addressed to the
 * requester's leaf — the server cannot open it, exactly as with every other key
 * delivery here.
 *
 * NOT IN THE PUBLIC OPENAPI SPEC, matching `/api/keys/backup`: this is an
 * end-user recovery flow driven by the app, not an agent surface. An agent
 * authenticates per session and holds no recoverable device keychain.
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
import { requestKeys, openRequests, myRequest } from '@/lib/keyRequestStore';

const ROUTE = '/api/topics/[topicId]/keys/request';

/*
 * Low ceiling on purpose. A person taps this once and waits; anything that
 * looks like a loop is a client bug, and a loop here would fill a granting
 * member's screen with the same row.
 */
const RATE: RateLimit = { max: 20, windowSec: 60 };

/** Membership is the whole authorization story: only members ask, only members answer. */
async function isMember(topicId: string, userId: string): Promise<boolean> {
  const row = await db.query.topicMembers.findFirst({
    where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, userId)),
  });
  return !!row;
}

/**
 * GET — the open requests in this topic, plus this device's own.
 *
 * Both in one answer because the screen needs both: a member sees who is
 * waiting, and the same screen tells the asker whether their own request has
 * been answered yet. Two endpoints would have meant two round trips for one
 * question.
 */
export async function GET(
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
    if (!(await isMember(topicId, session.userId))) {
      return NextResponse.json({ error: 'Not a member' }, { status: 403 });
    }

    const deviceId = request.nextUrl.searchParams.get('deviceId');
    const [open, mine] = await Promise.all([
      openRequests(db, topicId),
      deviceId ? myRequest(db, topicId, deviceId) : Promise.resolve(null),
    ]);

    return NextResponse.json({
      requests: open.map((r) => ({
        id: r.id,
        requesterUserId: r.requesterUserId,
        requesterDeviceId: r.requesterDeviceId,
        haveFromEpoch: r.haveFromEpoch,
        createdAt: r.createdAt?.toISOString() ?? null,
      })),
      mine: mine
        ? {
            id: mine.id,
            granted: mine.grantedAt !== null,
            createdAt: mine.createdAt?.toISOString() ?? null,
          }
        : null,
    });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}

/**
 * POST — ask.
 *
 * Body: `{ deviceId, haveFromEpoch? }`.
 *
 * `haveFromEpoch` is the oldest epoch the asker CAN already read, so a granting
 * member only has to cover what sits below it. Absent means "none of it".
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
    if (!(await checkRateLimit('keyreq', session.userId, RATE))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }
    if (!(await isMember(topicId, session.userId))) {
      /*
       * A non-member asking is not a smaller version of a member asking — there
       * is nothing they are entitled to read, so the request would be an ask
       * for access rather than for keys they already have a right to.
       */
      return NextResponse.json({ error: 'Not a member' }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
    if (!deviceId || deviceId.length > 256) {
      return NextResponse.json({ error: 'deviceId is required' }, { status: 400 });
    }

    /*
     * A non-integer, negative or absurd epoch is treated as "none". Refusing
     * would fail the ask over a field that only makes the grant SMALLER; the
     * safe reading is the one that asks for everything.
     */
    const raw = body?.haveFromEpoch;
    const haveFromEpoch =
      typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;

    await requestKeys(db, {
      topicId,
      requesterUserId: session.userId,
      requesterDeviceId: deviceId,
      haveFromEpoch,
    });

    logger.info(ROUTE, 'key request recorded', {
      topicId,
      userId: session.userId,
      haveFromEpoch,
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}
