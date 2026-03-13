import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { reactions } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/posts/[postId]/reactions';

const ALLOWED_EMOJIS = ['👍', '❤️', '🔥', '😂', '🎉', '😮'];

/**
 * @openapi
 * /api/posts/{postId}/reactions:
 *   get:
 *     tags: [Reactions]
 *     summary: Get reactions on post
 *     description: >-
 *       Returns all emoji reactions on a post, grouped by emoji with counts and whether the
 *       current user has reacted.
 *     operationId: getReactions
 *     parameters:
 *       - name: postId
 *         in: path
 *         required: true
 *         description: Post ID
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Reaction summaries grouped by emoji
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 reactions:
 *                   type: array
 *                   description: Reactions grouped by emoji
 *                   items:
 *                     $ref: '#/components/schemas/ReactionSummary'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *   post:
 *     tags: [Reactions]
 *     summary: Toggle emoji reaction on post
 *     description: >-
 *       Toggles an emoji reaction on a post. Reacting with the same emoji again removes it.
 *       Only 6 emojis are allowed.
 *     operationId: toggleReaction
 *     parameters:
 *       - name: postId
 *         in: path
 *         required: true
 *         description: Post ID
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [emoji]
 *             properties:
 *               emoji:
 *                 type: string
 *                 description: "Emoji character (allowed: thumbs up, heart, fire, laughing, party, surprised)"
 *     responses:
 *       200:
 *         description: Reaction toggled
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 added:
 *                   type: boolean
 *                   description: True if reaction was added, false if removed
 *       400:
 *         description: Invalid emoji
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error400'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { postId } = await params;

    // Get reaction counts grouped by emoji, and whether current user reacted
    const rows = await db
      .select({
        emoji: reactions.emoji,
        count: sql<number>`count(distinct ${reactions.userId})::int`,
        userReacted: sql<boolean>`bool_or(${reactions.userId} = ${session.userId})`,
      })
      .from(reactions)
      .where(eq(reactions.postId, postId))
      .groupBy(reactions.emoji);

    logger.info(ROUTE, 'Reactions fetched', { postId, count: rows.length });
    return NextResponse.json({ reactions: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { postId } = await params;
    const body = await request.json();
    const { emoji } = body;

    if (!emoji || !ALLOWED_EMOJIS.includes(emoji)) {
      logger.warn(ROUTE, 'Invalid emoji', { userId: session.userId, postId, emoji });
      return NextResponse.json({ error: 'Invalid emoji' }, { status: 400 });
    }

    // Check if reaction already exists
    const existing = await db.query.reactions.findFirst({
      where: and(
        eq(reactions.userId, session.userId),
        eq(reactions.postId, postId),
        eq(reactions.emoji, emoji),
      ),
    });

    if (existing) {
      // Remove reaction
      await db
        .delete(reactions)
        .where(
          and(
            eq(reactions.userId, session.userId),
            eq(reactions.postId, postId),
            eq(reactions.emoji, emoji),
          ),
        );
      logger.info(ROUTE, 'Reaction removed', { userId: session.userId, postId, emoji });
      return NextResponse.json({ added: false });
    } else {
      // Add reaction
      await db.insert(reactions).values({
        userId: session.userId,
        postId,
        emoji,
      });
      logger.info(ROUTE, 'Reaction added', { userId: session.userId, postId, emoji });
      return NextResponse.json({ added: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
