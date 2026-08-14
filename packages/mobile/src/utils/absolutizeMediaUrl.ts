/**
 * absolutizeMediaUrl — resolves a possibly root-relative media URL (an
 * `/api/media/...` path returned by `POST /api/upload` or stored on a post /
 * topic / profile) against the app's own origin, for React Native's `<Image>`,
 * which — unlike a browser — has no page origin of its own to resolve a
 * relative `uri` against.
 *
 * Storing a bare path rather than a host-qualified URL is the normal shape
 * for app-served media (see `docs/design/media-bucket-privatisation.md`):
 * baking a hostname into stored data is what creates migration pain later.
 * `R2_PUBLIC_URL` is root-relative (`/api/media`) precisely so the web client
 * needs zero changes — every page load is already same-origin. Mobile has no
 * such origin, so this is the one place that needs to know the app's base URL.
 *
 * Mirrors the `absolutize()` helper already shipping in `useOgPreview.ts` /
 * `ChatRoomScreen.tsx` for OG preview images — same three-way split (empty,
 * already-absolute, root-relative), same non-behaviour for anything else. Not
 * merged into a shared file with those: this handles our OWN media host
 * (relative-by-construction, always resolves against `baseUrl`), while OG
 * preview images arrive already-absolute for THIRD-PARTY hosts, or relative
 * ONLY when proxied through `/api/og/image` — different enough origins of
 * "relative" that collapsing them into one helper would blur why each case
 * exists.
 */
export function absolutizeMediaUrl(
  uri: string | null | undefined,
  baseUrl: string,
): string | null | undefined {
  if (!uri) return uri;
  // Already absolute (our own `/api/media/...` once fully migrated to a real
  // absolute host, an external URL, or — defensively — a `data:` URI, which
  // must never be treated as a path to prefix). `startsWith('http')` also
  // covers `httpx://` typos the same as the existing OG helper does; neither
  // helper attempts full URL validation, only "already has a scheme."
  if (uri.startsWith('http') || uri.startsWith('data:')) return uri;
  if (uri.startsWith('/')) return `${baseUrl}${uri}`;
  // Anything else (a bare relative path with no leading slash, an empty
  // string already handled above, or something malformed) is left as-is —
  // silently prefixing an unrecognised shape risks turning a bug into a
  // broken-but-plausible-looking URL instead of a visibly missing image.
  return uri;
}
