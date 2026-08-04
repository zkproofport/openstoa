import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topicMembers, topics } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { checkRateLimit, decodeBase64Strict, MLS_RATE_TAK } from '@/lib/mls/http';
import { getArchiveRootIdentity, claimArchiveRootFingerprint } from '@/lib/mls/archive';

const ROUTE = '/api/topics/[topicId]/tak/root-fingerprint';

// base64 of exactly 16 bytes — the wire form of
// HKDF(root, "openstoa-archive-root-id/v1", 16). Anything else is not a
// fingerprint this system can have produced, so it is rejected at the envelope
// rather than being written into a column that can never be corrected.
const FINGERPRINT_BYTES = 16;

/**
 * Resolve the caller's membership AND require the topic be PUBLIC. The archive
 * root fingerprint identifies the single shared root of the PUBLIC tier (§5.2).
 * private / secret / DM topics key their archive per MLS epoch — there is no
 * topic-wide root to identify — so fingerprint operations on them are a 400 by
 * design, mirroring the archive-holder route (SI-6b).
 */
async function requirePublicMember(request: NextRequest, topicId: string) {
  const session = await getSession(request);
  if (!session) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  const membership = await db.query.topicMembers.findFirst({
    where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
  });
  if (!membership) return { error: NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 }) };
  const topic = await db.query.topics.findFirst({ where: eq(topics.id, topicId) });
  if (!topic) return { error: NextResponse.json({ error: 'Topic not found' }, { status: 404 }) };
  if (topic.visibility !== 'public') {
    return {
      error: NextResponse.json(
        { error: 'archive root fingerprint applies to public topics only (private/secret archive keys are per-epoch)' },
        { status: 400 },
      ),
    };
  }
  return { session };
}

/**
 * @openapi
 * /api/topics/{topicId}/tak/root-fingerprint:
 *   get:
 *     tags: [MLS]
 *     summary: Read which archive root a public topic's history is sealed under
 *     description: |
 *       Returns the **identity of the public topic's archive root** — a domain-separated one-way tag
 *       `base64(HKDF(root, "openstoa-archive-root-id/v1", 16))` — plus how many archived messages the
 *       topic already has. The server stores the tag as opaque bytes and never derives or verifies it
 *       (crypto-free Delivery Service, C1); clients compute it from the root they hold and compare.
 *
 *       A public topic has ONE random archive root for its whole history (design §5.2) and its rows
 *       carry `takVersion: 0`, so nothing in the rows themselves distinguishes the real root from a
 *       root some other device minted while waiting to receive it. Call this BEFORE archiving:
 *
 *       - `fingerprint` matches the root you hold → your root is the real one; archive normally.
 *       - `fingerprint` differs → the root you hold is an orphan. STOP archiving under it (more rows
 *         nobody can read), keep it locally for reading rows you already sealed, and wait for the real
 *         root to arrive as a TAK bundle.
 *       - `fingerprint` is null and `archiveCount` is 0 → nothing exists yet; you may generate a root
 *         and publish its fingerprint with PUT.
 *       - `fingerprint` is null and `archiveCount` > 0 → a root exists but predates the fingerprint
 *         (topics created before this field). **Do NOT generate a root** — that is precisely what makes
 *         existing rows permanently unreadable. Only a device that can decrypt the OLDEST existing
 *         archive row may publish its fingerprint.
 *
 *       Public topics only. **Membership required.**
 *     operationId: getArchiveRootFingerprint
 *     x-related-skills: [set-archive-root-fingerprint, get-tak-bundles, get-archive-holder]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The topic's archive root identity
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fingerprint:
 *                   type: string
 *                   nullable: true
 *                   description: base64 of 16 bytes identifying the archive root, or null if no root has been claimed yet.
 *                 archiveCount:
 *                   type: integer
 *                   description: Number of archived messages. Non-zero proves a root already exists even when fingerprint is null.
 *       400: { description: Topic is not public }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { description: Topic not found }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const auth = await requirePublicMember(request, topicId);
    if ('error' in auth) return auth.error!;

    const identity = await getArchiveRootIdentity(db, topicId);
    return NextResponse.json(identity);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/topics/{topicId}/tak/root-fingerprint:
 *   put:
 *     tags: [MLS]
 *     summary: Publish the archive root's identity (compare-and-set, first writer wins)
 *     description: |
 *       Publishes `base64(HKDF(root, "openstoa-archive-root-id/v1", 16))` for a public topic.
 *       **COMPARE-AND-SET: the value is only ever written over null, never over an existing one.**
 *       If another device published first, the response returns THAT fingerprint with
 *       `claimed: false` — the caller must then adopt the winner's root (request it via
 *       `GET /api/topics/{topicId}/tak/bundles`) and must NOT keep archiving under its own, or it
 *       writes rows no one can decrypt. Re-publishing the same value you already published is
 *       idempotent (`claimed: true`).
 *
 *       **Call this only when you can prove your root is the topic's real one:**
 *       - `archiveCount == 0` (from GET) → nothing to contradict you; publish immediately after
 *         generating the root and BEFORE archiving anything under it.
 *       - `archiveCount > 0` with a null fingerprint → publish only if your root successfully decrypts
 *         the OLDEST existing archive row. A root that cannot is an orphan and must stay unpublished.
 *
 *       The server cannot check any of this (C1: it holds no key material and performs no crypto) —
 *       it enforces only the envelope: public topic, current member, well-formed 16-byte value, and
 *       write-once. Public topics only. **Membership required.** Rate-limited.
 *     operationId: setArchiveRootFingerprint
 *     x-related-skills: [get-archive-root-fingerprint, deliver-tak-bundle, get-tak-bundles]
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
 *             required: [fingerprint]
 *             properties:
 *               fingerprint:
 *                 type: string
 *                 format: byte
 *                 description: base64 of exactly 16 bytes — HKDF(root, "openstoa-archive-root-id/v1", 16). Never send the root itself.
 *     responses:
 *       200:
 *         description: The fingerprint now published for this topic (yours, or the winner's)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fingerprint: { type: string, description: The value now stored for the topic. }
 *                 claimed:
 *                   type: boolean
 *                   description: true if your value is the stored one. false means another device won — adopt its root.
 *       400: { description: Missing/malformed fingerprint, or topic not public }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { description: Topic not found }
 *       429: { description: Rate limit exceeded }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const auth = await requirePublicMember(request, topicId);
    if ('error' in auth) return auth.error!;
    const { session } = auth;

    if (!(await checkRateLimit('tak-root-fp', session.userId, MLS_RATE_TAK))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { fingerprint } = body as Record<string, unknown>;
    const raw = decodeBase64Strict(fingerprint);
    if (!raw || raw.length !== FINGERPRINT_BYTES) {
      return NextResponse.json(
        { error: `fingerprint must be base64 of exactly ${FINGERPRINT_BYTES} bytes` },
        { status: 400 },
      );
    }

    const result = await claimArchiveRootFingerprint(db, topicId, fingerprint as string);
    if (!result) return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
    if (!result.claimed) {
      logger.info(ROUTE, 'Archive root fingerprint already claimed by another root', {
        topicId,
        userId: session.userId,
      });
    }
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in PUT', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
