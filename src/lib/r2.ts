import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { logger } from '@/lib/logger';

const MODULE = 'lib/r2';

function getR2Config() {
  const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
  const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
  const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
  const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
  const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
    throw new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, and R2_PUBLIC_URL environment variables are required');
  }

  return { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL };
}

let _s3: S3Client | null = null;
let _config: ReturnType<typeof getR2Config> | null = null;

export function getR2Client() {
  if (!_s3) {
    _config = getR2Config();
    _s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${_config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: _config.R2_ACCESS_KEY_ID,
        secretAccessKey: _config.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return { s3: _s3, config: _config! };
}

export type UploadPurpose = 'post' | 'topic' | 'avatar';

const PURPOSE_FOLDER: Record<UploadPurpose, string> = {
  post: 'posts',
  topic: 'topics',
  avatar: 'avatars',
};

/**
 * Upload a buffer directly to R2 and return the public URL.
 */
export async function uploadToR2(
  buffer: Buffer,
  contentType: string,
  userId: string,
  purpose: UploadPurpose,
  filename?: string,
): Promise<string> {
  const { s3, config } = getR2Client();
  const env = process.env.APP_ENV === 'production' ? 'production' : 'staging';
  const resolvedFilename = filename ?? `inline-${randomUUID()}.${extensionFromContentType(contentType)}`;
  const key = `${env}/${PURPOSE_FOLDER[purpose]}/${userId}/${randomUUID()}/${resolvedFilename}`;

  logger.info(MODULE, 'Uploading buffer to R2', { key, contentType, size: buffer.length });

  const command = new PutObjectCommand({
    Bucket: config.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
    Body: buffer,
  });

  await s3.send(command);

  const publicUrl = `${config.R2_PUBLIC_URL}/${key}`;
  logger.info(MODULE, 'Upload complete', { key, publicUrl });
  return publicUrl;
}

/**
 * Delete a single R2 object by its public URL. Only deletes objects served from
 * our own R2 bucket (matching `R2_PUBLIC_URL` prefix) — external URLs (YouTube
 * thumbs, external CDNs, base64 data URIs) are silently skipped so a stray URL
 * in post media doesn't blow up the cleanup path.
 *
 * Returns true when a DeleteObject call was actually issued (regardless of
 * whether the key existed — S3/R2 DeleteObject is idempotent).
 */
export async function deleteFromR2ByUrl(url: string): Promise<boolean> {
  if (typeof url !== 'string' || !url) return false;
  let client;
  try {
    client = getR2Client();
  } catch (err) {
    logger.warn(MODULE, 'R2 not configured — skipping delete', { url });
    return false;
  }
  const { s3, config } = client;
  const prefix = `${config.R2_PUBLIC_URL}/`;
  if (!url.startsWith(prefix)) {
    logger.info(MODULE, 'URL is not an R2 object — skipping delete', { url });
    return false;
  }
  const key = url.slice(prefix.length);
  if (!key) return false;

  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: config.R2_BUCKET_NAME,
        Key: key,
      }),
    );
    logger.info(MODULE, 'Deleted R2 object', { key });
    return true;
  } catch (err) {
    logger.error(MODULE, 'Failed to delete R2 object', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Diff two image URL lists and delete every URL that was present in `previous`
 * but is missing from `next`. Used by PATCH /api/posts/[postId] (image swap)
 * and DELETE /api/posts/[postId] (`next = []`).
 *
 * Returns the count of delete attempts issued (skipped external URLs do not
 * count).
 */
export async function deleteOrphanedR2Urls(
  previous: readonly string[] | null | undefined,
  next: readonly string[] | null | undefined,
): Promise<number> {
  const prevSet = new Set((previous ?? []).filter((u): u is string => typeof u === 'string' && u.length > 0));
  const nextSet = new Set((next ?? []).filter((u): u is string => typeof u === 'string' && u.length > 0));
  const orphans: string[] = [];
  for (const url of prevSet) {
    if (!nextSet.has(url)) orphans.push(url);
  }
  if (orphans.length === 0) return 0;

  let deleted = 0;
  // Sequential so a slow / failing R2 doesn't fan out N concurrent retries.
  // Image lists are capped at MAX_IMAGES=10 so this is bounded.
  for (const url of orphans) {
    const ok = await deleteFromR2ByUrl(url);
    if (ok) deleted++;
  }
  logger.info(MODULE, 'Orphan R2 cleanup complete', { attempted: orphans.length, deleted });
  return deleted;
}

function extensionFromContentType(contentType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  };
  return map[contentType] ?? 'bin';
}
