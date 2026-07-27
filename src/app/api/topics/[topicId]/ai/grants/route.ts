import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topicMembers } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { checkRateLimit, type RateLimit } from '@/lib/mls/http';
import { createGrant, listGrants, GrantValidationError, type GrantRow } from '@/lib/aiGrants';

const ROUTE = '/api/topics/[topicId]/ai/grants';

// SI-4: per-member fixed-window cap on grant writes.
const AI_GRANT_RATE: RateLimit = { max: 60, windowSec: 60 };

async function requireMembership(request: NextRequest, topicId: string) {
  const session = await getSession(request);
  if (!session) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  const membership = await db.query.topicMembers.findFirst({
    where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
  });
  if (!membership) return { error: NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 }) };
  return { session, membership };
}

// Shape a grant row for the wire — metadata only, never key material (SI-1).
function toWire(g: GrantRow) {
  return {
    id: g.id,
    topicId: g.topicId,
    granterUserId: g.granterUserId,
    aiUserId: g.aiUserId,
    cmd: g.cmd,
    historyGrant: g.historyGrant,
    depth: g.depth,
    dpopJkt: g.dpopJkt,
    consentAnchor: g.consentAnchor,
    createdAt: g.createdAt,
  };
}

/**
 * @openapi
 * /api/topics/{topicId}/ai/grants:
 *   post:
 *     tags: [AI]
 *     summary: Grant a scoped UCAN-shaped capability to an AI member (owner only)
 *     description: |
 *       Creates a **scoped delegation** from the human topic OWNER (creator or admin) to an AI
 *       member so the bot may act in the topic under least-privilege (design §7, D9). The grant is
 *       UCAN-shaped: `cmd` is the ability allowlist, `historyGrant` is the archive (TAK) scope the
 *       AI may back-fill, `depth` bounds sub-delegation (≤3), `dpopJkt`/`consentAnchor` are optional
 *       key-theft and on-chain-consent bindings. The grant holds **no keys and no plaintext** — the
 *       AI still joins with its OWN device KeyPackage and derives keys itself (C1/SI-1). Enforcement:
 *       an AI caller (`isAI` session) performing a chat send or history read MUST hold an active
 *       grant whose `cmd` permits it, else 403. **Owner/admin only** — a non-owner member gets 403.
 *     operationId: createAiGrant
 *     x-related-skills: [send-chat-message, get-archive, get-tak-bundles]
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
 *             required: [aiUserId, cmd, historyGrant]
 *             properties:
 *               aiUserId:
 *                 type: string
 *                 description: The AI member's user id (nullifier) this grant delegates to.
 *               cmd:
 *                 type: array
 *                 items: { type: string }
 *                 description: 'Ability allowlist (non-empty subset of the allowed commands), e.g. ["/openstoa/chat/send", "/openstoa/post/read", "/ai/summarize"]. Unknown commands are rejected.'
 *               historyGrant:
 *                 type: string
 *                 description: 'TAK archive scope the AI may back-fill: none | Nd | since_epoch:N | full. Never wider than what the owner holds.'
 *               depth:
 *                 type: integer
 *                 description: 'Max delegation depth (0..3, default 1). depth > 3 is rejected (UCAN §7.2).'
 *               dpopJkt:
 *                 type: string
 *                 nullable: true
 *                 description: Optional RFC 9449 DPoP JWK thumbprint binding the AI's transport key (anti key-theft).
 *               consentAnchor:
 *                 type: string
 *                 nullable: true
 *                 description: Optional EAS attestation UID anchoring user consent on-chain (revocable).
 *     responses:
 *       201:
 *         description: Grant created
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { grant: { type: object } } }
 *       400: { description: Invalid cmd/historyGrant/depth or missing aiUserId }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { description: Caller is not a member, or not the topic owner/admin }
 *       429: { description: Per-member rate limit exceeded (SI-4) }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const auth = await requireMembership(request, topicId);
    if ('error' in auth) return auth.error!;
    const { session, membership } = auth;

    // Owner-only: creator (role 'owner') or a topic admin may delegate to an AI.
    if (membership.role !== 'owner' && membership.role !== 'admin') {
      return NextResponse.json({ error: 'Only the topic owner or admin can grant AI capabilities' }, { status: 403 });
    }

    if (!(await checkRateLimit('ai-grant', session.userId, AI_GRANT_RATE))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { aiUserId, cmd, historyGrant, depth, dpopJkt, consentAnchor } = body as Record<string, unknown>;

    let grant: GrantRow;
    try {
      grant = await createGrant(db, {
        topicId,
        granterUserId: session.userId,
        aiUserId,
        cmd,
        historyGrant,
        depth,
        dpopJkt,
        consentAnchor,
      });
    } catch (e) {
      if (e instanceof GrantValidationError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      throw e;
    }

    logger.info(ROUTE, 'AI grant created', {
      topicId,
      granterUserId: session.userId,
      aiUserId: grant.aiUserId,
      cmd: grant.cmd,
      historyGrant: grant.historyGrant,
      depth: grant.depth,
      id: grant.id,
    });
    return NextResponse.json({ grant: toWire(grant) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/topics/{topicId}/ai/grants:
 *   get:
 *     tags: [AI]
 *     summary: List active AI grants in a topic
 *     description: |
 *       Returns the topic's active (non-revoked) AI grants — metadata only (cmd allowlist, history
 *       scope, depth, optional bindings), never key material (SI-1). **Membership required.**
 *     operationId: listAiGrants
 *     x-related-skills: [create-ai-grant]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Active grants
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { grants: { type: array, items: { type: object } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const auth = await requireMembership(request, topicId);
    if ('error' in auth) return auth.error!;

    const grants = await listGrants(db, topicId);
    return NextResponse.json({ grants: grants.map(toWire) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
