// @vitest-environment jsdom
/**
 * A description the author typed must be the one a screen reader says.
 *
 * The galleries fall back to a positional label ("Photo 2 of 3") when nobody
 * described a picture. That fallback is the safety net, not the answer — if it
 * shadows a real description the author wrote, the feature is decorative.
 *
 * Edge-case matrix rows covered here:
 *   contract   — the author's words win over the positional fallback, in the
 *                feed row, the detail carousel and the full-screen viewer
 *   empty      — a description of "" means DECORATIVE and must not be replaced
 *                by the fallback; absent means "nobody said", and gets it
 *   boundary   — one photo, several photos, a description on only one of them
 *   UTF-8      — Korean and emoji survive to the attribute unchanged
 *   hostile    — markup in a description stays text, never markup
 *   integrity  — a description keyed to a URL that is not shown is ignored
 *   authz / large / race — N/A: these components take props and render; no
 *                authorisation branch, no async work, no free-text input of
 *                their own (the cap is enforced server-side and in the editor)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import MediaGallery from '@/components/post/MediaGallery';
import ImageLightbox from '@/components/ImageLightbox';
import { TestProviders } from './harness/providers';

const A = 'https://cdn.test/a.jpg';
const B = 'https://cdn.test/b.jpg';
const C = 'https://cdn.test/c.jpg';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function show(el: React.ReactElement) {
  await act(async () => {
    root.render(<TestProviders initialLocale="en">{el}</TestProviders>);
    await Promise.resolve();
  });
}

/**
 * Alt text of every rendered image, in document order.
 *
 * Queried from the DOCUMENT, not the container: the full-screen viewer portals
 * itself to `document.body` so it is not a descendant of any transformed
 * ancestor. Looking only inside the container finds nothing and reads as "the
 * viewer says nothing", which is a different bug from the one under test.
 */
function labels(): string[] {
  return [...document.querySelectorAll('img')].map(
    (img) => img.getAttribute('alt') ?? '(no alt attribute)',
  );
}

describe("the author's own words reach the reader", () => {
  it('the feed row says what the author wrote, not where the photo sits', async () => {
    await show(
      <MediaGallery images={[A]} imageAlts={{ [A]: 'The queue outside the hall' }} />,
    );
    expect(labels()).toContain('The queue outside the hall');
    for (const l of labels()) expect(l).not.toMatch(/Photo \d/);
  });

  it('the detail carousel says it too', async () => {
    await show(
      <MediaGallery images={[A]} imageAlts={{ [A]: 'A hand-drawn map' }} mode="detail" />,
    );
    expect(labels()).toContain('A hand-drawn map');
  });

  it('the full-screen viewer says it as well — the picture is the whole screen there', async () => {
    await show(<ImageLightbox images={[A]} imageAlts={{ [A]: 'A hand-drawn map' }} onClose={() => {}} />);
    expect(labels()).toContain('A hand-drawn map');
  });

  it('EMPTY IS A DECISION: alt="" is not replaced by the fallback', async () => {
    // The author looked and said this picture carries nothing to announce.
    await show(<MediaGallery images={[A]} imageAlts={{ [A]: '' }} />);
    for (const l of labels()) {
      expect(l).toBe('');
      expect(l).not.toMatch(/Photo/);
    }
  });

  it('ABSENT IS NOT EMPTY: no description still gets the positional label', async () => {
    await show(<MediaGallery images={[A, B]} mode="detail" />);
    const got = labels().filter((l) => l && l !== '(no alt attribute)');
    expect(got.length).toBeGreaterThan(0);
    for (const l of got) expect(/\d/.test(l)).toBe(true);
  });

  it('a described photo and an undescribed one keep their own answers', async () => {
    /*
     * The carousel draws ONE picture at a time, so this asks the question the
     * only way the component can answer it: the described photo first, then the
     * same set with an undescribed one first.
     */
    await show(
      <MediaGallery images={[A, B, C]} imageAlts={{ [A]: 'A hand-drawn map' }} mode="detail" />,
    );
    expect(labels()).toContain('A hand-drawn map');

    await show(
      <MediaGallery images={[A, B, C]} imageAlts={{ [B]: 'A hand-drawn map' }} mode="detail" />,
    );
    const undescribed = labels().filter((l) => l !== '(no alt attribute)');
    expect(undescribed.length).toBeGreaterThan(0);
    for (const l of undescribed) {
      expect(l).not.toBe('');
      expect(l).not.toBe('A hand-drawn map');
      expect(/\d/.test(l)).toBe(true);
    }
  });

  it('UTF-8: Korean and emoji arrive unchanged', async () => {
    const text = '투표소 앞 줄 🗳️';
    await show(<MediaGallery images={[A]} imageAlts={{ [A]: text }} />);
    expect(labels()).toContain(text);
  });

  it('HOSTILE: markup in a description stays text', async () => {
    const nasty = '<script>alert(1)</script> & <b>bold</b>';
    await show(<MediaGallery images={[A]} imageAlts={{ [A]: nasty }} />);
    expect(labels()).toContain(nasty);
    // It reached the attribute, not the document.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });

  it('INTEGRITY: a description for a photo that is not shown changes nothing', async () => {
    await show(<MediaGallery images={[A]} imageAlts={{ [C]: 'about a photo not here' }} />);
    for (const l of labels()) expect(l).not.toBe('about a photo not here');
  });
});
