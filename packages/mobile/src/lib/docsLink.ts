/**
 * Where "Docs" points.
 *
 * The web serves the human-facing guide at `/docs` on the same origin as the
 * API, so the mini-app derives it from the host-provided
 * `HostEnvironmentInfo.openstoaBaseUrl` rather than hardcoding a domain —
 * a staging build must open staging's docs, not production's.
 *
 * Returns null instead of guessing when the base URL is unusable. Callers
 * hide the affordance in that case: a row that navigates to a broken URL is
 * worse than a row that isn't there.
 *
 * Only `http`/`https` are ever produced. That is what makes it safe to route
 * the result through `InAppBrowser` (the WebView) per the project-wide rule
 * that outbound http(s) links never go to `Linking.openURL`; a base URL
 * carrying any other scheme is rejected outright rather than handed to a
 * WebView that cannot render it.
 */

/** Path of the guide page on the OpenStoa web app. */
export const DOCS_PATH = '/docs';

/** Guards against a pathological host value being string-processed. */
const MAX_BASE_URL_LENGTH = 2048;

/**
 * C0/C1 control characters and DEL. Rejected anywhere in the input.
 *
 * These are NOT matched by `\s`, so a host-supplied base URL with an
 * embedded \\x07 sails past a naive "no whitespace" host check and reaches
 * the WebView looking like a valid origin. Screening the whole string up
 * front is cheaper than spotting them per-segment.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/;

/** Host portion: no whitespace, no path/query/fragment delimiters. */
const HTTP_ORIGIN_RE = /^https?:\/\/[^\s/?#]+$/i;

/**
 * Normalizes a base URL to a bare origin(+path) with no trailing slash, or
 * null if it is not an `http(s)` URL.
 */
export function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > MAX_BASE_URL_LENGTH) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (CONTROL_CHARS_RE.test(trimmed)) return null;
  // Drop any query/fragment the host may have appended, then trailing slashes.
  const withoutSuffix = trimmed.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  if (!withoutSuffix) return null;
  // Validate the origin portion only — a base URL may legitimately carry a
  // path prefix (e.g. a reverse-proxied `https://host/openstoa`).
  const [scheme, rest] = withoutSuffix.split('://', 2);
  if (rest === undefined) return null;
  const origin = `${scheme}://${rest.split('/', 1)[0]}`;
  if (!HTTP_ORIGIN_RE.test(origin)) return null;
  return withoutSuffix;
}

/**
 * Builds the absolute docs URL, or null when the base URL is unusable.
 */
export function buildDocsUrl(baseUrl: unknown): string | null {
  const base = normalizeBaseUrl(baseUrl);
  return base === null ? null : `${base}${DOCS_PATH}`;
}
