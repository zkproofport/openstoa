import { NextRequest, NextResponse } from 'next/server';
import { assertPublicUrl, safeFetch, BlockedUrlError } from '@/lib/outboundUrl';

// Browser-like User-Agent so hosts (LinkedIn CDN, GitHub OG renderer, etc.)
// serve us the same response they'd give a regular browser. The mobile
// client was failing on these same URLs because iOS Simulator stalls on
// the QUIC path many image CDNs negotiate. Proxying through our Node.js
// runtime (HTTP/2 via fetch) sidesteps that entirely.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

// Limit upstream image size to keep Cloud Run memory predictable. 5 MB is
// generous for OG preview images (typical 1200x630 JPEG ~ 100-300 KB).
const MAX_BYTES = 5 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 8_000;

/**
 * @openapi
 * /api/og/image:
 *   get:
 *     tags: [OG]
 *     summary: Proxy an external image for OG link previews
 *     description: >-
 *       Fetches an external image via the server (HTTP/2, browser UA) and
 *       streams it back to the client. Used by the mobile client to dodge
 *       per-CDN networking quirks (e.g. iOS Simulator hanging on certain
 *       QUIC negotiations with GitHub / LinkedIn image hosts).
 *     operationId: proxyOgImage
 *     security: []
 *     parameters:
 *       - name: src
 *         in: query
 *         required: true
 *         description: >-
 *           Absolute http/https image URL to proxy. Same destination rules as `/api/og`: the host
 *           must resolve to a public address and every redirect hop is re-checked, otherwise `400
 *           Invalid URL`. This route returns the upstream BYTES, so the check matters more here.
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Image bytes
 *         content:
 *           image/*: {}
 *       '400':
 *         description: Missing/invalid src
 *       '415':
 *         description: Upstream is not an image
 *       '502':
 *         description: Upstream fetch failed
 */
export async function GET(req: NextRequest) {
  const src = req.nextUrl.searchParams.get('src');
  if (!src) {
    return NextResponse.json({ error: 'Missing src param' }, { status: 400 });
  }

  /*
   * Same guard as `/api/og`, and it matters more here: this route returns the
   * upstream BYTES. See `@/lib/outboundUrl`.
   */
  try {
    await assertPublicUrl(src);
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
    }
    throw err;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const { response: upstream } = await safeFetch(src, {
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timeout);

    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: 'Upstream fetch failed' }, { status: 502 });
    }

    const upstreamType = upstream.headers.get('content-type') ?? '';
    if (!upstreamType.startsWith('image/')) {
      return NextResponse.json({ error: 'Upstream is not an image' }, { status: 415 });
    }

    // Buffer-then-respond. We could stream, but capping at MAX_BYTES is
    // simpler here than a transform stream that aborts mid-flight.
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        reader.cancel();
        return NextResponse.json({ error: 'Image too large' }, { status: 502 });
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      body.set(c, offset);
      offset += c.length;
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': upstreamType,
        'Content-Length': String(total),
        // Aggressive cache — image content at a given URL doesn't change.
        // CDN/proxy layer in front of Cloud Run will respect this.
        'Cache-Control': 'public, max-age=86400, s-maxage=86400, immutable',
      },
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    const message = err instanceof Error ? err.message : 'Unknown error';
    const isTimeout = message.includes('abort') || message.includes('timeout');
    return NextResponse.json(
      { error: isTimeout ? 'Timeout' : 'Upstream fetch failed' },
      { status: 502 },
    );
  }
}
