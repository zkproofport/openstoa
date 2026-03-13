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

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ZKCommunityBot/1.0; +https://zkproofport.app)',
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
      return NextResponse.json(data, {
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
      // Stop once we've read past </head> or past max bytes
      if (totalBytes > MAX_BYTES || html.toLowerCase().includes('</head>')) {
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

    // Resolve relative image URLs
    if (ogData.image && !ogData.image.startsWith('http')) {
      if (ogData.image.startsWith('//')) {
        ogData.image = `https:${ogData.image}`;
      } else if (ogData.image.startsWith('/')) {
        ogData.image = `${parsed.origin}${ogData.image}`;
      }
    }

    return NextResponse.json(ogData, {
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
