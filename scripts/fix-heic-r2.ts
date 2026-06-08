/**
 * One-off migration: re-encode HEIC R2 objects to JPEG in-place.
 *
 * Reads R2 creds from openstoa/.env.local (loaded via dotenv) and walks the
 * entire bucket. For each object whose Content-Type is image/heic or image/heif
 * (or matches HEIC magic bytes despite a wrong content-type), downloads the
 * bytes, runs sharp(...).jpeg({quality:85}), and PUTs back to the same key
 * with Content-Type: image/jpeg.
 *
 * Usage:
 *   npx tsx scripts/fix-heic-r2.ts --dry-run   # list only
 *   npx tsx scripts/fix-heic-r2.ts             # real run
 */

import { config as loadEnv } from 'dotenv';
import path from 'path';
import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
// heic-convert ships libheif as WASM so it works regardless of sharp's bundled libvips.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const heicConvert: (opts: { buffer: Buffer; format: 'JPEG' | 'PNG'; quality?: number }) => Promise<ArrayBuffer> = require('heic-convert');

loadEnv({ path: path.resolve(__dirname, '../.env.local') });

const DRY_RUN = process.argv.includes('--dry-run');
const CONCURRENCY = 4;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
  console.error('Missing R2_* env vars. Aborting.');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

// HEIC/HEIF ISO BMFF ftyp brands.
const HEIC_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1',
]);

function sniffHeic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // bytes 4..8 should be 'ftyp'
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('ascii', 8, 12);
  return HEIC_BRANDS.has(brand);
}

async function streamToBuffer(body: any): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function* listAllKeys(): AsyncGenerator<{ key: string; size: number }> {
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: R2_BUCKET_NAME, ContinuationToken: token }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) yield { key: obj.Key, size: obj.Size ?? 0 };
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
}

type Candidate = {
  key: string;
  size: number;
  contentType: string;
  cacheControl?: string;
  // When true, bytes are already JPEG but R2 metadata says image/heic — we
  // just need to re-PUT with the correct Content-Type, no decode required.
  metadataOnly?: boolean;
};

async function inspect(key: string, size: number): Promise<Candidate | null> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    const ct = (head.ContentType ?? '').toLowerCase();
    // Metadata says HEIC: still need to sniff bytes because some objects were
    // client-side converted to JPEG but kept the upload's Content-Type: image/heic.
    if (ct === 'image/heic' || ct === 'image/heif') {
      const ranged = await s3.send(
        new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key, Range: 'bytes=0-11' }),
      );
      const head12 = await streamToBuffer(ranged.Body);
      const bytesAreHeic = sniffHeic(head12);
      return {
        key,
        size,
        contentType: ct,
        cacheControl: head.CacheControl,
        metadataOnly: !bytesAreHeic,
      };
    }
    // Fallback: sniff first 12 bytes for HEIC magic when content-type is wrong (e.g., image/jpeg).
    if (ct === 'image/jpeg' || ct === 'image/jpg' || ct === 'application/octet-stream' || ct === '') {
      const ranged = await s3.send(
        new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key, Range: 'bytes=0-11' }),
      );
      const head12 = await streamToBuffer(ranged.Body);
      if (sniffHeic(head12)) {
        return { key, size, contentType: ct || 'application/octet-stream', cacheControl: head.CacheControl };
      }
    }
    return null;
  } catch (err) {
    console.warn(`[inspect-fail] ${key}: ${(err as Error).message}`);
    return null;
  }
}

async function convertAndUpload(cand: Candidate): Promise<{ srcSize: number; outSize: number; url: string }> {
  const got = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: cand.key }));
  const srcBuf = await streamToBuffer(got.Body);

  let outBuf: Buffer;
  if (cand.metadataOnly) {
    // Bytes are already JPEG; only the R2 Content-Type metadata is wrong.
    // Re-PUT the same bytes with the correct Content-Type.
    outBuf = srcBuf;
  } else {
    // 1) Decode HEIC -> JPEG via heic-convert (WASM libheif).
    const jpegArr = await heicConvert({ buffer: srcBuf, format: 'JPEG', quality: 0.85 });
    // 2) Pipe through sharp to normalize/strip metadata + ensure consistent JPEG quality.
    outBuf = await sharp(Buffer.from(jpegArr)).jpeg({ quality: 85 }).toBuffer();
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: cand.key,
      Body: outBuf,
      ContentType: 'image/jpeg',
      CacheControl: cand.cacheControl ?? 'public, max-age=31536000, immutable',
    }),
  );
  // The PUT updates R2 origin but does NOT invalidate Cloudflare's
  // custom-domain edge cache — callers must purge using the URL list
  // returned here.
  const url = `${R2_PUBLIC_URL}/${cand.key.split('/').map(encodeURIComponent).join('/')}`;
  return { srcSize: srcBuf.length, outSize: outBuf.length, url };
}

// Cloudflare purge_cache wrapper. Cloudflare accepts max 30 URLs / call,
// so we batch. Throws when env is missing (caller decides whether to
// continue with leftover stale-cached objects or abort).
async function purgeCloudflareUrls(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const token = process.env.CLOUDFLARE_PURGE_TOKEN;
  if (!zoneId || !token) {
    throw new Error(
      'CLOUDFLARE_ZONE_ID and CLOUDFLARE_PURGE_TOKEN must be set to purge edge cache after PUT',
    );
  }
  for (let i = 0; i < urls.length; i += 30) {
    const batch = urls.slice(i, i + 30);
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: batch }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`purge_cache ${res.status}: ${text}`);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error(`purge_cache: ${JSON.stringify(parsed.errors)}`);
    console.log(`  [purge] ${batch.length} URL(s) purged`);
  }
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let idx = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (idx < items.length) {
      const myIdx = idx++;
      await worker(items[myIdx]);
    }
  });
  await Promise.all(runners);
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}`);
  console.log(`Bucket: ${R2_BUCKET_NAME}`);
  console.log(`Public URL: ${R2_PUBLIC_URL}`);

  let scanned = 0;
  const candidates: Candidate[] = [];

  // Phase 1: list + inspect (parallelized via batches).
  const keys: { key: string; size: number }[] = [];
  for await (const item of listAllKeys()) keys.push(item);
  console.log(`Listed ${keys.length} objects. Inspecting headers...`);

  await runWithConcurrency(keys, 8, async ({ key, size }) => {
    scanned++;
    const c = await inspect(key, size);
    if (c) candidates.push(c);
    if (scanned % 50 === 0) console.log(`  inspected ${scanned}/${keys.length} (candidates so far: ${candidates.length})`);
  });

  console.log(`\nFound ${candidates.length} HEIC candidates out of ${keys.length} objects.`);

  if (DRY_RUN) {
    for (const c of candidates) {
      const tag = c.metadataOnly ? '[META-ONLY]' : '[DECODE]';
      console.log(`[DRY] ${tag} ${c.contentType} ${c.size} bytes :: ${c.key}`);
    }
    console.log('\nDry-run complete — no writes.');
    return;
  }

  // Phase 2: convert + reupload.
  let converted = 0;
  let failed = 0;
  const purgeUrls: string[] = [];
  await runWithConcurrency(candidates, CONCURRENCY, async (cand) => {
    try {
      const { srcSize, outSize, url } = await convertAndUpload(cand);
      converted++;
      purgeUrls.push(url);
      const tag = cand.metadataOnly ? 'meta-only' : 'decoded';
      console.log(`[ok:${tag}] ${cand.key} :: ${srcSize} -> ${outSize} bytes (was ${cand.contentType})`);
    } catch (err) {
      failed++;
      console.error(`[FAIL] ${cand.key}: ${(err as Error).message}`);
    }
  });

  // Phase 3: purge Cloudflare CDN edge cache for the URLs we just rewrote.
  // PUT updates origin only; without this the edge keeps serving the stale
  // HEIC body for the full max-age window (we use 1 year). This is the
  // step we previously omitted, which caused "I converted it but web
  // still shows HEIC" regressions.
  if (purgeUrls.length > 0) {
    console.log(`\nPurging Cloudflare edge cache for ${purgeUrls.length} URL(s)...`);
    try {
      await purgeCloudflareUrls(purgeUrls);
    } catch (err) {
      console.error(`[PURGE-FAIL] ${(err as Error).message}`);
      console.error(`Origin is updated, but edge cache is still stale. Purge manually.`);
    }
  }

  console.log(`\nDone. converted=${converted} failed=${failed} total-candidates=${candidates.length} scanned=${scanned}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
