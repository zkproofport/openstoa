import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topicMembers } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { parseCommitFraming, MlsFramingError } from '@/lib/mls/framing';
import { scheduleDeviceJoinRecord } from '@/lib/mls/deviceJoins';
import { applyCommitCas, getCommitsSince } from '@/lib/mls/commits';
import {
  decodeBase64Strict,
  checkRateLimit,
  MLS_CIPHERSUITE,
  MLS_MAX_COMMIT_BYTES,
  MLS_MAX_GROUP_INFO_BYTES,
  MLS_RATE_COMMIT,
} from '@/lib/mls/http';

const ROUTE = '/api/topics/[topicId]/mls/commit';

async function requireMember(request: NextRequest, topicId: string) {
  const session = await getSession(request);
  if (!session) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  const membership = await db.query.topicMembers.findFirst({
    where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
  });
  if (!membership) {
    return { error: NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 }) };
  }
  return { session };
}

/**
 * @openapi
 * /api/topics/{topicId}/mls/commit:
 *   post:
 *     tags: [MLS]
 *     summary: Submit an MLS Commit (epoch-CAS, one per epoch)
 *     description: |
 *       Submits a Commit that advances the topic's MLS group to the next epoch (e.g. after adding
 *       or removing a member). The server is the Delivery Service: it reads the **asserted epoch**
 *       from the Commit's cleartext framing (no decryption) and accepts the Commit **only if that
 *       epoch still equals the group's current epoch**, then atomically advances it (epoch-CAS,
 *       SI-2). Two Commits racing on the same epoch → exactly one is accepted (**409** for the
 *       loser), so the group never forks; the loser should re-fetch the current epoch, rebase its
 *       Commit and retry. The Commit + Welcome are stored to the handshake log and fanned out to
 *       online members via SSE; offline members catch up with `GET ...?sinceEpoch=`. The first
 *       Commit of a group (asserted epoch 0) lazily creates the group row. **Membership required.**
 *     operationId: submitMlsCommit
 *     x-related-skills: [publish-mls-key-package, consume-mls-key-package, get-mls-group-info]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [commit]
 *             properties:
 *               commit:
 *                 type: string
 *                 format: byte
 *                 description: base64-encoded Commit MLSMessage (RFC 9420). Its cleartext epoch is read for the CAS.
 *               welcome:
 *                 type: string
 *                 format: byte
 *                 description: base64-encoded Welcome MLSMessage for members added by this Commit. Omit if none added.
 *               groupInfo:
 *                 type: string
 *                 format: byte
 *                 description: base64-encoded public GroupInfo after the Commit, for later External Commits. Optional.
 *     responses:
 *       201:
 *         description: Commit accepted; group advanced
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { epoch: { type: integer, description: the new current epoch } }
 *       400: { description: Invalid/oversized commit, unparseable framing, or invalid genesis (asserted epoch != 0) }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { description: epoch-CAS conflict (another Commit won this epoch) or group_id mismatch — rebase and retry }
 *       429: { description: Per-member rate limit exceeded (SI-4) }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const auth = await requireMember(request, topicId);
    if ('error' in auth) return auth.error!;
    const { session } = auth;

    if (!(await checkRateLimit('commit', session.userId, MLS_RATE_COMMIT))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { commit, welcome, groupInfo } = body as Record<string, unknown>;

    const commitBytes = decodeBase64Strict(commit);
    if (!commitBytes || commitBytes.length === 0) {
      return NextResponse.json({ error: 'Valid base64 commit is required' }, { status: 400 });
    }
    if (commitBytes.length > MLS_MAX_COMMIT_BYTES) {
      return NextResponse.json({ error: `commit must be ${MLS_MAX_COMMIT_BYTES} bytes or fewer` }, { status: 400 });
    }

    let welcomeBytes: Buffer | null = null;
    if (welcome !== undefined && welcome !== null) {
      welcomeBytes = decodeBase64Strict(welcome);
      if (!welcomeBytes) return NextResponse.json({ error: 'welcome must be valid base64' }, { status: 400 });
      if (welcomeBytes.length > MLS_MAX_COMMIT_BYTES) {
        return NextResponse.json({ error: 'welcome too large' }, { status: 400 });
      }
    }

    let groupInfoBytes: Buffer | null = null;
    if (groupInfo !== undefined && groupInfo !== null) {
      groupInfoBytes = decodeBase64Strict(groupInfo);
      if (!groupInfoBytes) return NextResponse.json({ error: 'groupInfo must be valid base64' }, { status: 400 });
      if (groupInfoBytes.length > MLS_MAX_GROUP_INFO_BYTES) {
        return NextResponse.json({ error: 'groupInfo too large' }, { status: 400 });
      }
    }

    // Read the asserted epoch + group_id from the Commit framing (crypto-free).
    let framing;
    try {
      framing = parseCommitFraming(commitBytes);
    } catch (e) {
      if (e instanceof MlsFramingError) {
        return NextResponse.json({ error: `Invalid Commit framing: ${e.message}` }, { status: 400 });
      }
      throw e;
    }

    const result = await applyCommitCas(
      db,
      topicId,
      framing.epoch,
      framing.groupId,
      commitBytes,
      welcomeBytes,
      groupInfoBytes,
      MLS_CIPHERSUITE,
    );

    if (!result.ok) {
      if (result.reason === 'bad-genesis') {
        return NextResponse.json({ error: 'First Commit must assert epoch 0' }, { status: 400 });
      }
      // fork / group-mismatch → conflict; client rebases and retries (SI-2 liveness).
      return NextResponse.json({ error: `Commit rejected: ${result.reason}` }, { status: 409 });
    }

    /*
     * A device that just JOINED is recorded here and nowhere else (D-1).
     *
     * Only an ACCEPTED commit counts — a rejected one added nobody — which is
     * why this sits after the CAS rather than beside the parse. Fire-and-forget:
     * the commit is already applied, and losing this bookkeeping degrades to
     * discovering the device at its first acknowledgement, which is exactly the
     * behaviour that predates this table.
     */
    // `newEpoch` is optional on the result type. An accepted commit always has
    // one, but recording a join under a GUESSED epoch would place the device in
    // a window it cannot read, so an absent value skips rather than defaults.
    if (result.newEpoch !== undefined) {
      // The helper is documented not to throw, and guards its own async path.
      // This catches the synchronous half anyway: the Commit is already applied
      // and cannot be un-applied, so letting a bookkeeping throw reach the outer
      // handler would answer an ACCEPTED commit with 500 — and the client would
      // retry it into a 409 against the epoch its own commit just produced.
      try {
        scheduleDeviceJoinRecord(db, topicId, commitBytes, result.newEpoch);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.error(ROUTE, 'Device join bookkeeping threw; commit stands', { topicId, error: message });
      }
    }

    // Fan-out is OUTSIDE the transaction (G7): a crash here leaves consistent
    // committed state; offline members recover via GET ?sinceEpoch=.
    const redis = getRedis();
    await redis.publish(
      `mls:topic:${topicId}`,
      JSON.stringify({
        event: 'commit',
        epoch: result.newEpoch,
        commit: commitBytes.toString('base64'),
        welcome: welcomeBytes ? welcomeBytes.toString('base64') : null,
      }),
    );

    logger.info(ROUTE, 'Commit accepted', { userId: session.userId, topicId, epoch: result.newEpoch });
    return NextResponse.json({ epoch: result.newEpoch }, { status: 201 });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}

/**
 * @openapi
 * /api/topics/{topicId}/mls/commit:
 *   get:
 *     tags: [MLS]
 *     summary: Catch up on missed Commits (handshake log)
 *     description: |
 *       Returns every stored Commit (and its Welcome) with epoch strictly greater than
 *       `sinceEpoch`, in ascending epoch order. A member who was offline during one or more
 *       Commits replays these in order to reach the current epoch; a just-added member fetches
 *       the Commit whose Welcome admits them. All bytes are public ciphertext. **Membership required.**
 *     operationId: getMlsCommits
 *     x-related-skills: [submit-mls-commit]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - name: sinceEpoch
 *         in: query
 *         required: false
 *         description: Return Commits with epoch > this value (default 0 = all).
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Missed Commits in epoch order
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 commits:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       epoch: { type: integer }
 *                       commit: { type: string, format: byte }
 *                       welcome: { type: string, format: byte, nullable: true }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const auth = await requireMember(request, topicId);
    if ('error' in auth) return auth.error!;

    const { searchParams } = new URL(request.url);
    const sinceRaw = searchParams.get('sinceEpoch');
    const sinceEpoch = sinceRaw ? parseInt(sinceRaw, 10) : 0;
    if (!Number.isSafeInteger(sinceEpoch) || sinceEpoch < 0) {
      return NextResponse.json({ error: 'sinceEpoch must be a non-negative integer' }, { status: 400 });
    }

    const commits = await getCommitsSince(db, topicId, sinceEpoch);
    return NextResponse.json({
      commits: commits.map((c) => ({
        epoch: c.epoch,
        commit: c.commit.toString('base64'),
        welcome: c.welcome ? c.welcome.toString('base64') : null,
      })),
    });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}
