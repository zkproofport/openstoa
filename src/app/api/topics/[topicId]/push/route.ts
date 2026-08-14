/**
 * Per-topic push MUTE (P-S) — "don't notify me about this chat room". The
 * companion of the global switch at `/api/push/preferences` (P-M).
 *
 * Scoped to the session user's OWN mute for ONE topic: there is no user
 * parameter, so a caller can never mute a topic on someone else's behalf.
 * Membership is required — muting a topic you are not in is meaningless (you
 * would never be a push recipient anyway) and is rejected with 403 so a client
 * bug surfaces instead of silently writing a dead row.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { checkRateLimit, type RateLimit } from '@/lib/mls/http';
import {
  isUuid,
  isTopicMuted,
  setTopicMuted,
  getGlobalPushEnabled,
  PushPrefsValidationError,
} from '@/lib/pushPrefs';

const ROUTE = '/api/topics/[topicId]/push';
const RATE: RateLimit = { max: 60, windowSec: 60 };

/**
 * Shared gate for both verbs: authenticate, rate-limit, validate the topic id,
 * then require the topic to exist (404) and the caller to be a member (403).
 * Returns either a ready-to-send error response or the resolved session user.
 */
async function authorize(
  request: NextRequest,
  topicId: string,
): Promise<{ error: NextResponse } | { userId: string }> {
  const session = await getSession(request);
  if (!session) {
    return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }
  if (!(await checkRateLimit('push-topic-mute', session.userId, RATE))) {
    return { error: NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 }) };
  }
  // Validate BEFORE any query: `topics.id` is a uuid column, so a hostile or
  // oversized id would raise 22P02 and surface as a 500 instead of a 400.
  if (!isUuid(topicId)) {
    return { error: NextResponse.json({ error: 'Invalid topicId' }, { status: 400 }) };
  }
  const topic = await db.query.topics.findFirst({
    where: eq(topics.id, topicId),
    columns: { id: true },
  });
  if (!topic) {
    return { error: NextResponse.json({ error: 'Topic not found' }, { status: 404 }) };
  }
  const membership = await db.query.topicMembers.findFirst({
    where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
    columns: { userId: true },
  });
  if (!membership) {
    return { error: NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 }) };
  }
  return { userId: session.userId };
}

/**
 * @openapi
 * /api/topics/{topicId}/push:
 *   get:
 *     tags: [Push]
 *     summary: Read your notification setting for one topic
 *     description: |
 *       Returns whether the caller muted THIS topic, alongside the account-wide switch and the
 *       resolved answer (`willNotify`) so a client can render the correct state without doing the
 *       precedence arithmetic itself.
 *
 *       **Membership required** — a non-member gets 403, because a non-member is never a push
 *       recipient for the topic in the first place.
 *     operationId: getTopicPushPreference
 *     x-related-skills: [update-topic-push-preference, get-push-preferences]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: The topic (chat room) whose notification setting you want. Must be a UUID; anything else is 400.
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The caller's notification state for this topic
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 topicId:
 *                   type: string
 *                   format: uuid
 *                   description: Echo of the topic this state belongs to.
 *                 muted:
 *                   type: boolean
 *                   description: '`true` when the caller muted this topic individually. `false` (the default for every topic you join) means it follows the account-wide switch.'
 *                 globalEnabled:
 *                   type: boolean
 *                   description: The account-wide switch from `/api/push/preferences`, repeated here so a client can explain WHY a topic is silent.
 *                 willNotify:
 *                   type: boolean
 *                   description: The resolved outcome — `globalEnabled && !muted`. When `false`, no device push is sent for this topic (the message itself is still delivered in-app).
 *       400: { description: topicId is not a UUID }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { description: Caller is not a member of this topic }
 *       404: { description: Topic not found }
 *       429: { description: Rate limit exceeded — max 60 calls per minute per user }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const gate = await authorize(request, topicId);
    if ('error' in gate) return gate.error;

    const [muted, globalEnabled] = await Promise.all([
      isTopicMuted(db, gate.userId, topicId),
      getGlobalPushEnabled(db, gate.userId),
    ]);
    return NextResponse.json({
      topicId,
      muted,
      globalEnabled,
      willNotify: globalEnabled && !muted,
    });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}

/**
 * @openapi
 * /api/topics/{topicId}/push:
 *   patch:
 *     tags: [Push]
 *     summary: Mute or unmute one topic
 *     description: |
 *       Mutes (`muted: true`) or unmutes (`muted: false`) push notifications for THIS topic only —
 *       the per-chat-room control. Muting does not affect any other topic and does not leave the
 *       topic: messages still arrive in-app, only the device notification is suppressed.
 *
 *       **Membership required** — a non-member gets 403.
 *
 *       Idempotent in both directions: muting an already-muted topic (or unmuting one that was never
 *       muted) is a no-op that still returns the correct final state, with `changed: false` so a
 *       client can tell a real transition from a redundant tap. Two racing toggles therefore converge
 *       instead of duplicating rows or erroring.
 *
 *       The account-wide switch wins: while `/api/push/preferences` has `enabled: false`, unmuting a
 *       topic here does NOT start notifications — `willNotify` stays `false` until the global switch
 *       is turned back on.
 *     operationId: updateTopicPushPreference
 *     x-related-skills: [get-topic-push-preference, update-push-preferences, get-push-preferences]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: The topic (chat room) to mute or unmute. Must be a UUID; anything else is 400.
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [muted]
 *             properties:
 *               muted:
 *                 type: boolean
 *                 description: 'Send `true` to silence this topic''s notifications, `false` to restore them. Must be a real JSON boolean — the strings "true"/"false", 0/1, and null are rejected with 400.'
 *     responses:
 *       200:
 *         description: The topic's notification state after the update
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 topicId:
 *                   type: string
 *                   format: uuid
 *                   description: Echo of the topic that was updated.
 *                 muted:
 *                   type: boolean
 *                   description: The stored state after the call — equal to the requested value.
 *                 changed:
 *                   type: boolean
 *                   description: '`true` when this call actually flipped the state; `false` when it was already in the requested state (idempotent no-op).'
 *                 globalEnabled:
 *                   type: boolean
 *                   description: The account-wide switch, repeated so a client can warn that un-muting alone will not produce notifications while it is `false`.
 *                 willNotify:
 *                   type: boolean
 *                   description: The resolved outcome after the update — `globalEnabled && !muted`.
 *       400: { description: 'topicId is not a UUID, `muted` is missing/not a boolean, or the body is not valid JSON' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { description: Caller is not a member of this topic }
 *       404: { description: Topic not found }
 *       429: { description: Rate limit exceeded — max 60 calls per minute per user }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const gate = await authorize(request, topicId);
    if ('error' in gate) return gate.error;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { muted } = body as Record<string, unknown>;
    // Strict boolean only — see the global switch route for the rationale.
    if (typeof muted !== 'boolean') {
      return NextResponse.json({ error: 'muted must be a boolean' }, { status: 400 });
    }

    let result;
    try {
      result = await setTopicMuted(db, gate.userId, topicId, muted);
    } catch (e) {
      if (e instanceof PushPrefsValidationError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      throw e;
    }
    const globalEnabled = await getGlobalPushEnabled(db, gate.userId);
    logger.info(ROUTE, 'topic push preference updated', {
      userId: gate.userId,
      topicId,
      muted: result.muted,
      changed: result.changed,
    });
    return NextResponse.json({
      topicId,
      muted: result.muted,
      changed: result.changed,
      globalEnabled,
      willNotify: globalEnabled && !result.muted,
    });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'PATCH', error);
  }
}
