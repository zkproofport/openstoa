/**
 * `isGatedMediaUrl` / `gatedMediaHeaders` — the one decision that keeps this
 * app's session token out of somebody else's server logs.
 *
 * Every image URL the mini-app renders arrives from one of three places, and
 * only the first is ours: a stored `/api/media/...` path minted by
 * `uploadToR2`, an author-written `<img src>` inside a post body, and a
 * third-party OG preview. The token goes to the first and to nothing else, so
 * the interesting cases here are the near-misses — a host that merely starts
 * with ours, a path that merely starts with the route — not the happy path.
 */
import { describe, it, expect } from 'vitest';
import { isGatedMediaUrl, gatedMediaHeaders, MEDIA_ROUTE_PREFIX } from '../utils/gatedMedia';

const BASE = 'https://openstoa.test';
const TOKEN = 'jwt-abc.def.ghi';
const OWN = `${BASE}/api/media/topics/11111111-2222-4333-8444-555555555555/posts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/photo.jpg`;

describe('isGatedMediaUrl', () => {
  it('matches this app’s own media route', () => {
    expect(isGatedMediaUrl(OWN, BASE)).toBe(true);
  });

  it('matches an avatar too — ungated server-side, but still ours', () => {
    // `AVATAR_IS_UNGATED` in the media route skips the check for these, which
    // is exactly why avatars kept working when post images went blank. Sending
    // the header anyway costs nothing, and means the app does not silently
    // break the day that decision is revisited.
    expect(isGatedMediaUrl(`${BASE}/api/media/users/0xnullifier/profile/x/me.png`, BASE)).toBe(true);
  });

  it('keeps a query string — the profile screen cache-busts with one', () => {
    expect(isGatedMediaUrl(`${BASE}/api/media/users/u1/profile/x/me.png?t=1723`, BASE)).toBe(true);
  });

  it('carries a UTF-8 filename', () => {
    expect(isGatedMediaUrl(`${BASE}/api/media/topics/t1/posts/p1/사진.jpg`, BASE)).toBe(true);
    expect(isGatedMediaUrl(`${BASE}/api/media/topics/t1/posts/p1/📸.png`, BASE)).toBe(true);
  });

  it('survives a very long key', () => {
    const long = `${BASE}/api/media/topics/t1/posts/p1/${'a'.repeat(4000)}.jpg`;
    expect(isGatedMediaUrl(long, BASE)).toBe(true);
  });

  // ── the near-misses ──────────────────────────────────────────────────────

  it('refuses a host that merely has ours as a prefix', () => {
    expect(isGatedMediaUrl('https://openstoa.test.evil.example/api/media/x/y/z.jpg', BASE)).toBe(false);
  });

  it('refuses a host that embeds ours elsewhere', () => {
    expect(isGatedMediaUrl('https://evil.example/https://openstoa.test/api/media/x.jpg', BASE)).toBe(false);
    expect(isGatedMediaUrl('https://evil.example/api/media/topics/t/posts/p/x.jpg', BASE)).toBe(false);
  });

  it('refuses a path that merely starts with the route name', () => {
    // The trailing slash in MEDIA_ROUTE_PREFIX is what does this.
    expect(MEDIA_ROUTE_PREFIX.endsWith('/')).toBe(true);
    expect(isGatedMediaUrl(`${BASE}/api/mediaproxy/x.jpg`, BASE)).toBe(false);
    expect(isGatedMediaUrl(`${BASE}/api/media`, BASE)).toBe(false);
  });

  it('refuses another route on our own origin', () => {
    // `/api/og/image` is public by design (`src/middleware.ts` PUBLIC_PATHS)
    // and proxies an arbitrary third-party `?src=` — precisely the URL a token
    // must not ride along with.
    expect(isGatedMediaUrl(`${BASE}/api/og/image?src=https://elsewhere/x.png`, BASE)).toBe(false);
  });

  it('refuses local and inline sources', () => {
    expect(isGatedMediaUrl('file:///var/mobile/Containers/tmp/pick.jpg', BASE)).toBe(false);
    expect(isGatedMediaUrl('data:image/png;base64,iVBORw0KGgo=', BASE)).toBe(false);
  });

  it('refuses a path that never got absolutized', () => {
    // A relative path reaching here means `absolutizeMediaUrl` had no base to
    // work with. Failing closed keeps the token off a URL nobody resolved.
    expect(isGatedMediaUrl('/api/media/topics/t1/posts/p1/photo.jpg', BASE)).toBe(false);
  });

  it('refuses empty, null and undefined separately', () => {
    expect(isGatedMediaUrl('', BASE)).toBe(false);
    expect(isGatedMediaUrl(null, BASE)).toBe(false);
    expect(isGatedMediaUrl(undefined, BASE)).toBe(false);
  });

  it('refuses everything when the base url is empty', () => {
    // An empty base would otherwise turn the check into "starts with
    // /api/media/", which any host could satisfy.
    expect(isGatedMediaUrl(OWN, '')).toBe(false);
    expect(isGatedMediaUrl('/api/media/topics/t/posts/p/x.jpg', '')).toBe(false);
  });

  it('tolerates a base url with a trailing slash', () => {
    expect(isGatedMediaUrl(OWN, `${BASE}/`)).toBe(true);
  });
});

describe('gatedMediaHeaders', () => {
  it('carries the Bearer for our own media route', () => {
    expect(gatedMediaHeaders(OWN, BASE, TOKEN)).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it('returns undefined — not an empty object — for a foreign url', () => {
    // `{ uri }` and `{ uri, headers: {} }` are different values to React
    // Native's image cache; the pass-through case must stay the source it was.
    expect(gatedMediaHeaders('https://elsewhere.example/x.png', BASE, TOKEN)).toBeUndefined();
  });

  it('returns undefined for a guest, on our own route', () => {
    // Correct rather than degraded: the route serves public-topic images and
    // avatars with no session at all.
    expect(gatedMediaHeaders(OWN, BASE, null)).toBeUndefined();
  });

  it('returns undefined for an empty token', () => {
    expect(gatedMediaHeaders(OWN, BASE, '')).toBeUndefined();
  });

  it('never leaks the token to a third-party url even with a session', () => {
    for (const uri of [
      'https://openstoa.test.evil.example/api/media/x.jpg',
      'https://evil.example/api/media/x.jpg',
      'http://openstoa.test/api/media/x.jpg', // scheme differs from the base
      'data:image/png;base64,iVBORw0KGgo=',
      'file:///tmp/x.jpg',
    ]) {
      expect(gatedMediaHeaders(uri, BASE, TOKEN)).toBeUndefined();
    }
  });
});
