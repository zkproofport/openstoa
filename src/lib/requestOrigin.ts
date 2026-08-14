/**
 * Resolves the origin (`scheme://host`) a request actually arrived on, for
 * `generateMetadata` in server-rendered pages.
 *
 * `metadataBase` (root `layout.tsx`) is a fixed constant and cannot know
 * which of the app's two live hostnames — `openstoa.xyz` or
 * `community.zkproofport.app` — a given request came in on. A crawler
 * unfurling a link shared on `community.zkproofport.app` must get an
 * `og:image` / `og:url` on THAT host, not a hardcoded one, or the preview
 * card links back to a different domain than the one the user clicked.
 *
 * `headers()` gives us the ACTUAL request headers for this render — Cloud
 * Run terminates TLS in front of the app and forwards plain HTTP, setting
 * `X-Forwarded-Proto` and (via Next's own header passthrough) `Host` to
 * what the client used. No env var can substitute for this: the whole point
 * is picking between two live hostnames, not knowing "the" hostname.
 */
import { headers } from 'next/headers';

export class MissingHostHeaderError extends Error {
  constructor() {
    super('Unable to resolve request origin: neither x-forwarded-host nor host header is present');
    this.name = 'MissingHostHeaderError';
  }
}

/**
 * Pure — takes headers already read, so it's testable without mocking
 * `next/headers`. `x-forwarded-proto` wins when present (staging/production,
 * behind Cloud Run + Caddy); otherwise scheme is inferred from `APP_ENV`,
 * mirroring the `isProd` check already used in `layout.tsx` / `sitemap.ts` /
 * `robots.ts` — local `next dev` has no forwarding proxy and serves plain
 * HTTP, everything else does.
 */
export function originFromHeaders(get: (name: string) => string | null): string {
  const host = get('x-forwarded-host') ?? get('host');
  if (!host) throw new MissingHostHeaderError();
  const proto = get('x-forwarded-proto') ?? (process.env.APP_ENV === 'production' ? 'https' : 'http');
  return `${proto}://${host}`;
}

export async function resolveRequestOrigin(): Promise<string> {
  const h = await headers();
  return originFromHeaders((name) => h.get(name));
}
