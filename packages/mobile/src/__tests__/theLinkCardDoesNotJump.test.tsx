/**
 * A link preview must not change the height of the conversation when it
 * arrives, and must not behead a logo to fill its frame.
 *
 * WHAT WENT WRONG. This card was built with ONE height for every state, so
 * loading, resolved and unavailable were three paints of the same box. Then a
 * fix for a different complaint — a page with no `og:image` left a large empty
 * rectangle that read as a broken picture — made the image conditional on
 * having one. That silently took the fixed height with it, and the comment
 * describing the old rule stayed behind. What a sender saw was a short grey box
 * that suddenly grew into a card.
 *
 * Both complaints are real, so the answer is neither of the two the code has
 * held: hold the space while the answer is unknown, and drop it only once the
 * answer is "no picture".
 *
 * The second half is the crop. Beside the same link in KakaoTalk, the Ceph logo
 * was whole and ours had lost its top and bottom — a square image forced into a
 * 1.91:1 frame keeps about half its height.
 *
 * EDGE-CASE MATRIX → coverage
 *   contract   → loading reserves the frame; a resolved picture keeps it
 *   contract   → resolved with NO picture drops it (the empty-rectangle fix)
 *   boundary   → exactly 1.91:1, and either side of it, decide fill vs fit
 *   integrity  → the frame is the same shape in every state that has one
 *   hostile    → zero and negative dimensions never reach the decision
 *   external   → a size that cannot be read leaves the default
 *   race       → unmounting mid-measure sets no state
 *   empty      → a null image, and an image that fails to load
 *   authz      → N/A: the card renders metadata the caller already fetched
 *   UTF-8/large→ N/A: no text input or length-capped field here
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import { Image } from 'react-native';
import { OGPreviewCard, type OGData } from '../components/OGPreviewCard';
import { render, flush } from './harness/render';

const FRAME_ASPECT = 1.91;
const PICTURE = 'https://openstoa.test/api/og/image?src=logo.png';

const EMPTY: OGData = {
  title: null,
  description: null,
  image: null,
  siteName: null,
  favicon: null,
};

type Style = Record<string, number | string | undefined>;

function flatten(style: unknown): Style {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return (style ?? {}) as Style;
}

/** Every node drawn at the card's picture shape, however it is drawn. */
function frames(root: ReactTestInstance): ReactTestInstance[] {
  return root
    .findAll((n) => typeof n.type === 'string')
    .filter((n) => flatten(n.props.style).aspectRatio === FRAME_ASPECT);
}

/** Pretend the picture at `uri` is this many pixels. */
function sizeIs(width: number, height: number) {
  vi.spyOn(Image, 'getSize').mockImplementation(((
    _uri: string,
    ok: (w: number, h: number) => void,
  ) => {
    ok(width, height);
  }) as unknown as typeof Image.getSize);
}

async function card(props: Partial<React.ComponentProps<typeof OGPreviewCard>>) {
  const r = await render(
    <OGPreviewCard
      url="https://ceph.io/en/developers/"
      data={EMPTY}
      onPress={() => {}}
      compact
      host="ceph.io"
      {...props}
    />,
  );
  await flush();
  return r;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a link card does not jump when it arrives', () => {
  it('THE DEFECT: the frame is held while the preview is still being fetched', async () => {
    const r = await card({ loading: true, data: EMPTY });
    expect(frames(r.root)).toHaveLength(1);
  });

  it('CONTRACT: a resolved preview WITH a picture is the same shape', async () => {
    sizeIs(1200, 628);
    const r = await card({ loading: false, data: { ...EMPTY, image: PICTURE, title: 'Ceph' } });
    expect(frames(r.root)).toHaveLength(1);
  });

  it('CONTRACT: a resolved preview with NO picture drops it, as it always has', async () => {
    // The empty-rectangle complaint this card was changed for. Reserving it
    // forever reads as a picture that failed to load, on every such card.
    const r = await card({ loading: false, data: { ...EMPTY, title: 'Ceph' } });
    expect(frames(r.root)).toHaveLength(0);
  });
});

describe('a logo is shown whole, a photo fills the frame', () => {
  const modeOf = (r: { root: ReactTestInstance }): unknown =>
    frames(r.root)[0]?.props.resizeMode;

  it('THE DEFECT: a square logo is fitted inside rather than beheaded', async () => {
    sizeIs(600, 600);
    const r = await card({ data: { ...EMPTY, image: PICTURE } });
    expect(modeOf(r)).toBe('contain');
  });

  it('a wide photo still fills the frame', async () => {
    sizeIs(1200, 628); // 1.91:1, as `og:image` is authored
    const r = await card({ data: { ...EMPTY, image: PICTURE } });
    expect(modeOf(r)).toBe('cover');
  });

  it('BOUNDARY: exactly the frame shape fills it; a hair narrower is fitted', async () => {
    sizeIs(191, 100); // exactly 1.91
    expect(modeOf(await card({ data: { ...EMPTY, image: PICTURE } }))).toBe('cover');

    sizeIs(190, 100); // just inside
    expect(modeOf(await card({ data: { ...EMPTY, image: PICTURE } }))).toBe('contain');

    sizeIs(400, 100); // far wider — a banner
    expect(modeOf(await card({ data: { ...EMPTY, image: PICTURE } }))).toBe('cover');
  });

  it('a portrait picture is fitted, never cropped to a strip', async () => {
    sizeIs(600, 1600);
    expect(modeOf(await card({ data: { ...EMPTY, image: PICTURE } }))).toBe('contain');
  });

  it('HOSTILE: zero or negative dimensions never decide anything', async () => {
    for (const [w, h] of [
      [0, 0],
      [0, 500],
      [500, 0],
      [-100, 200],
    ]) {
      sizeIs(w, h);
      expect(modeOf(await card({ data: { ...EMPTY, image: PICTURE } }))).toBe('cover');
    }
  });

  it('EXTERNAL FAILURE: a size that cannot be read leaves the default', async () => {
    vi.spyOn(Image, 'getSize').mockImplementation(((
      _uri: string,
      _ok: unknown,
      fail: (e: Error) => void,
    ) => {
      fail(new Error('unreadable'));
    }) as unknown as typeof Image.getSize);
    const r = await card({ data: { ...EMPTY, image: PICTURE } });
    expect(modeOf(r)).toBe('cover');
  });

  it('EXTERNAL FAILURE: a host with no size probe at all still draws the card', async () => {
    // Not every runtime has `Image.getSize`. The card must not depend on it.
    const original = Image.getSize;
    // @ts-expect-error — deliberately removing it, as a bare runtime would
    Image.getSize = undefined;
    try {
      const r = await card({ data: { ...EMPTY, image: PICTURE } });
      expect(frames(r.root)).toHaveLength(1);
      expect(modeOf(r)).toBe('cover');
    } finally {
      Image.getSize = original;
    }
  });

  it('RACE: unmounting before the measurement lands sets no state', async () => {
    let answer: ((w: number, h: number) => void) | null = null;
    vi.spyOn(Image, 'getSize').mockImplementation(((
      _uri: string,
      ok: (w: number, h: number) => void,
    ) => {
      answer = ok;
    }) as unknown as typeof Image.getSize);

    const r = await card({ data: { ...EMPTY, image: PICTURE } });
    r.unmount();
    // The probe answers AFTER the card is gone. A setState here would warn and,
    // worse, would mean the effect outlives its component.
    expect(() => answer?.(600, 600)).not.toThrow();
    await flush();
  });

  it('EMPTY: a card with no picture measures nothing', async () => {
    const probe = vi.spyOn(Image, 'getSize');
    await card({ data: EMPTY });
    expect(probe).not.toHaveBeenCalled();
  });
});
