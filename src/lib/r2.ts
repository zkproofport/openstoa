import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { logger } from '@/lib/logger';

const MODULE = 'lib/r2';

/**
 * Which S3 server to talk to.
 *
 * Unset means Cloudflare R2, addressed the way R2 addresses itself:
 * `https://{account}.r2.cloudflarestorage.com`, virtual-hosted style. That is
 * what staging and production have always built, and with this variable unset
 * the client they build is unchanged, account id and all.
 *
 * Set means a different server answering the same API — in practice the MinIO
 * that `scripts/dev.sh` starts, because a developer machine has no R2
 * credentials and encrypted attachments could not be exercised end to end
 * without an object store (S-1). It is deliberately NOT a fallback for missing
 * credentials: nothing is filled in when it is absent, and a local server is
 * named explicitly by whoever wants one.
 *
 * A local S3 server is addressed PATH style (`http://host:9000/bucket/key`),
 * since bucket-as-subdomain needs DNS a developer machine does not have.
 *
 * Returns null for unset, empty and whitespace-only alike: an env file that
 * writes `R2_ENDPOINT=` means "I am not using one", not "use the empty host",
 * which the SDK would turn into a connection error naming no host at all.
 */
function readEndpointOverride(): string | null {
  const raw = process.env.R2_ENDPOINT?.trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`R2_ENDPOINT must be an absolute URL (e.g. http://localhost:9000), got: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`R2_ENDPOINT must be http or https, got: ${parsed.protocol}`);
  }
  // A trailing slash makes the SDK build `http://host:9000//bucket`, which
  // answers 404 and reads like a missing bucket rather than a typo.
  return raw.replace(/\/+$/, '');
}

/**
 * The one sentence a caller sees when storage is not configured.
 *
 * SERVER-SIDE ONLY. This text names five environment variables, so it must
 * never reach a response body — it goes to the log, and the route answers with
 * a class, not a cause.
 *
 * It used to carry a second job: the E2E suite matched this literal to tell
 * "this deployment has no credentials" apart from a genuine upload fault, and
 * the comment here warned that rewording it would turn a blocked case into a
 * silent pass. The warning was sound and the channel was already broken — every
 * `/api/upload` failure goes through `unhandledRouteError`, whose body is
 * deliberately generic, so the literal never reached the test and the skip it
 * guarded could not fire. Two files kept carefully in sync, with a third in the
 * middle quietly making the contract unobservable.
 *
 * The suite now keys on the ROUTE's 503, not on this sentence — see
 * `isMissingR2Credentials` in `src/__tests__/e2e/helpers.ts`. This text is free
 * to change; that status is not.
 */
const MISSING_CONFIG_MESSAGE =
  'R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, and R2_PUBLIC_URL environment variables are required';

/**
 * Is this the "storage was never configured" failure, as opposed to a real
 * upload fault?
 *
 * Exported as a PREDICATE so callers do not re-match the sentence above and
 * quietly re-create the coupling that just broke. The thrown type is unchanged
 * — every existing bare `catch` in this file keeps behaving identically.
 */
export function isMissingR2ConfigError(error: unknown): boolean {
  return error instanceof Error && error.message === MISSING_CONFIG_MESSAGE;
}

function getR2Config() {
  const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
  const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
  const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
  const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
  const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
  const endpointOverride = readEndpointOverride();

  // The account id exists to build R2's hostname, so it is required exactly
  // when that hostname has to be built. Demanding it alongside an explicit
  // endpoint would demand a value that is then never read — which teaches
  // developers to invent one, and an invented account id in a real deployment
  // points at a bucket nobody owns.
  const accountIdRequired = endpointOverride === null;
  if (
    (accountIdRequired && !R2_ACCOUNT_ID) ||
    !R2_ACCESS_KEY_ID ||
    !R2_SECRET_ACCESS_KEY ||
    !R2_BUCKET_NAME ||
    !R2_PUBLIC_URL
  ) {
    throw new Error(MISSING_CONFIG_MESSAGE);
  }

  return {
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
    R2_PUBLIC_URL,
    endpoint: endpointOverride ?? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: endpointOverride !== null,
  };
}

let _s3: S3Client | null = null;
let _config: ReturnType<typeof getR2Config> | null = null;

export function getR2Client() {
  if (!_s3) {
    _config = getR2Config();
    _s3 = new S3Client({
      region: 'auto',
      endpoint: _config.endpoint,
      forcePathStyle: _config.forcePathStyle,
      credentials: {
        accessKeyId: _config.R2_ACCESS_KEY_ID,
        secretAccessKey: _config.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return { s3: _s3, config: _config! };
}

export type UploadPurpose = 'post' | 'topic' | 'avatar';

/**
 * OBJECT KEY LAYOUT — partitioned by TOPIC first, because deletion walks topics.
 *
 *   topics/{topicId}/chat/{userId}/{mediaId}.bin     encrypted chat attachment
 *   topics/{topicId}/posts/{uuid}/{filename}         image in a post
 *   topics/{topicId}/image/{uuid}/{filename}         the topic's own picture
 *   users/{userId}/profile/{uuid}/{filename}         profile image
 *   users/{userId}/uploads/{uuid}/{filename}         upload with no topic yet
 *
 * A key can only be prefix-partitioned along ONE dimension, and the one that
 * has to work is the one a hard delete walks. Deleting a topic is a hard delete
 * of everything in it; deleting an account is a SOFT delete that deliberately
 * keeps posts and comments (`/api/account`), so user-first partitioning bought
 * nothing that any deletion actually needed — and cost the thing that matters:
 * under the old `posts/{userId}/...` layout a topic's images were scattered
 * across every uploader's folder, so no prefix reached them and deleting a
 * topic left every picture in it behind, permanently.
 *
 * `users/{userId}/uploads/...` is the honest residue: an upload that happens
 * BEFORE its topic exists (the topic-creation image) or with no topic context
 * at all (an agent calling `POST /api/upload` bare) has no topic to be filed
 * under. Those objects are outside the topic sweep, by construction — see
 * `AGENTS.md`. Everything else is inside it.
 *
 * There is deliberately no `{postId}` segment. A post's images are uploaded
 * before the post exists, so a postId-bearing key would need a staging area and
 * a copy-on-create step — which buys nothing, because deleting ONE post deletes
 * its images by URL (`deleteRemovedImages`), never by prefix.
 */
/**
 * The folder INSIDE a topic partition. Not the partition itself — the old map
 * had `topic → 'topics'`, which read as a root and was part of why the missing
 * partition was hard to see: two different meanings of "topics" in one key.
 */
const TOPIC_SUBFOLDER: Record<Exclude<UploadPurpose, 'avatar'>, string> = {
  post: 'posts',
  topic: 'image',
};

/**
 * The folder inside a USER partition, for objects no topic owns: a profile
 * picture (`avatar`), or anything uploaded before its topic existed.
 */
const USER_SUBFOLDER = {
  avatar: 'profile',
  untopiced: 'uploads',
} as const;

/** Everything belonging to one topic — what a topic deletion must remove. */
export function topicObjectPrefix(topicId: string): string {
  return `topics/${topicId}/`;
}

/** Everything belonging to one user that is not filed under a topic. */
export function userObjectPrefix(userId: string): string {
  return `users/${userId}/`;
}

/**
 * Where an uploaded file is filed.
 *
 * `topicId` null means the caller had no topic to name — the object goes under
 * the uploader instead, and a topic sweep will not reach it. That is a real
 * outcome, not a fallback for convenience: it is why the upload route asks for
 * a topicId wherever one exists.
 */
export function uploadObjectKey(
  purpose: UploadPurpose,
  userId: string,
  topicId: string | null,
  filename: string,
): string {
  const unique = randomUUID();
  if (purpose === 'avatar' || !topicId) {
    const folder = purpose === 'avatar' ? USER_SUBFOLDER.avatar : USER_SUBFOLDER.untopiced;
    return `${userObjectPrefix(userId)}${folder}/${unique}/${filename}`;
  }
  return `${topicObjectPrefix(topicId)}${TOPIC_SUBFOLDER[purpose]}/${unique}/${filename}`;
}

/**
 * What kind of object a key names, for the gated read route (M-5) to decide
 * WHO may read it. Mirrors `uploadObjectKey`'s branches exactly — this is the
 * inverse of that function, not an independent guess at the shape.
 */
export type MediaKeyInfo =
  | { kind: 'topic-post'; topicId: string }
  | { kind: 'topic-image'; topicId: string }
  | { kind: 'avatar'; userId: string }
  | { kind: 'user-upload'; userId: string };

const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A session `userId` (nullifier). Permissive but excludes path-shaped chars. */
const USER_SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Classify a plaintext object key from its PATH SEGMENTS (already split on
 * `/`, as Next.js hands a catch-all route) — never from a joined string, so a
 * segment can never smuggle an extra `/` past this check the way a regex on
 * the raw path could.
 *
 * Returns null for anything that isn't exactly one of the five shapes
 * `uploadObjectKey` produces: wrong segment count, a segment that is empty or
 * `.`/`..`, a topicId/mediaId that isn't a real UUID, or a first segment that
 * is neither `topics` nor `users`. A key this rejects is refused with 400 by
 * the caller — fail closed, never "guess the closest shape and serve it".
 */
export function parseMediaObjectKey(segments: readonly string[]): MediaKeyInfo | null {
  if (segments.length !== 5) return null;
  if (segments.some((s) => !s || s === '.' || s === '..')) return null;
  const [root, ownerId, folder, unique, filename] = segments;
  if (!filename) return null;

  if (root === 'topics' && UUID_SEGMENT_RE.test(ownerId) && UUID_SEGMENT_RE.test(unique)) {
    if (folder === 'posts') return { kind: 'topic-post', topicId: ownerId };
    if (folder === 'image') return { kind: 'topic-image', topicId: ownerId };
    return null;
  }
  if (root === 'users' && USER_SEGMENT_RE.test(ownerId) && UUID_SEGMENT_RE.test(unique)) {
    if (folder === USER_SUBFOLDER.avatar) return { kind: 'avatar', userId: ownerId };
    if (folder === USER_SUBFOLDER.untopiced) return { kind: 'user-upload', userId: ownerId };
    return null;
  }
  return null;
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
  topicId?: string | null,
): Promise<string> {
  const { s3, config } = getR2Client();
  const resolvedFilename = filename ?? `inline-${randomUUID()}.${extensionFromContentType(contentType)}`;
  const key = uploadObjectKey(purpose, userId, topicId ?? null, resolvedFilename);

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
 * Store an OPAQUE blob at an exact key (R-3 encrypted chat attachments).
 *
 * Deliberately not `uploadToR2`: that one mints its own key from a client
 * filename, labels the object with a real image content type and is the entry
 * point for the plaintext path that sniffs and transcodes. Encrypted chat bytes
 * must get none of that — the server cannot tell what they are, and must not
 * try. It only ever sees `application/octet-stream`.
 */
export async function putR2Object(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
  const { s3, config } = getR2Client();
  logger.info(MODULE, 'Storing opaque object', { key, size: body.length });
  await s3.send(
    new PutObjectCommand({
      Bucket: config.R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      CacheControl: 'private, max-age=31536000, immutable',
      Body: body,
    }),
  );
}

/** Read an object back by key. Null when it is missing (a deleted attachment). */
export async function getR2Object(key: string): Promise<Uint8Array | null> {
  const { s3, config } = getR2Client();
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: config.R2_BUCKET_NAME, Key: key }));
    if (!res.Body) return null;
    return await res.Body.transformToByteArray();
  } catch (err) {
    logger.warn(MODULE, 'Object fetch failed', { key, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Read an object back WITH the content type it was stored under (M-5).
 *
 * `getR2Object` throws away `ContentType` because its only caller (encrypted
 * chat attachments) never has a real one to give back — `putR2Object` always
 * writes `application/octet-stream`, and the browser gets its type from the
 * decrypted envelope, not from R2. Plaintext post/profile/topic images are the
 * opposite: `uploadToR2` writes the real image type, and a caller serving the
 * bytes onward (the gated `/api/media/*` route) needs it to answer with a
 * `Content-Type` a browser will actually render as an image.
 */
export async function getR2ObjectWithMeta(
  key: string,
): Promise<{ bytes: Uint8Array; contentType: string | null } | null> {
  const { s3, config } = getR2Client();
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: config.R2_BUCKET_NAME, Key: key }));
    if (!res.Body) return null;
    const bytes = await res.Body.transformToByteArray();
    return { bytes, contentType: res.ContentType ?? null };
  } catch (err) {
    logger.warn(MODULE, 'Object fetch failed', { key, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * The base URL new uploads are minted under — `${R2_PUBLIC_URL}/${key}`, same
 * as `uploadToR2` builds. Exposed so a caller can reconstruct that exact URL to
 * look one up (M-5's `user-upload` gate: is this object a topic's cover
 * picture?) without duplicating `getR2Config`'s env-var handling. Returns null
 * rather than throwing when storage isn't configured — a caller deciding
 * whether a stored URL matches an unconfigured deployment should get "no
 * match", not a 500.
 */
export function tryGetR2PublicUrl(): string | null {
  try {
    return getR2Client().config.R2_PUBLIC_URL;
  } catch {
    return null;
  }
}

/** Delete one object by key. Idempotent, like DeleteObject itself. */
export async function deleteR2Object(key: string): Promise<boolean> {
  try {
    const { s3, config } = getR2Client();
    await s3.send(new DeleteObjectCommand({ Bucket: config.R2_BUCKET_NAME, Key: key }));
    logger.info(MODULE, 'Deleted object', { key });
    return true;
  } catch (err) {
    logger.error(MODULE, 'Failed to delete object', { key, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Delete every object under a prefix, paging until the listing is exhausted.
 *
 * This is what makes deleting a topic delete its pictures. Nothing else can:
 * an encrypted attachment is referenced only from inside a sealed message body,
 * so the server cannot read which objects a message named — the key layout
 * (`topics/{topicId}/...`, built by `topicObjectPrefix`) is the only handle it
 * has on them, by design. Pass a prefix from that helper, never a literal: a
 * hand-written path keeps matching a shape production has stopped writing, and
 * the sweep then reports success having deleted nothing.
 *
 * Returns the number of objects deleted. Never throws: a topic deletion that
 * already removed the rows must not fail because storage was briefly unhappy —
 * the caller logs the shortfall instead.
 */
export async function deleteR2Prefix(prefix: string): Promise<number> {
  if (!prefix || prefix.includes('..')) return 0;
  let client;
  try {
    client = getR2Client();
  } catch {
    logger.warn(MODULE, 'R2 not configured — skipping prefix delete', { prefix });
    return 0;
  }
  const { s3, config } = client;
  let deleted = 0;
  let continuationToken: string | undefined;
  try {
    do {
      const listed = await s3.send(
        new ListObjectsV2Command({
          Bucket: config.R2_BUCKET_NAME,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const keys = (listed.Contents ?? []).map((o) => o.Key).filter((k): k is string => typeof k === 'string');
      if (keys.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: config.R2_BUCKET_NAME,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        deleted += keys.length;
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (err) {
    logger.error(MODULE, 'Prefix delete failed', {
      prefix,
      deleted,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  logger.info(MODULE, 'Prefix delete complete', { prefix, deleted });
  return deleted;
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
