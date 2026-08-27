/**
 * A picture keeps the words its author wrote for it.
 *
 * THE DEFECT. Pulling images out of a post body reached straight for the `src`
 * attribute:
 *
 *     /<img[^>]+src=["']([^"']+)["']/gi
 *
 * so `alt` was invisible to it — not dropped by a decision, but unreachable by
 * the pattern, whichever side of the tag it sat on. The web kept the attribute
 * in its HTML and the phone threw it away, so the same post was described on
 * one screen and silent on the other. Somebody using a screen reader heard
 * "image" where a sighted reader saw a caption.
 *
 * THREE STATES, NOT TWO, and conflating the middle one is the subtle half:
 *
 *   no `alt` attribute   the author said nothing → leave the platform default
 *   `alt=""`             the author said this picture carries NO meaning → hide
 *                        it from screen readers rather than announcing "image"
 *   `alt="a chart"`      announce it
 *
 * Substituting a filename for any of these is worse than silence: a reader
 * hearing "IMG underscore 4021 dot jpeg" cannot tell that from a real caption.
 *
 * WHY THIS FILE IS `.tsx` DESPITE RENDERING NOTHING. The web suite excludes
 * `packages/mobile/**\/*.test.tsx` and nothing else, because the mini-app's
 * component tests need `react-native` aliased and the web config cannot do
 * that. Named `.test.ts`, this file was picked up by the web run, which then
 * died trying to import `react-native` from `PostContent.tsx` — 5,515 cases
 * green and the suite still red, on a file that had nothing to do with the web.
 * The extension is what decides which runner sees it.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → alt is read whether it sits before or after src
 *   boundary   → `alt=""` survives as an empty string, distinct from absent
 *   boundary   → no alt attribute → undefined, not ''
 *   hostile    → entities are decoded, and `&amp;lt;` is not double-decoded
 *   hostile    → single quotes, uppercase tags, extra attributes, self-closing
 *   累積       → SIX images each keep their OWN description. The axis that
 *                matters: a bug that applied the first alt to every image
 *                passes any one-image test
 *   integrity  → an image with no src is skipped entirely rather than becoming
 *                an entry with an empty URL
 */
import { describe, it, expect } from 'vitest';
import { extractMediaItems } from '../components/PostContent';

const imagesOf = (html: string) => extractMediaItems(html).filter((m) => m.type === 'image');

describe('an extracted image keeps its description', () => {
  it('CONTRACT: alt after src', () => {
    const [img] = imagesOf('<p><img src="/api/media/a.png" alt="a bar chart"></p>');
    expect(img.src).toBe('/api/media/a.png');
    expect(img.alt).toBe('a bar chart');
  });

  it('CONTRACT: alt BEFORE src is read just the same', () => {
    /*
     * The old pattern anchored on `src` and consumed everything before it, so
     * an author whose editor wrote the attributes the other way round lost the
     * description — and which way round it comes out is an editor's choice
     * nobody controls.
     */
    const [img] = imagesOf('<img alt="a bar chart" src="/api/media/a.png">');
    expect(img.alt).toBe('a bar chart');
    expect(img.src).toBe('/api/media/a.png');
  });

  it('BOUNDARY: alt="" stays an empty string — the author marked it decorative', () => {
    // Distinct from "no alt". Collapsing them makes a screen reader announce a
    // picture the author explicitly asked it to skip.
    const [img] = imagesOf('<img src="/x.png" alt="">');
    expect(img.alt).toBe('');
    expect(img.alt).not.toBeUndefined();
  });

  it('BOUNDARY: no alt attribute at all is undefined, not an empty string', () => {
    const [img] = imagesOf('<img src="/x.png">');
    expect(img.alt).toBeUndefined();
  });

  it('ACCUMULATING: six images each keep their OWN description', () => {
    /*
     * THE AXIS. Code that captured the first alt and reused it — a variable
     * declared outside the loop, a regex without the global flag — passes every
     * single-image case in this file and mislabels a whole gallery. Wrong
     * descriptions are worse than none: the reader cannot see the picture and
     * has no way to notice.
     */
    const html = Array.from(
      { length: 6 },
      (_, i) => `<img src="/img-${i}.png" alt="사진 ${i}">`,
    ).join('<p>text</p>');

    const imgs = imagesOf(html);

    expect(imgs).toHaveLength(6);
    expect(imgs.map((m) => m.alt)).toEqual([
      '사진 0',
      '사진 1',
      '사진 2',
      '사진 3',
      '사진 4',
      '사진 5',
    ]);
    // And each description is still attached to its own picture.
    for (const [i, m] of imgs.entries()) {
      expect(m.src).toBe(`/img-${i}.png`);
    }
  });

  it('ACCUMULATING: a described picture beside an undescribed one does not lend it words', () => {
    const imgs = imagesOf('<img src="/a.png" alt="a chart"><img src="/b.png">');
    expect(imgs.map((m) => m.alt)).toEqual(['a chart', undefined]);
  });

  it('HOSTILE: entities are decoded, and an escaped entity is not decoded twice', () => {
    /*
     * `&amp;lt;` is an author writing the literal text `&lt;`. Resolving `&amp;`
     * before `&lt;` turns it into `<` — the classic double-decode, and here it
     * would be read aloud as a tag that the author never wrote.
     */
    expect(imagesOf('<img src="/a.png" alt="Q&amp;A chart">')[0].alt).toBe('Q&A chart');
    expect(imagesOf('<img src="/a.png" alt="&amp;lt;">')[0].alt).toBe('&lt;');
    expect(imagesOf('<img src="/a.png" alt="&quot;quoted&quot;">')[0].alt).toBe('"quoted"');
  });

  it('HOSTILE: single quotes, uppercase tags, extra attributes, self-closing', () => {
    expect(imagesOf("<IMG SRC='/a.png' ALT='shouty'/>")[0].alt).toBe('shouty');
    expect(
      imagesOf('<img class="w-full" data-x="1" src="/a.png" width="20" alt="between others">')[0]
        .alt,
    ).toBe('between others');
  });

  it('INTEGRITY: an img with no src is skipped, not added with an empty URL', () => {
    // An entry with an empty URL renders as a broken tile that cannot be tapped
    // and, worse, occupies a slot in the gallery count.
    expect(imagesOf('<img alt="orphan"><img src="/real.png" alt="real">')).toEqual([
      { type: 'image', src: '/real.png', thumbnail: '/real.png', alt: 'real' },
    ]);
  });

  it('BOUNDARY: a post with no images at all yields none', () => {
    expect(imagesOf('<p>글만 있습니다</p>')).toEqual([]);
    expect(imagesOf('')).toEqual([]);
  });
});
