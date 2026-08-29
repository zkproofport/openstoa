// @vitest-environment jsdom
/**
 * `alt=""` on a user's photo is not a missing label — it is the wrong one.
 *
 * The empty string is the markup for "decorative, skip this entirely", and
 * every gallery, lightbox and body image on the web hardcoded it. A reader was
 * told there was nothing to see on posts whose whole point was the photo.
 *
 * Edge-case matrix rows covered here:
 *   boundary   — one photo, several photos, and none at all
 *   result     — with several, the labels differ, so position is actually
 *                carried rather than the same sentence repeated
 *   contract   — a video thumbnail is labelled as a video, not as a photo
 *   UTF-8      — Korean copy renders, and no label falls back to a raw key
 *   integrity  — no label leaks the file name
 *   empty      — the decorative avatar letter is hidden from the reader
 *                rather than announced as a stray character
 *   authz / hostile / large / race — N/A: these components take a list of URLs
 *                and render it. No free-text input, no authorisation branch,
 *                no async work on this path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import MediaGallery from '@/components/post/MediaGallery';
import Avatar from '@/components/Avatar';
import TopicAvatar from '@/components/TopicAvatar';
import { TestProviders } from './harness/providers';
import type { Locale } from '@/lib/i18n';

const A = 'https://example.test/a.jpg';
const B = 'https://example.test/b.jpg';
const C = 'https://example.test/c.jpg';

const HANGUL = /[가-힣]/;

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

async function show(el: React.ReactElement, locale: Locale = 'en') {
  await act(async () => {
    root.render(<TestProviders initialLocale={locale}>{el}</TestProviders>);
    await Promise.resolve();
  });
}

/**
 * Every rendered image, in document order. A missing attribute and an empty
 * one are reported differently — collapsing them is the bug under test.
 */
function labels(): string[] {
  return [...container.querySelectorAll('img')].map(
    (img) => img.getAttribute('alt') ?? '(no alt attribute)',
  );
}

describe('no photo on the web is marked decorative', () => {
  it('a single attached photo is announced, not skipped', async () => {
    await show(<MediaGallery images={[A]} />);
    const got = labels();
    expect(got.length).toBeGreaterThan(0);
    for (const l of got) {
      expect(l).not.toBe('');
      expect(l).not.toBe('(no alt attribute)');
      expect(l.trim()).not.toBe('');
    }
  });

  it('RESULT: several photos in the carousel say which one they are', async () => {
    await show(<MediaGallery images={[A, B, C]} mode="detail" />);
    const got = labels().filter((l) => l && l !== '(no alt attribute)');
    expect(got.length).toBeGreaterThan(0);
    for (const l of got) expect(/\d/.test(l)).toBe(true);
  });

  it('BOUNDARY: with no images, nothing is left carrying an empty label', async () => {
    await show(<MediaGallery images={[]} />);
    for (const l of labels()) expect(l).not.toBe('');
  });

  it('a video thumbnail says video, not photo', async () => {
    await show(<MediaGallery images={[]} videos={['https://youtu.be/aaaaaaaaaaa']} />);
    const got = labels().filter((l) => l && l !== '(no alt attribute)');
    expect(got.length).toBeGreaterThan(0);
    for (const l of got) expect(l.toLowerCase()).toContain('video');
  });

  it('INTEGRITY: a label never leaks the file name', async () => {
    await show(<MediaGallery images={['https://example.test/IMG_4021.jpeg']} />);
    for (const l of labels()) {
      expect(l).not.toContain('IMG_4021');
      expect(l).not.toContain('.jpeg');
    }
  });

  it('UTF-8: Korean copy renders and no label is a raw key path', async () => {
    await show(<MediaGallery images={[A, B]} />, 'ko');
    const got = labels().filter((l) => l && l !== '(no alt attribute)');
    expect(got.length).toBeGreaterThan(0);
    for (const l of got) {
      expect(l).not.toContain('a11y.');
      expect(HANGUL.test(l)).toBe(true);
    }
  });

  it('EMPTY IS A DECISION: the letter standing in for a missing avatar is hidden, not read', async () => {
    // The letter comes from the name printed right beside it, so reading it
    // announces "J" before "Jaehyuk" — noise, not information.
    await show(<Avatar name="Jaehyuk" />);
    expect(container.querySelector('div')?.getAttribute('aria-hidden')).toBe('true');

    await show(<TopicAvatar name="Privacy" />);
    expect(container.querySelector('div')?.getAttribute('aria-hidden')).toBe('true');
  });
});
