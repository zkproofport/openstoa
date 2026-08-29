/**
 * A picture the author attached must reach a reader who cannot see it.
 *
 * The gallery has always honoured a description written into the post body.
 * What it did NOT do was say anything at all about a photo attached through
 * the composer — the common case, and the one where the picture usually IS
 * the post. On the web the same photo carried `alt=""`, which is worse than
 * silence: it is an instruction to skip the element.
 *
 * These tests hold the three outcomes apart, because collapsing any two of
 * them is exactly how the bug came back:
 *
 *   a description   announce it, verbatim
 *   `alt=""`        the author said decorative — hide it
 *   nothing at all  say where the picture sits in the set
 */
import React from 'react';
import { describe, it, expect, beforeAll } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import { HostProvider } from '@openstoa/miniapp-bridge';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { render } from './harness/render';
import { hostDouble } from './harness/screen';
import { MediaGallery } from '../components/MediaGallery';
import enResources from '../i18n/locales/en.json';

/*
 * The REAL English copy, not a stub.
 *
 * Without this, `t()` returns the key it was given, every photo gets the
 * identical string `openstoa.a11y.photoInPost`, and a test asserting "each
 * photo says something" passes while users hear a dotted key path. Loading the
 * shipped bundle also means a typo in a key name fails here rather than on a
 * device.
 */
beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: enResources } },
      interpolation: { escapeValue: false },
    });
  } else {
    i18n.addResourceBundle('en', 'translation', enResources, true, true);
  }
});

/** `GatedImage` reads the host bridge for the origin and the Bearer. */
async function gallery(element: React.ReactElement) {
  const host = hostDouble();
  return render(<HostProvider api={host.api as never}>{element}</HostProvider>);
}

const A = 'https://example.test/a.jpg';
const B = 'https://example.test/b.jpg';
const C = 'https://example.test/c.jpg';

/**
 * Every image node the gallery drew, in order.
 *
 * Matched by host-element NAME, the same widening the rest of the harness
 * uses: the react-native stand-in names its elements after the RN components,
 * and `Image` is not a member of React's DOM element union.
 */
function pictures(root: ReactTestInstance) {
  return root
    .findAll((n) => typeof n.type === 'string' && (n.type as string) === 'Image')
    .map((n) => ({
      uri: String((n.props.source as { uri?: string } | undefined)?.uri ?? ''),
      label: n.props.accessibilityLabel as string | undefined,
      hidden: n.props.accessibilityElementsHidden === true,
    }));
}

describe('a photo is never announced as nothing', () => {
  it('an author description is read out word for word', async () => {
    const r = await gallery(
      <MediaGallery images={[A]} imageAlts={{ [A]: 'The queue outside the polling station' }} />,
    );
    const shown = pictures(r.root);
    expect(shown.length).toBeGreaterThan(0);
    for (const p of shown) {
      expect(p.label).toBe('The queue outside the polling station');
      expect(p.hidden).toBe(false);
    }
  });

  it('UTF-8: Korean, emoji and mixed scripts survive intact', async () => {
    const alt = '투표소 앞 줄 🗳️ queue';
    const r = await gallery(<MediaGallery images={[A]} imageAlts={{ [A]: alt }} />);
    for (const p of pictures(r.root)) expect(p.label).toBe(alt);
  });

  it('HOSTILE: a description full of markup is a label, never markup', async () => {
    const alt = '<script>alert(1)</script> & <img src=x onerror=y> 100% _ \\';
    const r = await gallery(<MediaGallery images={[A]} imageAlts={{ [A]: alt }} />);
    for (const p of pictures(r.root)) expect(p.label).toBe(alt);
  });

  it('EMPTY IS A DECISION: alt="" hides the picture instead of announcing it', async () => {
    const r = await gallery(<MediaGallery images={[A]} imageAlts={{ [A]: '' }} />);
    const shown = pictures(r.root);
    expect(shown.length).toBeGreaterThan(0);
    for (const p of shown) {
      expect(p.hidden).toBe(true);
      expect(p.label).toBeUndefined();
    }
  });

  it('ABSENT IS NOT EMPTY: no description still gets a label, and is not hidden', async () => {
    const r = await gallery(<MediaGallery images={[A]} />);
    const shown = pictures(r.root);
    expect(shown.length).toBeGreaterThan(0);
    for (const p of shown) {
      expect(p.hidden).toBe(false);
      expect(p.label).toBeTruthy();
      expect(String(p.label).trim()).not.toBe('');
    }
  });

  it('the fallback never leaks the file name', async () => {
    const r = await gallery(<MediaGallery images={['https://example.test/IMG_4021.jpeg']} />);
    for (const p of pictures(r.root)) {
      expect(String(p.label)).not.toContain('IMG_4021');
      expect(String(p.label)).not.toContain('.jpeg');
    }
  });

  it('a described photo and an undescribed one in the same post keep their own answers', async () => {
    const r = await gallery(
      <MediaGallery images={[A, B, C]} imageAlts={{ [B]: 'A hand-drawn map' }} />,
    );
    const byUri = new Map(pictures(r.root).map((p) => [p.uri, p]));
    expect(byUri.get(B)?.label).toBe('A hand-drawn map');
    expect(byUri.get(A)?.label).toBeTruthy();
    expect(byUri.get(A)?.label).not.toBe('A hand-drawn map');
    expect(byUri.get(C)?.label).toBeTruthy();
    expect(byUri.get(C)?.label).not.toBe(byUri.get(A)?.label);
  });

  it('BOUNDARY: one photo, three photos, and none at all', async () => {
    const one = await gallery(<MediaGallery images={[A]} />);
    expect(pictures(one.root).length).toBeGreaterThan(0);

    const three = await gallery(<MediaGallery images={[A, B, C]} />);
    const labels = pictures(three.root).map((p) => p.label);
    expect(labels.every(Boolean)).toBe(true);
    // Position is what distinguishes them, so they must not all read the same.
    expect(new Set(labels).size).toBeGreaterThan(1);

    const none = await gallery(<MediaGallery images={[]} />);
    expect(pictures(none.root)).toEqual([]);
  });

  it('a description that is only whitespace is still announced, not treated as empty', async () => {
    // `alt=" "` is not the decorative marker — only the empty string is.
    const r = await gallery(<MediaGallery images={[A]} imageAlts={{ [A]: ' ' }} />);
    for (const p of pictures(r.root)) {
      expect(p.hidden).toBe(false);
      expect(p.label).toBe(' ');
    }
  });
});

/**
 * The two places that decide how long a description may be.
 *
 * The SERVER refuses anything longer rather than trimming it; the composer's
 * field just stops accepting characters that would be refused. Nothing connects
 * the two numbers at runtime — the mini-app ships separately and cannot import
 * from the web codebase — so raising one and forgetting the other would leave
 * the field stuck at the old limit with no error anywhere.
 */
describe('the description limit is the same on both sides', () => {
  it('the composer stops where the server refuses', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const read = (rel: string) =>
      fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

    const server = /MAX_IMAGE_ALT = (\d+)/.exec(
      read('../../../../src/lib/normalisePostMedia.ts'),
    );
    const composer = /MAX_IMAGE_ALT = (\d+)/.exec(
      read('../screens/topics/PostCreateScreen.tsx'),
    );

    expect(server, 'the server no longer declares MAX_IMAGE_ALT').toBeTruthy();
    expect(composer, 'the composer no longer declares MAX_IMAGE_ALT').toBeTruthy();
    expect(composer![1]).toBe(server![1]);
  });
});
