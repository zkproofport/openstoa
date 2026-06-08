import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { uploadToR2, deleteFromR2ByUrl, type UploadPurpose } from '@/lib/r2';
import { logger } from '@/lib/logger';

const ROUTE = '/api/upload';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// HEIC/HEIF container brands at bytes 4..12 of an ISO BMFF file. iPhone
// Photos can hand the mobile picker raw HEIC bytes even when the picker
// reports a `.jpg` filename — browsers can't decode HEIC, so we sniff and
// re-encode server-side as a defense-in-depth backstop for the mobile fix.
const HEIC_FTYP_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1',
]);

function isHeicBuffer(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // ISO BMFF: bytes 4..8 == 'ftyp', bytes 8..12 == brand
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('ascii', 8, 12);
  return HEIC_FTYP_BRANDS.has(brand);
}

// Lazy-load sharp so the route doesn't blow up at import time if the
// native binary is missing on this platform (e.g. unusual Docker base).
type SharpModule = typeof import('sharp');
function loadSharp(): SharpModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('sharp') as SharpModule;
  } catch {
    return null;
  }
}

// Lazy-load heic-convert (WASM libheif). Cloud Run's libvips lacks the HEIC
// codec, so sharp alone can't decode HEIC — we decode via heic-convert first.
type HeicConvertFn = (opts: { buffer: Buffer; format: 'JPEG' | 'PNG'; quality?: number }) => Promise<ArrayBuffer>;
function loadHeicConvert(): HeicConvertFn | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('heic-convert') as HeicConvertFn;
  } catch {
    return null;
  }
}

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
 *     x-related-skills: [delete-uploaded-images, create-post, edit-post, set-profile-image, create-topic]
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
 *                 description: "Upload purpose for path organization (default: post)"
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

    let contentType = file.type;
    // Accept HEIC even if client reported image/jpeg (iPhone often misreports);
    // we'll sniff bytes below.
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

    let buffer: Buffer = Buffer.from(await file.arrayBuffer());
    let filename = file.name || undefined;

    // Memory-conservative path: sniff HEIC from first 12 bytes. Only HEIC
    // bytes go through heic-convert (WASM) + sharp (libvips). JPEG/PNG/etc.
    // stream to R2 unchanged — avoids sharp re-encode cost on already-OK
    // images that previously OOM'd Cloud Run (512Mi -> 530Mi observed).
    const heicDetected = isHeicBuffer(buffer);
    if (heicDetected) {
      const heicConvert = loadHeicConvert();
      const sharp = loadSharp();
      try {
        if (!heicConvert) {
          throw new Error('heic-convert module unavailable');
        }
        const jpegArr = await heicConvert({ buffer, format: 'JPEG', quality: 0.85 });
        let jpegBuf: Buffer = Buffer.from(jpegArr);
        // Pipe through sharp when available to normalise/strip metadata.
        if (sharp) {
          jpegBuf = Buffer.from(await sharp(jpegBuf).jpeg({ quality: 85 }).toBuffer());
        }
        buffer = jpegBuf;
        contentType = 'image/jpeg';
        if (filename) {
          filename = filename.replace(/\.(heic|heif|jpg|jpeg)$/i, '') + '.jpg';
        }
        logger.info(ROUTE, 'HEIC converted to JPEG', {
          userId: session.userId,
          newSize: buffer.length,
        });
      } catch (err) {
        logger.error(ROUTE, 'HEIC→JPEG conversion failed', {
          userId: session.userId,
          error: err instanceof Error ? err.message : String(err),
        });
        // 500 (not 400) — the bytes were a valid HEIC upload; the server
        // couldn't process them. Friendlier message for the client.
        return NextResponse.json(
          { error: 'Could not process HEIC photo. Please try a different image or convert it to JPEG before uploading.' },
          { status: 500 },
        );
      }
    }

    logger.info(ROUTE, 'Uploading file to R2', {
      userId: session.userId,
      contentType,
      purpose: resolvedPurpose,
      size: buffer.length,
      filename,
    });

    const publicUrl = await uploadToR2(buffer, contentType, session.userId, resolvedPurpose, filename);

    logger.info(ROUTE, 'Upload complete', { userId: session.userId, publicUrl });
    return NextResponse.json({ publicUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/upload:
 *   delete:
 *     tags: [Upload]
 *     summary: Delete uploaded images (draft cleanup)
 *     description: >-
 *       Deletes one or more uploaded R2 images. Used by the mobile compose
 *       screen on **Reset** / cancel-with-staged-images so files uploaded for
 *       an abandoned draft don't pile up in R2. Each URL is authorised by
 *       matching the `/{env}/{folder}/{userId}/` prefix against the caller's
 *       session — users can only delete their own uploads. URLs that don't
 *       resolve to an R2 object (external CDNs, base64 data URIs) are
 *       silently skipped.
 *     operationId: deleteUploadedImages
 *     x-related-skills: [upload-image]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [urls]
 *             properties:
 *               urls:
 *                 type: array
 *                 items: { type: string }
 *                 description: Image URLs returned by POST /api/upload
 *     responses:
 *       200:
 *         description: Deletion summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 attempted: { type: integer }
 *                 deleted: { type: integer }
 *                 skipped: { type: integer }
 *       400: { description: Invalid request body }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
export async function DELETE(request: NextRequest) {
  logger.info(ROUTE, 'DELETE request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated DELETE request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
    }
    const urls = (body as { urls?: unknown })?.urls;
    if (!Array.isArray(urls)) {
      return NextResponse.json({ error: 'urls must be an array' }, { status: 400 });
    }
    const candidates = urls.filter((u): u is string => typeof u === 'string' && u.length > 0);

    let deleted = 0;
    let skipped = 0;
    // R2 key shape (see uploadToR2): `{env}/{folder}/{userId}/{uuid}/{filename}`.
    // We use the userId segment to authorise deletes — a user can't wipe
    // another user's uploads even if they somehow obtained the URL.
    const userMarker = `/${session.userId}/`;
    for (const url of candidates) {
      if (!url.includes(userMarker)) {
        logger.warn(ROUTE, 'Skipping delete — URL not owned by caller', {
          userId: session.userId,
          url,
        });
        skipped++;
        continue;
      }
      const ok = await deleteFromR2ByUrl(url);
      if (ok) deleted++;
      else skipped++;
    }

    logger.info(ROUTE, 'Draft cleanup complete', {
      userId: session.userId,
      attempted: candidates.length,
      deleted,
      skipped,
    });
    return NextResponse.json({ attempted: candidates.length, deleted, skipped });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in DELETE', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
