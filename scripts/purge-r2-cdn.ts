/**
 * One-time mass CDN purge for R2 objects whose body was PUT-updated in
 * place (e.g., HEIC -> JPEG) but whose Cloudflare custom-domain edge
 * cache still serves the stale bytes.
 *
 * Lists every key in the bucket, builds the public URL, and purges in
 * batches of 30 (Cloudflare API limit).
 *
 * Usage:
 *   CLOUDFLARE_ZONE_ID=... CLOUDFLARE_PURGE_TOKEN=... \
 *     npx tsx scripts/purge-r2-cdn.ts                    # purge all keys
 *   ... --prefix posts/0xfb2bb249...                     # restrict to a key prefix
 *   ... --dry-run                                        # list only, no purge
 */
import { config as loadEnv } from 'dotenv';
import path from 'path';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { purgeCloudflareUrls, CLOUDFLARE_PURGE_BATCH } from '../src/lib/cloudflare-cache';

loadEnv({ path: path.resolve(__dirname, '../.env.local') });

const DRY_RUN = process.argv.includes('--dry-run');
const prefixIdx = process.argv.indexOf('--prefix');
const PREFIX = prefixIdx >= 0 ? process.argv[prefixIdx + 1] : undefined;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const CF_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CF_TOKEN = process.env.CLOUDFLARE_PURGE_TOKEN;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
  console.error('Missing R2_* env vars. Aborting.');
  process.exit(1);
}
if (!DRY_RUN && (!CF_ZONE_ID || !CF_TOKEN)) {
  console.error('Missing CLOUDFLARE_ZONE_ID or CLOUDFLARE_PURGE_TOKEN (required when not --dry-run).');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

async function* listKeys(prefix?: string): AsyncGenerator<string> {
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: R2_BUCKET_NAME, ContinuationToken: token, Prefix: prefix }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) yield obj.Key;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}`);
  console.log(`Bucket: ${R2_BUCKET_NAME}`);
  console.log(`Public URL: ${R2_PUBLIC_URL}`);
  if (PREFIX) console.log(`Prefix: ${PREFIX}`);

  const urls: string[] = [];
  for await (const key of listKeys(PREFIX)) {
    urls.push(`${R2_PUBLIC_URL}/${key.split('/').map(encodeURIComponent).join('/')}`);
  }
  console.log(`Listed ${urls.length} URLs.`);

  if (DRY_RUN) {
    for (const u of urls) console.log(`[DRY] ${u}`);
    console.log('\nDry-run complete — no purge.');
    return;
  }

  /*
   * Batched HERE as well as inside `purgeCloudflareUrls`, and deliberately: a
   * sweep is thousands of URLs, and this loop is what lets one rejected batch
   * be reported and stepped over instead of ending the run. Handing the whole
   * list to the shared function would purge the same URLs with the same
   * batching and then lose everything after the first failure.
   */
  let purged = 0;
  for (let i = 0; i < urls.length; i += CLOUDFLARE_PURGE_BATCH) {
    const batch = urls.slice(i, i + CLOUDFLARE_PURGE_BATCH);
    try {
      await purgeCloudflareUrls(batch);
      purged += batch.length;
      console.log(`  purged ${purged}/${urls.length}`);
    } catch (err) {
      console.error(`[FAIL batch starting ${i}] ${(err as Error).message}`);
    }
  }
  console.log(`\nDone. purged=${purged}/${urls.length}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
