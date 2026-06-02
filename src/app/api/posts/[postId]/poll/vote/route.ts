import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { pollVotes, pollOptions } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { getPollByPostId, loadPollsForPosts } from '@/lib/polls';

const ROUTE = '/api/posts/[postId]/poll/vote';

/**
 * @openapi
 * /api/posts/{postId}/poll/vote:
 *   post:
 *     tags: [Polls]
 *     summary: Cast or change a poll vote
 *     description: |
 *       Records the user's vote(s) on a post's poll. For single-choice
 *       polls (`multipleChoice=false`), `optionIds` MUST contain exactly
 *       one id and any prior vote by the user is replaced. For
 *       multiple-choice polls, every id in `optionIds` becomes a vote;
 *       duplicates are deduped; voting for an option you've already voted
 *       for is a no-op. Closed polls reject all writes.
 *     operationId: castPollVote
 *     x-related-skills: [get-post, clear-poll-vote]
 *     parameters:
 *       - name: postId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [optionIds]
 *             properties:
 *               optionIds:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Updated poll snapshot
 *   delete:
 *     tags: [Polls]
 *     summary: Clear the user's poll votes
 *     operationId: clearPollVote
 *     x-related-skills: [cast-poll-vote, get-post]
 *     parameters:
 *       - name: postId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Updated poll snapshot
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const poll = await getPollByPostId(postId);
    if (!poll) {
      return NextResponse.json({ error: 'Poll not found' }, { status: 404 });
    }
    if (poll.closesAt && poll.closesAt.getTime() < Date.now()) {
      return NextResponse.json({ error: 'Poll is closed' }, { status: 409 });
    }

    const body = await request.json().catch(() => ({}));
    const rawIds: unknown[] = Array.isArray(body?.optionIds) ? body.optionIds : [];
    const optionIds: string[] = Array.from(
      new Set(
        rawIds.filter((v): v is string => typeof v === 'string' && v.length > 0),
      ),
    );
    if (optionIds.length === 0) {
      return NextResponse.json({ error: 'optionIds is required' }, { status: 400 });
    }
    if (!poll.multipleChoice && optionIds.length > 1) {
      return NextResponse.json(
        { error: 'Single-choice poll accepts only one optionId' },
        { status: 400 },
      );
    }

    // Verify every option belongs to this poll — guards against cross-poll
    // ID smuggling.
    const validOptions = await db
      .select({ id: pollOptions.id })
      .from(pollOptions)
      .where(and(eq(pollOptions.pollId, poll.id), inArray(pollOptions.id, optionIds)));
    if (validOptions.length !== optionIds.length) {
      return NextResponse.json({ error: 'Invalid option' }, { status: 400 });
    }

    if (!poll.multipleChoice) {
      // Replace any existing vote with the single new one.
      await db
        .delete(pollVotes)
        .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.userId, session.userId)));
    }

    // Insert each (poll, option, user) row — the unique index gives us
    // dedupe semantics for multi-choice polls when a user retries.
    for (const optionId of optionIds) {
      await db
        .insert(pollVotes)
        .values({ pollId: poll.id, optionId, userId: session.userId })
        .onConflictDoNothing();
    }

    const fresh = await loadPollsForPosts([postId], session.userId);
    return NextResponse.json({ poll: fresh.get(postId) ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message, postId });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const poll = await getPollByPostId(postId);
    if (!poll) {
      return NextResponse.json({ error: 'Poll not found' }, { status: 404 });
    }
    if (poll.closesAt && poll.closesAt.getTime() < Date.now()) {
      return NextResponse.json({ error: 'Poll is closed' }, { status: 409 });
    }
    await db
      .delete(pollVotes)
      .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.userId, session.userId)));
    const fresh = await loadPollsForPosts([postId], session.userId);
    return NextResponse.json({ poll: fresh.get(postId) ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in DELETE', { error: message, postId });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
