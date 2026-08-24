/**
 * Which image URLs the mini-app must authenticate to, and with what.
 *
 * `GET /api/media/{key}` (M-5) authorizes a read from the caller's SESSION —
 * `getSession(request)`, which accepts a cookie or an `Authorization: Bearer`.
 * A browser supplies the cookie without being asked. React Native's `<Image>`
 * issues its own HTTP request that carries neither, so once `R2_PUBLIC_URL`
 * points at that route (M-6, `docs/design/gated-image-credentials.md`
 * candidate B) every gated picture in the app resolves as a guest and 401s.
 * This module is the other half — candidate A, layered on top of B: hand the
 * `<Image>` request the Bearer the rest of the client already sends.
 *
 * The one rule worth guarding is the negative one: the Bearer goes to OUR
 * media route and nowhere else. Post bodies, OG previews and chat messages all
 * carry third-party image URLs chosen by whoever wrote them, and an
 * `<img src="https://someone-elses-host/x.png">` inside a post is a URL an
 * author picked — attaching a session token to it would hand that author a
 * working credential. So both consumers (`GatedImage` and `PostContent`'s
 * `provideEmbeddedHeaders`) build their headers through `gatedMediaHeaders`
 * below rather than each deciding for itself what "our" means.
 */

/**
 * Path prefix of the gated read route, as `absolutizeMediaUrl` leaves it on an
 * already-resolved URL. The trailing slash is load-bearing — without it a host
 * serving `/api/mediaproxy` would match.
 */
export const MEDIA_ROUTE_PREFIX = '/api/media/';

/**
 * True when `uri` addresses this app's own gated media route.
 *
 * Deliberately a literal prefix comparison against the client's own
 * `getBaseUrl()`, not a URL parse: it answers "did WE mint this" rather than
 * "is this well-formed", and anything that is not exactly our origin followed
 * by the route path is treated as somebody else's. That covers the shapes the
 * app actually holds — `file://` picks from the image library, `data:` URIs,
 * absolute third-party URLs, a bare relative path that never absolutized — by
 * failing all of them, which is the safe direction.
 *
 * Not case-insensitive, and that is fine: every URL this matches was written
 * by `uploadToR2` from `R2_PUBLIC_URL` plus a generated key, so the casing is
 * ours, not a human's.
 */
export function isGatedMediaUrl(uri: string | null | undefined, baseUrl: string): boolean {
  if (!uri || !baseUrl) return false;
  const origin = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return uri.startsWith(`${origin}${MEDIA_ROUTE_PREFIX}`);
}

/**
 * The headers to hand `<Image source>` for `uri`, or `undefined` for "send it
 * as-is".
 *
 * `undefined` — not an empty object — for the pass-through case on purpose:
 * `{ uri }` and `{ uri, headers: {} }` are not the same value to React
 * Native's image cache, and a non-gated image should keep the exact source
 * shape it had before this module existed.
 *
 * A null `token` (a guest, or a session whose token cannot be resolved
 * silently) also yields `undefined`, which is correct rather than a
 * degradation: the route serves public-topic images and avatars to guests, and
 * a private one was never theirs to see.
 */
export function gatedMediaHeaders(
  uri: string | null | undefined,
  baseUrl: string,
  token: string | null,
): Record<string, string> | undefined {
  if (!token || !isGatedMediaUrl(uri, baseUrl)) return undefined;
  return { Authorization: `Bearer ${token}` };
}
