import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { requireAiCapability } from '@/lib/aiPermissions';
import { getBatchUserBadges } from '@/lib/verification-cache';
import { normaliseSearchQuery } from '@/lib/search';
import {
  badgesForSharedTopics,
  buildDmCandidatesQuery,
  clampCandidateLimit,
  type DmCandidate,
} from '@/lib/dmCandidates';

const ROUTE = '/api/dm/candidates';

/**
 * @openapi
 * /api/dm/candidates:
 *   get:
 *     tags: [DM]
 *     summary: List the people you may start a NEW DM with
 *     description: |
 *       Returns every person the authenticated caller may start a **NEW** 1:1 direct message
 *       with — that is, every member of every topic the caller belongs to, **de-duplicated so
 *       one person appears exactly once** no matter how many topics you share, with the caller
 *       themselves excluded, AND with anyone the caller already has a DM channel with also
 *       excluded (call `GET /api/dm` for those — this list is for DISCOVERING new people, not
 *       for resuming existing conversations). Use it to render a "new conversation" picker: pick
 *       a `userId` from here, then `POST /api/dm { userId }` to start the channel.
 *
 *       **DM is restricted to shared-topic peers by design.** Identities are anonymous
 *       nullifiers, so shared-topic membership is what keeps DM from becoming an open spam
 *       and harassment channel. There is no endpoint that opens a DM to an arbitrary user —
 *       if someone is not in this list AND not already in `GET /api/dm`, `POST /api/dm` is not
 *       the way to reach them; join a topic they are in first.
 *
 *       Existing DM rooms are NOT topics: `kind='dm'` channels are excluded when computing
 *       "topics you belong to", so a past DM counterpart never appears here via a shared-topic
 *       path either. **Important for callers who already know a `userId`** (e.g. re-opening a
 *       known conversation): `POST /api/dm` remains valid for an EXISTING DM partner even
 *       though they are absent from this list — it never re-checks shared-topic membership
 *       once a channel exists. Only use this endpoint to discover WHO you can newly message;
 *       don't treat "missing from here" as "can no longer message them" without first checking
 *       `GET /api/dm`.
 *
 *       `badges` is the union of what each shared topic would show for that person (a badge
 *       is only visible in a topic that gates on that proof type) — never more than the
 *       member list of those topics already reveals. Open (`proofType: 'none'`) topics
 *       contribute no badges.
 *
 *       An AI (`isAI`) caller must hold the `/openstoa/chat/read` capability (profile grant
 *       or scoped API key), otherwise 403 — the same gate as listing DMs.
 *     operationId: listDmCandidates
 *     x-related-skills: [start-dm, list-dms, list-members, send-chat-message]
 *     parameters:
 *       - name: q
 *         in: query
 *         required: false
 *         description: >-
 *           Optional case-insensitive substring filter on the candidate's nickname. Send the
 *           raw text the user typed — `%`, `_` and `\` are escaped server-side and matched
 *           literally, and a blank/whitespace-only value means "no filter" (never
 *           match-everything). Longer than 200 characters is clipped to 200.
 *         schema:
 *           type: string
 *           maxLength: 200
 *       - name: limit
 *         in: query
 *         required: false
 *         description: >-
 *           Maximum number of candidates to return, ordered by nickname. Defaults to 200 and
 *           is clamped to 500; a non-numeric, zero or negative value falls back to the
 *           default. If you are in very large topics, narrow with `q` rather than raising
 *           this.
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 500
 *           default: 200
 *     responses:
 *       200:
 *         description: The people the caller may DM, one entry per person, ordered by nickname.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 candidates:
 *                   type: array
 *                   description: >-
 *                     One entry per distinct person. Empty when the caller belongs to no
 *                     topics, or to no topic that has another member — that is a normal 200,
 *                     not an error.
 *                   items:
 *                     type: object
 *                     properties:
 *                       userId:
 *                         type: string
 *                         description: >-
 *                           The candidate's nullifier user id. This is exactly the value to
 *                           send as `userId` in the `POST /api/dm` body.
 *                       nickname:
 *                         type: string
 *                         description: The candidate's display nickname. Show this in the picker.
 *                       profileImage:
 *                         type: string
 *                         nullable: true
 *                         description: Avatar URL, or null when the candidate has not set one.
 *                       badges:
 *                         type: array
 *                         description: >-
 *                           Verification badges visible across the shared topics (union of
 *                           each shared topic's badge filter). Empty when the topics you
 *                           share are open ones.
 *                         items:
 *                           type: object
 *                           properties:
 *                             type:
 *                               type: string
 *                               description: Badge kind — `kyc`, `country`, `workspace`, or `oidc`.
 *                             label:
 *                               type: string
 *                               description: Short human label to render on the chip.
 *                             domain:
 *                               type: string
 *                               nullable: true
 *                               description: >-
 *                                 Workspace domain, present only when the candidate opted in
 *                                 to showing it publicly.
 *                       sharedTopics:
 *                         type: array
 *                         description: >-
 *                           Every real topic the caller and this person are both members of,
 *                           ordered by title. Always at least one entry — that is why the
 *                           person is DM-able. Render it as the "why you can message them"
 *                           subtitle.
 *                         items:
 *                           type: object
 *                           properties:
 *                             id:
 *                               type: string
 *                               format: uuid
 *                               description: Topic id — usable with `GET /api/topics/{topicId}`.
 *                             title:
 *                               type: string
 *                               description: Topic title as shown in the topic list.
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
export async function GET(request: NextRequest) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // Reading who you could message is a chat read — same gate as GET /api/dm.
    const readGate = await requireAiCapability(db, session, '/openstoa/chat/read');
    if (readGate) {
      logger.warn(ROUTE, 'AI caller lacks chat/read capability', { userId: session.userId });
      return readGate;
    }

    const url = new URL(request.url);
    // Blank/whitespace `q` normalises to null == no filter (never `%%`), and
    // `%` / `_` / `\` are escaped so a hostile nickname search matches literally.
    const qPattern = normaliseSearchQuery(url.searchParams.get('q'));
    const limit = clampCandidateLimit(url.searchParams.get('limit'));

    // One grouped query: de-duplication by peer user id and the kind='dm'
    // exclusion both happen in SQL, so a caller in many large topics never
    // pulls the membership cross-product into this process.
    const rows = await buildDmCandidatesQuery(db, session.userId, { qPattern, limit });

    const badgeMap = await getBatchUserBadges(rows.map((r) => r.userId));

    const candidates: DmCandidate[] = rows.map((row) => ({
      userId: row.userId,
      nickname: row.nickname,
      profileImage: row.profileImage ?? null,
      badges: badgesForSharedTopics(badgeMap.get(row.userId) ?? [], row.proofTypes ?? []),
      sharedTopics: row.sharedTopics ?? [],
    }));

    logger.info(ROUTE, 'DM candidates fetched', {
      userId: session.userId,
      count: candidates.length,
      filtered: qPattern !== null,
    });
    return NextResponse.json({ candidates });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}
