import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/profile/image';

/**
 * @openapi
 * /api/profile/image:
 *   get:
 *     tags: [Profile]
 *     summary: Get profile image
 *     description: Returns the current user's profile image URL.
 *     operationId: getProfileImage
 *     responses:
 *       200:
 *         description: Profile image URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 profileImage:
 *                   type: string
 *                   nullable: true
 *                   description: Profile image URL, or null if not set
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *   put:
 *     tags: [Profile]
 *     summary: Set profile image
 *     description: >-
 *       Sets the user's profile image URL. Use the /api/upload endpoint first to upload the image
 *       and get the public URL.
 *     operationId: setProfileImage
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [imageUrl]
 *             properties:
 *               imageUrl:
 *                 type: string
 *                 description: Public URL of the uploaded image (from /api/upload)
 *     responses:
 *       200:
 *         description: Profile image updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                   description: Update success indicator
 *                 profileImage:
 *                   type: string
 *                   description: Updated profile image URL
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *   delete:
 *     tags: [Profile]
 *     summary: Remove profile image
 *     description: Removes the user's profile image.
 *     operationId: deleteProfileImage
 *     responses:
 *       200:
 *         description: Profile image removed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                   description: Deletion success indicator
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const rows = await db
      .select({ profileImage: users.profileImage })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    const profileImage = rows[0]?.profileImage ?? null;
    return NextResponse.json({ profileImage });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  logger.info(ROUTE, 'PUT request received');
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json();
    const { imageUrl } = body;

    if (!imageUrl || typeof imageUrl !== 'string') {
      return NextResponse.json({ error: 'imageUrl is required and must be a string' }, { status: 400 });
    }

    await db
      .update(users)
      .set({ profileImage: imageUrl })
      .where(eq(users.id, session.userId));

    logger.info(ROUTE, 'Profile image updated', { userId: session.userId });
    return NextResponse.json({ success: true, profileImage: imageUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in PUT', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  logger.info(ROUTE, 'DELETE request received');
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    await db
      .update(users)
      .set({ profileImage: null })
      .where(eq(users.id, session.userId));

    logger.info(ROUTE, 'Profile image removed', { userId: session.userId });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in DELETE', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
