import { uploadToR2 } from '@/lib/r2';
import { logger } from '@/lib/logger';

const MODULE = 'lib/base64-upload';

const MAX_BASE64_SIZE = 10 * 1024 * 1024; // 10MB decoded

// Matches <img src="data:image/TYPE;base64,DATA"> with single or double quotes
const BASE64_IMG_REGEX = /(<img\s[^>]*?src=["'])data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)(["'][^>]*?>)/gi;

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  'svg+xml': 'image/svg+xml',
};

/**
 * Extract base64-encoded images from HTML content, upload them to R2,
 * and replace the data URIs with CDN URLs.
 */
export async function extractAndUploadBase64Images(
  content: string,
  userId: string,
): Promise<string> {
  const matches: Array<{
    fullMatch: string;
    prefix: string;
    imageType: string;
    base64Data: string;
    suffix: string;
  }> = [];

  let match: RegExpExecArray | null;
  // Reset regex state
  BASE64_IMG_REGEX.lastIndex = 0;
  while ((match = BASE64_IMG_REGEX.exec(content)) !== null) {
    matches.push({
      fullMatch: match[0],
      prefix: match[1],
      imageType: match[2],
      base64Data: match[3],
      suffix: match[4],
    });
  }

  if (matches.length === 0) {
    return content;
  }

  logger.info(MODULE, 'Found base64 images in content', { count: matches.length, userId });

  let result = content;

  for (const m of matches) {
    try {
      const buffer = Buffer.from(m.base64Data, 'base64');

      if (buffer.length > MAX_BASE64_SIZE) {
        logger.warn(MODULE, 'Skipping oversized base64 image', {
          userId,
          size: buffer.length,
          imageType: m.imageType,
        });
        continue;
      }

      const contentType = MIME_MAP[m.imageType] ?? `image/${m.imageType}`;
      const publicUrl = await uploadToR2(buffer, contentType, userId, 'post');

      const replacement = `${m.prefix}${publicUrl}${m.suffix}`;
      result = result.replace(m.fullMatch, replacement);

      logger.info(MODULE, 'Replaced base64 image with CDN URL', {
        userId,
        imageType: m.imageType,
        size: buffer.length,
        publicUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(MODULE, 'Failed to upload base64 image', {
        userId,
        imageType: m.imageType,
        error: message,
      });
      // Leave the original base64 data URI in place on failure
    }
  }

  return result;
}
