/**
 * `absolutizeMediaUrl` (M-6, docs/design/media-bucket-privatisation.md /
 * gated-image-credentials.md) — resolves the mini-app's own root-relative
 * media URLs (`/api/media/...`) against the app's origin, since RN's `<Image>`
 * has no page origin of its own the way a browser does.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   boundary          → root-relative path of exactly `/`; a bare relative
 *                       path with no leading slash (unrecognised shape)
 *   hostile input     → `data:` URI must never be treated as a path to
 *                       prefix; a lookalike scheme (`httpx://`) is still
 *                       treated as "already has a scheme", matching the
 *                       existing `useOgPreview.ts` helper's exact behaviour
 *   empty/null/undef  → asserted as three SEPARATE cases, not collapsed
 *   UTF-8             → Korean filename, emoji filename
 *   large             → a very long relative path
 *   external URL      → YouTube-thumbnail-shaped and OG-image-shaped
 *                       absolute URLs must pass through untouched
 *   contract          → already-relative-and-absolutized round-trips to the
 *                       same value on a second pass (idempotent)
 *   authorization     → N/A — this is a pure client-side URL-shape function;
 *                       it does not decide who may fetch anything. The M-5
 *                       gate (guest/member/non-member) is unchanged by M-6
 *                       and is covered in openstoa's `media-route.test.ts`.
 *   race              → N/A — pure, synchronous, no shared state.
 */
import { describe, it, expect } from 'vitest';
import { absolutizeMediaUrl } from '../utils/absolutizeMediaUrl';

const BASE = 'https://openstoa.xyz';

describe('absolutizeMediaUrl', () => {
  it('prefixes a root-relative media path with the base URL', () => {
    expect(absolutizeMediaUrl('/api/media/topics/t1/posts/p1/photo.jpg', BASE)).toBe(
      `${BASE}/api/media/topics/t1/posts/p1/photo.jpg`,
    );
  });

  it('BOUNDARY: a bare "/" still gets prefixed (minimal relative path)', () => {
    expect(absolutizeMediaUrl('/', BASE)).toBe(`${BASE}/`);
  });

  it('leaves an already-absolute URL untouched (mixed-state / pre-M-6 rows)', () => {
    const absolute = 'https://media.zkproofport.app/topics/t1/posts/p1/photo.jpg';
    expect(absolutizeMediaUrl(absolute, BASE)).toBe(absolute);
  });

  it('leaves a plain http:// URL untouched too, not only https://', () => {
    const absolute = 'http://10.0.0.1:9000/openstoa-dev/users/u1/uploads/x/photo.jpg';
    expect(absolutizeMediaUrl(absolute, BASE)).toBe(absolute);
  });

  it('EXTERNAL: a YouTube-thumbnail-shaped absolute URL is never absolutized against our host', () => {
    const yt = 'https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg';
    expect(absolutizeMediaUrl(yt, BASE)).toBe(yt);
  });

  it('EXTERNAL: an OG-preview-shaped absolute image URL is never absolutized against our host', () => {
    const og = 'https://cdn.example.com/og/preview-card.png';
    expect(absolutizeMediaUrl(og, BASE)).toBe(og);
  });

  it('HOSTILE: a data: URI is never treated as a relative path to prefix', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    expect(absolutizeMediaUrl(dataUri, BASE)).toBe(dataUri);
  });

  it('HOSTILE: a lookalike/typo scheme is still treated as "already has a scheme" (matches useOgPreview.ts)', () => {
    // Not a real scheme, but startsWith('http') is true — same loose check
    // the existing OG helper uses. Locking this in on purpose: this function
    // is deliberately NOT a full URL validator.
    expect(absolutizeMediaUrl('httpx://weird', BASE)).toBe('httpx://weird');
  });

  it('a bare relative path with no leading slash is left as-is (unrecognised shape, not guessed at)', () => {
    // `uploadObjectKey` / `R2_PUBLIC_URL` never produce this shape — if one
    // ever showed up, silently prefixing it would turn a bug into a
    // plausible-looking broken URL instead of a visibly missing image.
    expect(absolutizeMediaUrl('topics/t1/posts/p1/photo.jpg', BASE)).toBe(
      'topics/t1/posts/p1/photo.jpg',
    );
  });

  it('EMPTY vs NULL vs UNDEFINED are three separate cases, not collapsed into one', () => {
    expect(absolutizeMediaUrl('', BASE)).toBe('');
    expect(absolutizeMediaUrl(null, BASE)).toBe(null);
    expect(absolutizeMediaUrl(undefined, BASE)).toBe(undefined);
  });

  it('UTF-8: a Korean filename resolves correctly, bytes untouched', () => {
    const path = '/api/media/topics/t1/posts/p1/한글파일명.png';
    expect(absolutizeMediaUrl(path, BASE)).toBe(`${BASE}${path}`);
  });

  it('UTF-8: an emoji filename resolves correctly, bytes untouched', () => {
    const path = '/api/media/topics/t1/posts/p1/🎉party.png';
    expect(absolutizeMediaUrl(path, BASE)).toBe(`${BASE}${path}`);
  });

  it('LARGE: a very long relative path is still prefixed correctly, not truncated', () => {
    const longSegment = 'a'.repeat(2000);
    const path = `/api/media/topics/t1/posts/p1/${longSegment}.png`;
    const result = absolutizeMediaUrl(path, BASE);
    expect(result).toBe(`${BASE}${path}`);
    expect(result?.length).toBe(BASE.length + path.length);
  });

  it('CONTRACT: absolutizing twice is idempotent — the second pass sees an already-absolute URL', () => {
    const once = absolutizeMediaUrl('/api/media/topics/t1/posts/p1/photo.jpg', BASE);
    const twice = absolutizeMediaUrl(once, BASE);
    expect(twice).toBe(once);
  });

  it('a query string on a relative path survives the prefix (cache-buster case, EditProfileScreen)', () => {
    expect(absolutizeMediaUrl('/api/media/users/u1/profile/x/me.png?t=123', BASE)).toBe(
      `${BASE}/api/media/users/u1/profile/x/me.png?t=123`,
    );
  });
});
