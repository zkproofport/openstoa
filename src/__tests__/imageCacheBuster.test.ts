/**
 * `withImageVersion` — appends the CDN cache-bust query param to an R2-backed
 * image URL, whether it's absolute (matches `R2_HOSTS`) or root-relative
 * (M-6, `/api/media/...` — no hostname to match at all, since the app now
 * serves it directly). Found while implementing M-6: this function is a
 * FOURTH "checks the R2_PUBLIC_URL shape" site beyond the three
 * docs/design/gated-image-credentials.md named — `Avatar.tsx`,
 * `post/MediaGallery.tsx`, and `ImageLightbox.tsx` all call it on every
 * render, so a relative URL silently losing cache-busting would be a real,
 * easy-to-miss regression (a re-uploaded image could show stale bytes from
 * Cloudflare's edge cache for up to a year — the same `max-age` the M-5
 * route sets).
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   boundary          → exactly `/api/media/` with nothing after it
 *   hostile input     → a relative path that merely CONTAINS the substring
 *                       `/api/media/` later in the string must NOT match
 *                       (prefix check, not `includes`) — mirrors why R2_HOSTS
 *                       itself is checked by substring on a real hostname,
 *                       not blindly
 *   empty/null/undef  → three separate cases
 *   UTF-8             → Korean filename in a relative media path
 *   contract          → an absolute R2_HOSTS URL still round-trips exactly
 *                       as before this change (no regression for the
 *                       existing case)
 *   result integrity  → `?` vs `&` separator chosen correctly whether the
 *                       URL already carries a query string
 */
import { describe, it, expect } from 'vitest';
import { withImageVersion, R2_HOSTS } from '@/lib/imageCacheBuster';

describe('withImageVersion', () => {
  it('EMPTY/NULL/UNDEFINED: three separate cases, all pass through unchanged', () => {
    expect(withImageVersion('')).toBe('');
    expect(withImageVersion(null)).toBe(null);
    expect(withImageVersion(undefined)).toBe(undefined);
  });

  it('CONTRACT: an absolute R2_HOSTS URL is still versioned (no regression)', () => {
    const url = `https://${R2_HOSTS[0]}/topics/t1/posts/p1/photo.jpg`;
    const result = withImageVersion(url);
    expect(result).toMatch(/\?v=/);
    expect(result?.startsWith(url)).toBe(true);
  });

  it('M-6: a root-relative /api/media/ URL is versioned too, with no hostname to match', () => {
    const url = '/api/media/topics/t1/posts/p1/photo.jpg';
    const result = withImageVersion(url);
    expect(result).toMatch(/\?v=/);
    expect(result?.startsWith(url)).toBe(true);
  });

  it('BOUNDARY: exactly "/api/media/" (empty key) is still recognised as our media prefix', () => {
    expect(withImageVersion('/api/media/')).toMatch(/^\/api\/media\/\?v=/);
  });

  it('HOSTILE: the substring "/api/media/" appearing mid-string does NOT trigger versioning (prefix, not includes)', () => {
    const url = 'https://example.com/blog/not-actually/api/media/post.png';
    expect(withImageVersion(url)).toBe(url);
  });

  it('an unrelated external URL (YouTube thumbnail, OG image) is never versioned', () => {
    const url = 'https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg';
    expect(withImageVersion(url)).toBe(url);
  });

  it('UTF-8: a Korean filename in a relative media path is versioned, bytes untouched', () => {
    const url = '/api/media/topics/t1/posts/p1/한글파일.png';
    const result = withImageVersion(url);
    expect(result?.startsWith(url)).toBe(true);
    expect(result).toContain('한글파일.png');
  });

  it('RESULT INTEGRITY: uses "?" when the URL has no query string yet', () => {
    expect(withImageVersion('/api/media/x/y')).toMatch(/\/api\/media\/x\/y\?v=/);
  });

  it('RESULT INTEGRITY: uses "&" when the URL already has a query string (EditProfileScreen cache-buster case)', () => {
    const result = withImageVersion('/api/media/x/y?t=123');
    expect(result).toContain('?t=123&v=');
  });
});
