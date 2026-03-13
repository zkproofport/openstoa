import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getPresignedUploadUrl, type UploadPurpose } from '@/lib/r2';
import { logger } from '@/lib/logger';

const ROUTE = '/api/upload';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * @openapi
 * /api/upload:
 *   post:
 *     tags: [Upload]
 *     summary: Get presigned upload URL
 *     description: >-
 *       Generates an R2 presigned URL for direct file upload. The client uploads the file directly
 *       to R2 using the returned uploadUrl (PUT request with the file as body), then uses the
 *       publicUrl in subsequent API calls.
 *     operationId: createUploadUrl
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [filename, contentType]
 *             properties:
 *               filename:
 *                 type: string
 *                 description: Original filename
 *               contentType:
 *                 type: string
 *                 description: MIME type (must start with "image/")
 *               size:
 *                 type: number
 *                 description: File size in bytes (optional)
 *               purpose:
 *                 type: string
 *                 enum: [post, topic, avatar]
 *                 description: Upload purpose for path organization
 *               width:
 *                 type: number
 *                 description: Image width in pixels (optional)
 *               height:
 *                 type: number
 *                 description: Image height in pixels (optional)
 *     responses:
 *       200:
 *         description: Presigned upload URL generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 uploadUrl:
 *                   type: string
 *                   description: Presigned PUT URL for direct upload (10 min TTL)
 *                 publicUrl:
 *                   type: string
 *                   description: Permanent public URL for the uploaded file
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function POST(request: NextRequest) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json();
    const { filename, contentType, size, purpose, width, height } = body;

    if (!filename || typeof filename !== 'string') {
      logger.warn(ROUTE, 'Missing filename', { userId: session.userId });
      return NextResponse.json({ error: 'filename is required' }, { status: 400 });
    }

    if (!contentType || typeof contentType !== 'string') {
      logger.warn(ROUTE, 'Missing contentType', { userId: session.userId });
      return NextResponse.json({ error: 'contentType is required' }, { status: 400 });
    }

    if (!contentType.startsWith('image/')) {
      logger.warn(ROUTE, 'Invalid contentType', { userId: session.userId, contentType });
      return NextResponse.json({ error: 'Only image uploads are supported' }, { status: 400 });
    }

    if (typeof size === 'number' && size > MAX_FILE_SIZE) {
      logger.warn(ROUTE, 'File too large', { userId: session.userId, size });
      return NextResponse.json({ error: 'File size must not exceed 10MB' }, { status: 400 });
    }

    const VALID_PURPOSES: UploadPurpose[] = ['post', 'topic', 'avatar'];
    const resolvedPurpose: UploadPurpose = VALID_PURPOSES.includes(purpose) ? purpose : 'post';

    const metadata: Record<string, string> = {};
    if (typeof width === 'number') metadata['width'] = String(width);
    if (typeof height === 'number') metadata['height'] = String(height);

    logger.info(ROUTE, 'Generating presigned URL', { userId: session.userId, contentType, purpose: resolvedPurpose, width, height });

    const { uploadUrl, publicUrl } = await getPresignedUploadUrl({
      filename,
      contentType,
      userId: session.userId,
      purpose: resolvedPurpose,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });

    logger.info(ROUTE, 'Presigned URL generated', { userId: session.userId, publicUrl });
    return NextResponse.json({ uploadUrl, publicUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
