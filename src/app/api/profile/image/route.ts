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
 *     description: |
 *       Returns `{ profileImage: string | null }` for the calling user — the absolute CDN
 *       URL used as their avatar across topics/posts/chat. Returns `null` if not set.
 *       Update with `PUT /api/profile/image` (pass the URL from `POST /api/upload`), remove
 *       with `DELETE /api/profile/image`.
 *     operationId: getProfileImage
 *     x-related-skills: [set-profile-image]
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
 *     description: |
 *       Sets the calling user's avatar to the supplied CDN URL. Workflow: upload the file
 *       via `POST /api/upload` (`purpose=avatar` is the conventional value), receive
 *       `{ publicUrl }`, then PUT that URL here as `imageUrl`. The URL is shown on every
 *       post / comment / chat message authored by the user.
 *     operationId: setProfileImage
 *     x-related-skills: [upload-image, get-profile-image, delete-profile-image]
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
 *     description: |
 *       Clears the calling user's avatar URL (sets `profileImage` to `null`). The original
 *       file on the CDN is NOT deleted — call `DELETE /api/upload` with the URL if you
 *       want to free the storage. Subsequent posts/chat render the default avatar.
 *     operationId: deleteProfileImage
 *     x-related-skills: [set-profile-image, get-profile-image]
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

    const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
    if (!R2_PUBLIC_URL) throw new Error('R2_PUBLIC_URL environment variable is required');
    if (!imageUrl.startsWith(R2_PUBLIC_URL)) {
      logger.warn(ROUTE, 'Invalid imageUrl domain', { userId: session.userId, imageUrl });
      return NextResponse.json({ error: 'Image URL must be from the upload CDN' }, { status: 400 });
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
