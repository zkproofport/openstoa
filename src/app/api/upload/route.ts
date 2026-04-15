import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { uploadToR2, type UploadPurpose } from '@/lib/r2';
import { logger } from '@/lib/logger';

const ROUTE = '/api/upload';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * @openapi
 * /api/upload:
 *   post:
 *     tags: [Upload]
 *     summary: Upload image file
 *     description: >-
 *       Uploads an image file directly to the CDN via the server. Send the file as
 *       multipart/form-data. Returns the permanent public URL for the uploaded image.
 *     operationId: uploadImage
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Image file to upload (image/* MIME types only, max 10MB)
 *               purpose:
 *                 type: string
 *                 enum: [post, topic, avatar]
 *                 description: Upload purpose for path organization (default: post)
 *     responses:
 *       200:
 *         description: File uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 publicUrl:
 *                   type: string
 *                   description: Permanent public URL for the uploaded file
 *       400:
 *         description: Invalid request (missing file, wrong MIME type, or file too large)
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

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      logger.warn(ROUTE, 'Failed to parse multipart/form-data', { userId: session.userId });
      return NextResponse.json({ error: 'Request must be multipart/form-data' }, { status: 400 });
    }

    const file = formData.get('file');
    if (!file || !(file instanceof File)) {
      logger.warn(ROUTE, 'Missing file field', { userId: session.userId });
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }

    const contentType = file.type;
    if (!contentType || !contentType.startsWith('image/')) {
      logger.warn(ROUTE, 'Invalid contentType', { userId: session.userId, contentType });
      return NextResponse.json({ error: 'Only image uploads are supported' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      logger.warn(ROUTE, 'File too large', { userId: session.userId, size: file.size });
      return NextResponse.json({ error: 'File size must not exceed 10MB' }, { status: 400 });
    }

    const VALID_PURPOSES: UploadPurpose[] = ['post', 'topic', 'avatar'];
    const purposeField = formData.get('purpose');
    const resolvedPurpose: UploadPurpose =
      typeof purposeField === 'string' && VALID_PURPOSES.includes(purposeField as UploadPurpose)
        ? (purposeField as UploadPurpose)
        : 'post';

    const buffer = Buffer.from(await file.arrayBuffer());

    logger.info(ROUTE, 'Uploading file to R2', {
      userId: session.userId,
      contentType,
      purpose: resolvedPurpose,
      size: file.size,
      filename: file.name,
    });

    const publicUrl = await uploadToR2(buffer, contentType, session.userId, resolvedPurpose, file.name || undefined);

    logger.info(ROUTE, 'Upload complete', { userId: session.userId, publicUrl });
    return NextResponse.json({ publicUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
