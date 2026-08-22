import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout } from '../api/timeout';
import { useQuery } from '@tanstack/react-query';
import { useOpenStoaClient } from './useOpenStoaClient';
import type { OGData } from '../components/OGPreviewCard';

// URL matcher — first http(s) URL in the content.
const URL_REGEX = /(https?:\/\/[^\s]+)/g;

export function extractFirstUrl(text: string): string | null {
  URL_REGEX.lastIndex = 0;
  const match = URL_REGEX.exec(text);
  URL_REGEX.lastIndex = 0;
  return match ? match[1] : null;
}

export interface UseOgPreviewResult {
  firstUrl: string | null;
  ogData: OGData | null | undefined;
  hasOG: boolean;
}

/**
 * Resolve the first URL in `content` into an OG preview (title /
 * description / image / favicon / siteName). YouTube short-circuits to
 * oEmbed; everything else goes through the server's `/api/og` scraper.
 * Cached for 1 hour. Returns `hasOG=false` when fetch fails or the URL
 * has no meaningful metadata.
 *
 * Pulled out of ChatRoomScreen so PostDetail (and any future surface)
 * can render the same preview cards without copy-pasting the fetch
 * logic.
 */
export function useOgPreview(content: string): UseOgPreviewResult {
  const client = useOpenStoaClient();
  const firstUrl = extractFirstUrl(content);

  const { data: ogData } = useQuery<OGData | null>({
    queryKey: ['og', firstUrl],
    queryFn: async () => {
      if (!firstUrl) return null;
      try {
        // YouTube short-circuit: hit the official oEmbed endpoint directly
        // from the device. Avoids the server's UA gating and works without
        // a deploy. Other URLs still fall back to the server's /api/og
        // generic scraper.
        let parsed: URL | null = null;
        try {
          parsed = new URL(firstUrl);
        } catch {
          /* not a URL */
        }
        const host = parsed?.hostname ?? '';
        const isYouTube =
          host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
        if (isYouTube) {
          // Deadlined like everything else the person is waiting on. It is a
          // third party rather than our API, which if anything makes it MORE
          // likely to accept a connection and go quiet — and this runs inside a
          // query, so a request that never answers is a preview that spins for
          // the life of the screen. The surrounding catch turns the timeout
          // into "no preview", which is the right outcome for a link card.
          const r = await fetchWithTimeout(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(firstUrl)}&format=json`,
            {},
            { path: 'youtube.com/oembed', timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
          );
          if (r.ok) {
            const j = (await r.json()) as {
              title?: string;
              author_name?: string;
              thumbnail_url?: string;
            };
            return {
              title: j.title ?? null,
              description: j.author_name ? `by ${j.author_name}` : null,
              image: j.thumbnail_url ?? null,
              siteName: 'YouTube',
              favicon: 'https://www.youtube.com/s/desktop/favicon.ico',
            } as OGData;
          }
          // oEmbed failed (private/deleted video etc.) — fall through.
        }
        // Cache-buster to dodge stale iOS HTTP cache from before the
        // server-side OG scraper was redeployed with the new UA branch.
        const cacheBust = Date.now();
        const res = await client.get<OGData>(
          `/api/og?url=${encodeURIComponent(firstUrl)}&_=${cacheBust}`,
        );
        // Server may return image/favicon as a relative path through our
        // own image proxy (`/api/og/image?src=...`) so the device never
        // talks to flaky upstream CDNs. Resolve to absolute URLs before
        // handing to <Image>.
        const baseUrl = client.getBaseUrl();
        const absolutize = (u: string | null): string | null => {
          if (!u) return u;
          if (u.startsWith('http')) return u;
          if (u.startsWith('/')) return `${baseUrl}${u}`;
          return u;
        };
        if (res) {
          res.image = absolutize(res.image);
          res.favicon = absolutize(res.favicon);
        }
        return res;
      } catch {
        return null;
      }
    },
    enabled: firstUrl !== null,
    staleTime: 60 * 60 * 1000, // 1 hour
  });

  const hasOG = ogData != null && (ogData.title != null || ogData.image != null);
  return { firstUrl, ogData: ogData ?? null, hasOG };
}
