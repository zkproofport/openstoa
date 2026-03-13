import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
 * Generate a presigned upload URL and the resulting public URL.
 */
export async function getPresignedUploadUrl(opts: {
  filename: string;
  contentType: string;
  userId: string;
  purpose: UploadPurpose;
  metadata?: Record<string, string>;
}): Promise<{ uploadUrl: string; publicUrl: string }> {
  const { s3, config } = getR2Client();
  const env = process.env.APP_ENV === 'production' ? 'production' : 'staging';
  const key = `${env}/${PURPOSE_FOLDER[opts.purpose]}/${opts.userId}/${randomUUID()}/${opts.filename}`;

  const command = new PutObjectCommand({
    Bucket: config.R2_BUCKET_NAME,
    Key: key,
    ContentType: opts.contentType,
    CacheControl: 'public, max-age=31536000, immutable',
    ...(opts.metadata && Object.keys(opts.metadata).length > 0 ? { Metadata: opts.metadata } : {}),
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 600 });
  const publicUrl = `${config.R2_PUBLIC_URL}/${key}`;

  return { uploadUrl, publicUrl };
}

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
