// Cloudflare CDN cache purge — invoked after we mutate an R2 object body
// at an existing key (e.g., HEIC->JPEG conversion). Without this call the
// custom-domain edge cache keeps serving the stale bytes for the full
// max-age window (we use 1 year). Origin PUT alone does NOT propagate.
//
// Env: CLOUDFLARE_ZONE_ID + CLOUDFLARE_PURGE_TOKEN (Zone > Cache Purge scope).

import { apiFetch } from '@/lib/apiFetch';

const PURGE_ENDPOINT = (zoneId: string) =>
  `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`;

export class CloudflarePurgeError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Cloudflare purge_cache failed: ${status} ${body}`);
  }
}

interface PurgeResponse {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
}

/** Cloudflare's own limit on one purge call. */
export const CLOUDFLARE_PURGE_BATCH = 30;

/**
 * Purge the given absolute URLs from Cloudflare's edge cache.
 *
 * BATCHES ITSELF. It used to throw over Cloudflare's limit of 30 and leave the
 * splitting to the caller, which is why the two scripts that actually purge
 * each grew their own copy of this function — and the copies use a bare
 * `fetch`, so a Cloudflare that accepts the connection and never answers hangs
 * the script forever. The deadline rule was being enforced (see
 * `pushOutboundDeadline.test.ts`) on the one implementation nobody called.
 *
 * Sequential, not parallel: a purge sweep can be thousands of URLs, and firing
 * every batch at once is how a maintenance script earns a rate limit.
 *
 * Throws if env is missing or the API call fails — callers MUST decide
 * whether to swallow the error (best-effort) or propagate it.
 */
export async function purgeCloudflareUrls(urls: string[]): Promise<void> {
  if (urls.length === 0) return;

  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const token = process.env.CLOUDFLARE_PURGE_TOKEN;
  if (!zoneId) throw new Error('CLOUDFLARE_ZONE_ID environment variable is required');
  if (!token) throw new Error('CLOUDFLARE_PURGE_TOKEN environment variable is required');

  for (let i = 0; i < urls.length; i += CLOUDFLARE_PURGE_BATCH) {
    const batch = urls.slice(i, i + CLOUDFLARE_PURGE_BATCH);
    const res = await apiFetch(PURGE_ENDPOINT(zoneId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: batch }),
    });
    const text = await res.text();
    if (!res.ok) throw new CloudflarePurgeError(res.status, text);
    let parsed: PurgeResponse;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CloudflarePurgeError(res.status, text);
    }
    if (!parsed.success) {
      throw new CloudflarePurgeError(
        res.status,
        parsed.errors?.map((e) => `${e.code}:${e.message}`).join(', ') ?? text,
      );
    }
  }
}
