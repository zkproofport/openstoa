/**
 * `src/lib/requestOrigin.ts` — deriving `scheme://host` from the ACTUAL
 * request headers, for per-post/per-topic `generateMetadata`.
 *
 * Only `originFromHeaders` is unit-tested here — it's the pure half, taking
 * a header-lookup function instead of calling `next/headers` itself, so no
 * request-context mocking is needed. `resolveRequestOrigin` (the `headers()`
 * wrapper) is exercised for real by the E2E suite
 * (`src/__tests__/e2e/page-metadata.test.ts`), which is the only place a
 * real Next.js request context exists to read from.
 *
 * Edge-case matrix rows covered here:
 *   contract      — `x-forwarded-host`/`x-forwarded-proto` win over `host`
 *                   when both are present (the Cloud Run / Caddy shape)
 *   boundary       — only `host` present (no forwarding proxy — local `next dev`)
 *   hostile        — a header value containing characters a naive template
 *                    literal would pass through unescaped is still just data
 *                    here (no HTML is built from this value — the caller
 *                    only concatenates it into a URL string)
 *   empty          — both host headers absent → throws, never guesses
 *   external-dep   — N/A: `headers()` itself is a synchronous framework
 *                    read, not a network call this module could fail to
 *                    reach — nothing to simulate as "unavailable"
 *   integrity      — the two live hosts (`openstoa.xyz`,
 *                    `community.zkproofport.app`) both round-trip untouched
 */
import { describe, it, expect, afterEach } from 'vitest';
import { originFromHeaders, MissingHostHeaderError } from '@/lib/requestOrigin';

function headerMap(map: Record<string, string>): (name: string) => string | null {
  return (name: string) => map[name.toLowerCase()] ?? null;
}

const ORIGINAL_APP_ENV = process.env.APP_ENV;
afterEach(() => {
  if (ORIGINAL_APP_ENV === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = ORIGINAL_APP_ENV;
});

describe('originFromHeaders', () => {
  it('CONTRACT: x-forwarded-host + x-forwarded-proto win when both are present', () => {
    const get = headerMap({
      'x-forwarded-host': 'openstoa.xyz',
      'x-forwarded-proto': 'https',
      host: 'proofport-community-production-abc123.a.run.app',
    });
    expect(originFromHeaders(get)).toBe('https://openstoa.xyz');
  });

  it('INTEGRITY: community.zkproofport.app round-trips untouched', () => {
    const get = headerMap({ 'x-forwarded-host': 'community.zkproofport.app', 'x-forwarded-proto': 'https' });
    expect(originFromHeaders(get)).toBe('https://community.zkproofport.app');
  });

  it('BOUNDARY: falls back to plain `host` when no forwarded headers exist', () => {
    const get = headerMap({ host: 'localhost:3200' });
    process.env.APP_ENV = 'development';
    expect(originFromHeaders(get)).toBe('http://localhost:3200');
  });

  it('BOUNDARY: with no x-forwarded-proto, APP_ENV=production infers https', () => {
    const get = headerMap({ host: 'openstoa.xyz' });
    process.env.APP_ENV = 'production';
    expect(originFromHeaders(get)).toBe('https://openstoa.xyz');
  });

  it('BOUNDARY: with no x-forwarded-proto and APP_ENV unset, infers http', () => {
    const get = headerMap({ host: 'localhost:3200' });
    delete process.env.APP_ENV;
    expect(originFromHeaders(get)).toBe('http://localhost:3200');
  });

  it('HOSTILE: a header value is treated as opaque data, not re-parsed', () => {
    // No HTML/attribute is built from this value inside the module — it is
    // handed straight to a template literal that becomes a URL string, so a
    // header carrying quotes/angle-brackets is not this module's problem to
    // escape (the caller — Next's `Metadata` object — escapes on the way to
    // HTML). This asserts the passthrough is exact, not "sanitized".
    const get = headerMap({ 'x-forwarded-host': 'evil.example<script>', 'x-forwarded-proto': 'https' });
    expect(originFromHeaders(get)).toBe('https://evil.example<script>');
  });

  it('EMPTY: neither x-forwarded-host nor host present throws, never guesses', () => {
    const get = headerMap({});
    expect(() => originFromHeaders(get)).toThrow(MissingHostHeaderError);
  });

  it('EMPTY: an empty-string host header is treated as absent', () => {
    const get = headerMap({ host: '' });
    expect(() => originFromHeaders(get)).toThrow(MissingHostHeaderError);
  });
});
