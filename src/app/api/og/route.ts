import { NextRequest, NextResponse } from 'next/server';

interface OGData {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  favicon: string | null;
  url: string;
}

function extractMeta(html: string, property: string): string | null {
  // og: and twitter: meta tags
  const ogPattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`,
    'i'
  );
  const ogPatternReverse = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`,
    'i'
  );
  return (
    html.match(ogPattern)?.[1] ??
    html.match(ogPatternReverse)?.[1] ??
    null
  );
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m?.[1]?.trim() ?? null;
}

function extractFavicon(html: string, baseUrl: string): string | null {
  const origin = new URL(baseUrl).origin;

  const patterns = [
    /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/i,
  ];

  for (const pat of patterns) {
    const m = html.match(pat);
    if (m?.[1]) {
      const href = m[1];
      if (href.startsWith('http')) return href;
      if (href.startsWith('//')) return `https:${href}`;
      if (href.startsWith('/')) return `${origin}${href}`;
      return `${origin}/${href}`;
    }
  }

  // Default: try /favicon.ico
  return `${origin}/favicon.ico`;
}

/**
 * @openapi
 * /api/og:
 *   get:
 *     tags: [OG]
 *     summary: Fetch Open Graph metadata
 *     description: >-
 *       Server-side Open Graph metadata scraper. Fetches and parses OG tags from a given URL for
 *       link preview rendering. Results are cached for 1 hour.
 *     operationId: getOgMetadata
 *     security: []
 *     parameters:
 *       - name: url
 *         in: query
 *         required: true
 *         description: URL to scrape OG metadata from (must be http/https)
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: OG metadata extracted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 title:
 *                   type: string
 *                   description: Page title (og:title)
 *                 description:
 *                   type: string
 *                   description: Page description (og:description)
 *                 image:
 *                   type: string
 *                   description: Preview image URL (og:image)
 *                 siteName:
 *                   type: string
 *                   description: Site name (og:site_name)
 *                 favicon:
 *                   type: string
 *                   description: Site favicon URL
 *                 url:
 *                   type: string
 *                   description: Canonical URL
 */
// Real-browser UA. YouTube and many news sites serve a different/empty
// `<head>` (or block the request entirely) when the UA looks like a generic
// scraper, which is why the previous `OpenStoaBot/1.0` request returned no
// og:image and the mobile chat preview never rendered.
/**
 * How this fetcher identifies itself to the sites it previews.
 *
 * It used to claim to be Safari. That is worse than useless: sites cannot tell
 * us apart from a person, cannot contact us, and cannot allow or refuse us on
 * purpose — and the ones that gate browser-shaped requests from server IPs
 * simply refuse. Reddit answered our Safari string with 403 and this one with
 * 200, which is why link previews for reddit were blank.
 *
 * The shape is the one KakaoTalk uses, and for the same reason: the
 * `facebookexternalhit` token is what unfurler allowlists were written against,
 * so it is what gets a link preview served, while the rest of the string says
 * who is actually asking and where to reach us. Kakao's own is
 * `facebookexternalhit/1.1; kakaotalk-scrap/1.0; +https://devtalk.kakao.com/…`.
 */
const BROWSER_UA = 'facebookexternalhit/1.1; OpenStoaBot/1.0; +https://openstoa.xyz';

function isYouTubeUrl(parsed: URL): boolean {
  const h = parsed.hostname;
  return h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be' || h.endsWith('.youtu.be');
}

// Rewrite absolute image/favicon URLs through our own image proxy
// (`/api/og/image?src=...`) so clients never talk directly to the upstream
// CDN. This is what makes flaky hosts (GitHub OG dynamic renderer,
// LinkedIn media CDN, etc.) actually display on iOS — the Simulator's
// QUIC negotiation stalls on those origins while our Node server reaches
// them fine over HTTP/2. Idempotent: already-proxied URLs are left alone.
function proxyImageUrls(og: OGData): OGData {
  const rewrite = (u: string | null): string | null => {
    if (!u) return u;
    if (!u.startsWith('http')) return u;
    return `/api/og/image?src=${encodeURIComponent(u)}`;
  };
  return { ...og, image: rewrite(og.image), favicon: rewrite(og.favicon) };
}

async function fetchYouTubeOEmbed(url: string): Promise<OGData | null> {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const r = await fetch(oembedUrl, { headers: { 'User-Agent': BROWSER_UA } });
    if (!r.ok) return null;
    const j = (await r.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
    return {
      title: j.title ?? null,
      description: j.author_name ? `by ${j.author_name}` : null,
      image: j.thumbnail_url ?? null,
      siteName: 'YouTube',
      favicon: 'https://www.youtube.com/s/desktop/favicon.ico',
      url,
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');
  if (!url) {
    return NextResponse.json({ error: 'Missing url param' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  // Only allow http/https
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return NextResponse.json({ error: 'Invalid protocol' }, { status: 400 });
  }

  // YouTube short-circuit: use the official oEmbed endpoint instead of
  // scraping the mobile/desktop SPA shell, which often returns no useful
  // meta tags or 429s the server.
  if (isYouTubeUrl(parsed)) {
    const og = await fetchYouTubeOEmbed(url);
    if (og) {
      return NextResponse.json(proxyImageUrls(og), {
        headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=3600' },
      });
    }
    // fall through to generic scrape if oEmbed somehow fails
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return NextResponse.json({ error: 'Fetch failed' }, { status: 502 });
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      // For non-HTML (e.g. images, PDFs), return minimal data
      const data: OGData = {
        title: parsed.hostname,
        description: null,
        image: null,
        siteName: parsed.hostname,
        favicon: `${parsed.origin}/favicon.ico`,
        url,
      };
      return NextResponse.json(proxyImageUrls(data), {
        headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=3600' },
      });
    }

    // Only read first 100kb to avoid large payloads
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No body');

    let html = '';
    let totalBytes = 0;
    const MAX_BYTES = 100 * 1024;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      html += new TextDecoder().decode(value);
      // Read up to MAX_BYTES regardless of </head> position. Next.js sites
      // (including openstoa.xyz) inline their metadata via post-hydration
      // scripts that appear AFTER </head> — bailing on </head> made us
      // skip those og:* tags and return an empty preview payload.
      if (totalBytes > MAX_BYTES) {
        reader.cancel();
        break;
      }
    }

    const ogData: OGData = {
      title:
        extractMeta(html, 'og:title') ??
        extractMeta(html, 'twitter:title') ??
        extractTitle(html),
      description:
        extractMeta(html, 'og:description') ??
        extractMeta(html, 'twitter:description') ??
        extractMeta(html, 'description'),
      image:
        extractMeta(html, 'og:image') ??
        extractMeta(html, 'twitter:image') ??
        extractMeta(html, 'twitter:image:src'),
      siteName:
        extractMeta(html, 'og:site_name') ??
        parsed.hostname.replace('www.', ''),
      favicon: extractFavicon(html, url),
      url,
    };

    // Resolve protocol-relative / root-relative image URLs to absolute
    // before handing them to the proxy rewriter (the proxy expects an
    // absolute http(s) URL).
    if (ogData.image && !ogData.image.startsWith('http')) {
      if (ogData.image.startsWith('//')) {
        ogData.image = `https:${ogData.image}`;
      } else if (ogData.image.startsWith('/')) {
        ogData.image = `${parsed.origin}${ogData.image}`;
      }
    }

    return NextResponse.json(proxyImageUrls(ogData), {
      headers: {
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const isTimeout = message.includes('abort') || message.includes('timeout');
    return NextResponse.json(
      { error: isTimeout ? 'Timeout' : 'Failed to fetch OG data' },
      { status: 502 }
    );
  }
}
