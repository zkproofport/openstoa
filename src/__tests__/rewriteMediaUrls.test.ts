/**
 * `rewriteUrl` / `rewriteMediaImages` (scripts/rewrite-media-urls.ts, M-5) —
 * the pure string-rewrite core of the pre-bucket-flip backfill. DB wiring is
 * intentionally untested here (no local R2/Postgres fixture for a one-time
 * operator script); what has to be right is the text transform, which is
 * fully exercised without touching either.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   boundary          → zero occurrences, exactly one, many in one string
 *   hostile input      → old-base-as-SUBSTRING-of-a-longer-domain must NOT
 *                       be rewritten (anchor requirement); a value with no
 *                       old base at all is untouched byte-for-byte
 *   empty/null/undef   → empty string value, undefined images array, empty
 *                       images array
 *   UTF-8              → surrounding Korean/emoji text is preserved verbatim
 *   large               → a value with many occurrences (100) rewrites all
 *   result integrity    → the returned count always equals the number of
 *                       anchor occurrences actually replaced
 */
import { describe, it, expect } from 'vitest';
import { rewriteUrl, rewriteMediaImages } from '../../scripts/rewrite-media-urls';

const OLD = 'https://media.zkproofport.app';
const NEW = 'https://openstoa.xyz/api/media';

describe('rewriteUrl', () => {
  it('BOUNDARY: no occurrence — value returned unchanged, count 0', () => {
    const r = rewriteUrl('hello world', OLD, NEW);
    expect(r).toEqual({ next: 'hello world', count: 0 });
  });

  it('BOUNDARY: exactly one occurrence under /topics/', () => {
    const value = `<img src="${OLD}/topics/T1/posts/U1/a.jpg">`;
    const r = rewriteUrl(value, OLD, NEW);
    expect(r.count).toBe(1);
    expect(r.next).toBe(`<img src="${NEW}/topics/T1/posts/U1/a.jpg">`);
  });

  it('BOUNDARY: exactly one occurrence under /users/', () => {
    const value = `${OLD}/users/0xabc/profile/U1/me.png`;
    const r = rewriteUrl(value, OLD, NEW);
    expect(r.count).toBe(1);
    expect(r.next).toBe(`${NEW}/users/0xabc/profile/U1/me.png`);
  });

  it('LARGE: many occurrences in one string — every one is rewritten', () => {
    const one = `${OLD}/topics/T1/posts/U1/a.jpg `;
    const value = one.repeat(100);
    const r = rewriteUrl(value, OLD, NEW);
    expect(r.count).toBe(100);
    expect(r.next).not.toContain(OLD);
    expect(r.next.split(NEW).length - 1).toBe(100);
  });

  it('HOSTILE: old base as a mere SUBSTRING of a longer domain is not rewritten', () => {
    // Not one of our object URLs — a domain that merely starts with ours.
    const value = `visit ${OLD}.evil.example/topics/x/posts/y/a.jpg for more`;
    const r = rewriteUrl(value, OLD, NEW);
    expect(r.count).toBe(0);
    expect(r.next).toBe(value);
  });

  it('HOSTILE: old base mentioned as prose, not as a URL prefix, is not rewritten', () => {
    const value = `our CDN is ${OLD} by the way`;
    const r = rewriteUrl(value, OLD, NEW);
    expect(r.count).toBe(0);
    expect(r.next).toBe(value);
  });

  it('EMPTY: empty string value', () => {
    expect(rewriteUrl('', OLD, NEW)).toEqual({ next: '', count: 0 });
  });

  it('EMPTY: empty old base never matches (guards a misconfigured run)', () => {
    expect(rewriteUrl(`${OLD}/topics/x/posts/y/a.jpg`, '', NEW)).toEqual({
      next: `${OLD}/topics/x/posts/y/a.jpg`,
      count: 0,
    });
  });

  it('UTF-8: surrounding Korean/emoji text is preserved verbatim', () => {
    const value = `사진 보세요 🖼️ <img src="${OLD}/topics/T1/posts/U1/사진.jpg"> 감사합니다`;
    const r = rewriteUrl(value, OLD, NEW);
    expect(r.count).toBe(1);
    expect(r.next).toBe(`사진 보세요 🖼️ <img src="${NEW}/topics/T1/posts/U1/사진.jpg"> 감사합니다`);
  });

  it('INTEGRITY: count always equals the number of anchors actually replaced', () => {
    const value = `${OLD}/topics/a/posts/b/1.jpg and ${OLD}/users/c/profile/d/2.jpg and unrelated text`;
    const r = rewriteUrl(value, OLD, NEW);
    expect(r.count).toBe(2);
    expect(r.next.split(NEW).length - 1).toBe(2);
  });
});

describe('rewriteMediaImages', () => {
  it('EMPTY: undefined images array is returned as-is', () => {
    expect(rewriteMediaImages(undefined, OLD, NEW)).toEqual({ next: undefined, count: 0 });
  });

  it('EMPTY: empty images array is returned as-is', () => {
    expect(rewriteMediaImages([], OLD, NEW)).toEqual({ next: [], count: 0 });
  });

  it('BOUNDARY: mixed array — only entries with the old base are rewritten', () => {
    const images = [
      `${OLD}/topics/T1/posts/U1/a.jpg`,
      'https://external-cdn.example/b.jpg',
      `${OLD}/topics/T1/posts/U2/c.jpg`,
    ];
    const r = rewriteMediaImages(images, OLD, NEW);
    expect(r.count).toBe(2);
    expect(r.next).toEqual([
      `${NEW}/topics/T1/posts/U1/a.jpg`,
      'https://external-cdn.example/b.jpg',
      `${NEW}/topics/T1/posts/U2/c.jpg`,
    ]);
  });
});
