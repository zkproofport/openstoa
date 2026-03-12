import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { logger } from '@/lib/logger';

const ROUTE = '/api/upload';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

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

function getS3() {
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

    const { s3, config } = getS3();
    const env = process.env.APP_ENV === 'production' ? 'production' : 'staging';

    const VALID_PURPOSES = ['post', 'topic', 'avatar'] as const;
    type Purpose = (typeof VALID_PURPOSES)[number];
    const resolvedPurpose: Purpose = VALID_PURPOSES.includes(purpose) ? purpose : 'post';
    const purposeFolder = resolvedPurpose === 'post' ? 'posts' : resolvedPurpose === 'topic' ? 'topics' : 'avatars';
    const key = `${env}/${purposeFolder}/${session.userId}/${randomUUID()}/${filename}`;

    const metadata: Record<string, string> = {};
    if (typeof width === 'number') metadata['width'] = String(width);
    if (typeof height === 'number') metadata['height'] = String(height);

    logger.info(ROUTE, 'Generating presigned URL', { userId: session.userId, key, contentType, purpose: resolvedPurpose, width, height });

    const command = new PutObjectCommand({
      Bucket: config.R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
      ...(Object.keys(metadata).length > 0 ? { Metadata: metadata } : {}),
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 600 });
    const publicUrl = `${config.R2_PUBLIC_URL}/${key}`;

    logger.info(ROUTE, 'Presigned URL generated', { userId: session.userId, key });
    return NextResponse.json({ uploadUrl, publicUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
