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

/**
 * A root-relative media URL never contains a hostname to match against
 * `R2_HOSTS` — but it's still the exact same "an R2-backed image whose edge
 * cache the app may need to bust" case `R2_HOSTS` exists to catch, just
 * served through the app's own `GET /api/media/{key}` route (M-6,
 * docs/design/media-bucket-privatisation.md) instead of a bare CDN domain.
 * Checked separately from `R2_HOSTS` rather than folded into that list —
 * it's a path shape, not a host.
 */
const RELATIVE_MEDIA_PREFIX = '/api/media/';

export function withImageVersion<T extends string | null | undefined>(url: T): T {
  if (!url) return url;
  if (typeof url !== 'string') return url;
  const isOurMedia = R2_HOSTS.some((h) => url.includes(h)) || url.startsWith(RELATIVE_MEDIA_PREFIX);
  if (!isOurMedia) return url as T;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${VERSION}` as T;
}
