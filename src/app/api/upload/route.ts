import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { uploadToR2, deleteFromR2ByUrl, isMissingR2ConfigError, type UploadPurpose } from '@/lib/r2';
import {
  OBJECT_STORAGE_UNCONFIGURED_MESSAGE,
  OBJECT_STORAGE_UNCONFIGURED_STATUS,
} from '@/lib/objectStorageStatus';
import { db } from '@/lib/db';
import { topicMembers } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { stripImageMetadata, ImageMetadataError } from '@/lib/imageMetadata';
import { loadSharp } from '@/lib/sharpModule';

const ROUTE = '/api/upload';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 *
 *
 *       **Metadata is stripped before the image is published.** GPS coordinates,
 *       capture timestamps (`DateTimeOriginal`/`CreateDate`/`ModifyDate`), camera
 *       make/model/lens/serial number, `Software`, MakerNotes, any embedded
 *       thumbnail, and XMP/IPTC blocks are removed from JPEG, PNG, WebP, GIF and
 *       SVG uploads. The ICC colour profile is kept, and image orientation is
 *       preserved, so the picture still renders upright with correct colours.
 *       The pixels themselves are not re-encoded for those formats, so the file
 *       is not degraded and does not grow. Do not rely on the API to carry EXIF
 *       through: an agent that needs capture time or location must put it in the
 *       post body itself. An image whose container cannot be parsed is rejected
 *       with 400 rather than published with its metadata intact.
 *
 *
 *       **An SVG is also stripped of anything that can run.** `<script>`, `on*` handlers,
 *       `<foreignObject>`, `<set>`/`<animate>` (which can create a handler after the fact) and
 *       `javascript:`/`data:` links are removed; the drawing is left alone. The served copy also
 *       carries a Content-Security-Policy that forbids script. An agent embedding an SVG should
 *       expect the picture back, not the behaviour.
 *
 *
 *       **The filename is a label, not a path.** Directory separators and control characters are
 *       removed and the name is capped (the extension is kept); a name with nothing usable left
 *       gets a generated one. The upload still succeeds — only the last segment of the returned
 *       `publicUrl` differs from what was sent, so read the URL from the response rather than
 *       building it from the filename.
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
 *                 description: "What the image is for (default: post). Decides which folder it lands in."
 *               topicId:
 *                 type: string
 *                 format: uuid
 *                 description: >-
 *                   The topic this image belongs to. **Send it whenever you have one.** Objects
 *                   are stored partitioned by topic (`topics/{topicId}/…`), and deleting a topic
 *                   deletes everything under that prefix — so an image uploaded WITHOUT a topicId
 *                   survives the deletion of the topic it was posted in, forever. You must be a
 *                   member of the topic: a topicId you are not in is refused with 403, and a
 *                   malformed one with 400 (it is never silently ignored). Omit it only when there
 *                   is genuinely no topic yet — a profile picture (`purpose=avatar`), or the image
 *                   for a topic you have not created yet.
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
 *         description: >-
 *           Invalid request (missing file, wrong MIME type, file too large, malformed
 *           topicId, or an image whose bytes could not be parsed to strip metadata)
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: The caller is not a member of the topic named in `topicId`
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

    /*
     * WHICH TOPIC this object belongs to, so it lands under `topics/{id}/` and
     * a topic deletion can reach it with one prefix sweep. Optional, because
     * two real callers have no topic to name: the topic-CREATION image (the
     * topic does not exist yet) and an agent uploading before it has chosen
     * where to post. Those go under `users/{id}/uploads/` and are outside the
     * sweep — stated in AGENTS.md rather than hidden.
     *
     * MEMBERSHIP IS CHECKED, not trusted. Without it any signed-in account
     * could file objects under any topic's prefix: junk another topic's
     * storage, and have it deleted by a topic deletion they do not control.
     * A bad topicId is refused (400/403) rather than silently downgraded to the
     * user path — a caller that names a topic is making a claim, and a claim
     * that is wrong should be corrected, not quietly reinterpreted.
     */
    const topicIdField = formData.get('topicId');
    let resolvedTopicId: string | null = null;
    if (typeof topicIdField === 'string' && topicIdField.length > 0) {
      if (!UUID_RE.test(topicIdField)) {
        logger.warn(ROUTE, 'Malformed topicId', { userId: session.userId, topicId: topicIdField });
        return NextResponse.json({ error: 'topicId must be a uuid' }, { status: 400 });
      }
      const membership = await db.query.topicMembers.findFirst({
        where: and(
          eq(topicMembers.topicId, topicIdField),
          eq(topicMembers.userId, session.userId),
        ),
      });
      if (!membership) {
        logger.warn(ROUTE, 'Upload into a topic the caller is not in', {
          userId: session.userId,
          topicId: topicIdField,
        });
        return NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 });
      }
      resolvedTopicId = topicIdField;
    }

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
        // Pipe through sharp when available to normalise the JPEG. Metadata
        // removal is NOT this step's job — it happens unconditionally below,
        // for every format, so it cannot be skipped when sharp is missing.
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

    /*
     * SCRUB THE METADATA. Unconditional, and deliberately independent of the
     * size check and of the HEIC branch above: Signal shipped years of GPS
     * leaks precisely because its strip was a side effect of "the image was
     * big enough to need resizing". A camera JPEG carries GPS coordinates,
     * capture time to the second, the camera's serial number and an embedded
     * thumbnail that survives cropping — publishing those next to a
     * pseudonymous post deanonymises the poster. Policy and evidence:
     * `docs/design/image-metadata-policy.md`.
     *
     * FAILS CLOSED: if the bytes cannot be cleaned, nothing is uploaded.
     */
    try {
      const stripped = await stripImageMetadata(buffer);
      logger.info(ROUTE, 'Image metadata stripped', {
        userId: session.userId,
        format: stripped.format,
        strategy: stripped.strategy,
        sizeBefore: buffer.length,
        sizeAfter: stripped.buffer.length,
      });
      buffer = stripped.buffer;
    } catch (err) {
      const reason = err instanceof ImageMetadataError ? err.reason : 'unknown';
      logger.warn(ROUTE, 'Image metadata strip failed — refusing the upload', {
        userId: session.userId,
        contentType,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
      if (reason === 'unsupported') {
        // The server, not the file, is at fault: we could not load the codec.
        return NextResponse.json(
          { error: 'Could not process this image on the server. Please try again later.' },
          { status: 500 },
        );
      }
      return NextResponse.json(
        { error: 'Could not read this image. It may be corrupt or in an unsupported format.' },
        { status: 400 },
      );
    }

    logger.info(ROUTE, 'Uploading file to R2', {
      userId: session.userId,
      contentType,
      purpose: resolvedPurpose,
      topicId: resolvedTopicId,
      size: buffer.length,
      filename,
    });

    const publicUrl = await uploadToR2(buffer, contentType, session.userId, resolvedPurpose, filename, resolvedTopicId);

    logger.info(ROUTE, 'Upload complete', { userId: session.userId, publicUrl });
    return NextResponse.json({ publicUrl });
  } catch (error) {
    /*
     * "Never configured" is not "faulted", and 500 said the wrong one.
     *
     * A deployment with no object-storage credentials is not a server that
     * broke handling this request — it is a server that was never able to serve
     * it. 503 says that; 500 claims a fault and sends whoever is debugging to
     * look for one. It cost exactly that: an environment rebuilt without the
     * R2/MinIO vars produced ten failures across eight files, every one of them
     * pointing at application behaviour.
     *
     * The body names a CLASS and nothing else — no variable names, no values,
     * no stack. The five variable names stay in the log, where
     * `unhandledRouteError` was already right to keep them. This narrow catch
     * sits ABOVE that generic handler rather than inside it, so no other route
     * changes and nothing else about error reporting moves.
     *
     * The E2E suite keys on this STATUS to skip when storage is absent
     * (`isMissingR2Credentials`, src/__tests__/e2e/helpers.ts). That is the
     * contract now: the sentence in `lib/r2.ts` may be reworded freely, this
     * 503 may not.
     */
    if (isMissingR2ConfigError(error)) {
      // The five variable names go HERE, untruncated, and nowhere else. No
      // session lookup: re-reading the request inside a catch can throw on its
      // own, and which account hit an unconfigured server is not the useful
      // half of this line.
      logger.error(ROUTE, 'Upload refused — object storage is not configured', {
        detail: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: OBJECT_STORAGE_UNCONFIGURED_MESSAGE },
        { status: OBJECT_STORAGE_UNCONFIGURED_STATUS },
      );
    }
    return unhandledRouteError(ROUTE, 'POST', error);
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
    return unhandledRouteError(ROUTE, 'DELETE', error);
  }
}
