// Forces Cloudflare CDN to treat each rendered R2 URL as a fresh cache key.
// Workaround for the HEIC->JPEG migration: origin objects were rewritten in
// place, but the edge cache kept serving the stale HEIC body for the full
// max-age window (1 year). Bumping this version invalidates the edge cache
// for every R2 image without needing a Cloudflare purge call.
const VERSION = 'v20260609a';

/** Every host this deployment family serves R2 objects from (staging + production). */
export const R2_HOSTS = [
  'stg-cdn.zkproofport.app',
  'media.zkproofport.app',
  'cdn.zkproofport.app',
];

export function withImageVersion<T extends string | null | undefined>(url: T): T {
  if (!url) return url;
  if (typeof url !== 'string') return url;
  if (!R2_HOSTS.some((h) => url.includes(h))) return url as T;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${VERSION}` as T;
}
