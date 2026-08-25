// @vitest-environment jsdom
/**
 * A tall picture in a web chat bubble.
 *
 * The rule is pinned in `chatMediaLayout.test.ts`; these ask whether the web
 * APPLIES it, and whether it does so by cropping.
 *
 * The web's old failure was the sharper of the two clients': it capped HEIGHT
 * (`maxHeight: roomy ? 380 : 240`) and let width follow the intrinsic ratio, so
 * the taller the source the narrower the result — a 1179x2556 screenshot came
 * out 175px wide, a 1280x8000 one came out 61px wide. Several assertions below
 * are written specifically so that reintroducing a height-driven cap fails
 * them, not merely so that today's numbers pass.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract        → 'the box is stated on the element' + the structural guard
 *                     at the bottom, which fails if either client goes back to
 *                     a raw <img>
 *   boundary        → 4:3 and 16:9 both ways; 9:16 exactly on the bound
 *   integrity       → object-fit is cover (never contain); the box ratio is
 *                     inside the clamp for every case
 *   empty/null      → a null src; an image that fails to decode
 *   external failure→ `Image` onerror
 *   race            → unmount mid-probe
 *   hostile input   → zero and NaN natural dimensions
 *   authorization   → N/A: this component renders bytes the caller already
 *                     decrypted; it makes no access decision.
 *   UTF-8 / large   → N/A: no text input, no length-capped field.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatImage, CHAT_IMAGE_SLOT_WIDTH } from '@/components/ChatImage';
import { CHAT_MEDIA_MAX_ASPECT, CHAT_MEDIA_MIN_ASPECT } from '@/lib/chatMediaLayout';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SLOT = CHAT_IMAGE_SLOT_WIDTH;
const SRC = 'blob:https://openstoa.test/8f2c';

/**
 * jsdom does not fetch or decode images, so a real `Image` never fires
 * `onload` and `probeImageSize` would hang forever.
 *
 * The stand-in models the REFUSAL as well as the success: `decodeAs(null)`
 * fires `onerror`, which is what a truncated attachment does. A stub that only
 * ever succeeded would let a component that mishandles the failure path pass.
 */
let decoded: { width: number; height: number } | null = null;
/** Held open when set, so a test can unmount before the callback fires. */
let deferred: (() => void) | null = null;

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(_value: string) {
    const settle = () => {
      if (decoded) {
        this.naturalWidth = decoded.width;
        this.naturalHeight = decoded.height;
        this.onload?.();
      } else {
        this.onerror?.();
      }
    };
    if (deferred !== null) deferred = settle;
    else settle();
  }
}

function decodeAs(width: number, height: number) {
  decoded = { width, height };
}

let container: HTMLDivElement;
let root: Root;
const realImage = globalThis.window?.Image;

beforeEach(() => {
  decoded = null;
  deferred = null;
  (window as unknown as { Image: unknown }).Image = FakeImage;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  (window as unknown as { Image: unknown }).Image = realImage;
});

async function mount(props: Partial<React.ComponentProps<typeof ChatImage>> = {}) {
  await act(async () => {
    root.render(
      <ChatImage
        src={SRC}
        alt="Encrypted image"
        slotWidth={SLOT}
        croppedLabel="See full image"
        data-testid="pic"
        {...props}
      />,
    );
  });
  // Let the probe promise settle and the re-render land.
  await act(async () => {});
}

function frame(): HTMLElement {
  const el = container.querySelector('[data-testid="pic"]');
  if (!el) throw new Error('picture frame not rendered');
  return el as HTMLElement;
}

/**
 * The reserved box, read the way the component now states it.
 *
 * The frame no longer carries a pixel `height`. It carries a WIDTH and an
 * `aspect-ratio`, because the bubble caps its children at 85% of the column and
 * a stated height does not shrink with the width that cap imposes — a 1179x2556
 * screenshot came out 236x400, ratio 0.59 against a 0.75 bound. The height
 * these tests assert on is therefore derived from the ratio rather than read
 * from a property that is deliberately absent; jsdom computes no layout, so
 * reading `style.height` here returned NaN, not a wrong number.
 */
const boxOf = () => {
  const style = frame().style;
  const width = Number.parseFloat(style.width);
  const [w, h] = style.aspectRatio.split('/').map((part) => Number.parseFloat(part));
  return { width, height: Math.round((width * h) / w) };
};

const img = () => container.querySelector('img');
const badge = () => container.querySelector('[data-testid="chat-image-cropped-badge"]');

describe('web: a tall picture is capped and cropped', () => {
  it('a phone screenshot fills the slot width instead of shrinking to a sliver', async () => {
    decodeAs(1179, 2556);
    await mount();

    const box = boxOf();
    // THE regression. Under the old height-cap this was 175 (or 111 in a
    // non-roomy panel); any height-driven rule fails here.
    expect(box.width).toBe(SLOT);
    expect(box.height).toBe(Math.round(SLOT / CHAT_MEDIA_MIN_ASPECT));
    expect(frame().dataset.chatImageCropped).toBe('true');
  });

  it('crops rather than letterboxing', async () => {
    decodeAs(1179, 2556);
    await mount();
    // `contain` is the letterbox. If this ever reads `contain`, the picture is
    // a sliver again with bars drawn around it.
    expect(img()?.style.objectFit).toBe('cover');
    expect(img()?.style.objectFit).not.toBe('contain');
  });

  it('keeps the top of a cropped screenshot', async () => {
    decodeAs(1179, 2556);
    await mount();
    expect(img()?.style.objectPosition).toBe('top center');
    expect(frame().dataset.chatImageAnchor).toBe('top');
  });

  it('says that it cropped, so a reader knows there is more', async () => {
    decodeAs(1179, 2556);
    await mount();
    expect(badge()?.textContent).toBe('See full image');
  });

  it('gives a 10x-taller picture the SAME box — capped, not merely smaller', async () => {
    decodeAs(1280, 4000);
    await mount();
    const a = boxOf();
    decodeAs(1280, 40000);
    await mount();
    expect(boxOf()).toEqual(a);
  });

  it('the box never leaves the clamp, however extreme the source', async () => {
    for (const [w, h] of [[1000, 3000], [1000, 20000], [9000, 1000], [40000, 1000]]) {
      decodeAs(w, h);
      await mount();
      const { width, height } = boxOf();
      expect(width / height).toBeGreaterThanOrEqual(CHAT_MEDIA_MIN_ASPECT * 0.98);
      expect(width / height).toBeLessThanOrEqual(CHAT_MEDIA_MAX_ASPECT * 1.02);
    }
  });
});

describe('web: an ordinary photo is left alone', () => {
  const ordinary: ReadonlyArray<readonly [string, number, number]> = [
    ['4:3 landscape', 4032, 3024],
    ['4:3 portrait', 3024, 4032],
    ['16:9 landscape', 1920, 1080],
  ];

  for (const [name, w, h] of ordinary) {
    it(`${name} keeps its own shape, with no crop and no badge`, async () => {
      decodeAs(w, h);
      await mount();
      const box = boxOf();
      expect(box.width / box.height).toBeCloseTo(w / h, 1);
      expect(frame().dataset.chatImageCropped).toBe('false');
      expect(badge()).toBeNull();
      expect(img()?.style.objectPosition).toBe('center');
    });
  }

  it('4:3 portrait sits exactly on the bound and is not cropped', async () => {
    decodeAs(3024, 4032);
    await mount();
    expect(frame().dataset.chatImageCropped).toBe('false');
    expect(boxOf().height).toBe(Math.round(SLOT / CHAT_MEDIA_MIN_ASPECT));
  });

  it('a 16:9 PORTRAIT photo IS cropped — the stated cost of the tighter cap', async () => {
    // Not an oversight. See the bound's own comment: leaving this whole means
    // allowing a box 1.78x its width, which is the length being complained of.
    decodeAs(1080, 1920);
    await mount();
    expect(frame().dataset.chatImageCropped).toBe('true');
    expect(boxOf()).toEqual({ width: SLOT, height: Math.round(SLOT / CHAT_MEDIA_MIN_ASPECT) });
  });
});

describe('web: a wide panorama', () => {
  it('is cropped to the wide bound, centred', async () => {
    decodeAs(6000, 2000);
    await mount();
    const box = boxOf();
    expect(box.width / box.height).toBeCloseTo(CHAT_MEDIA_MAX_ASPECT, 1);
    expect(frame().dataset.chatImageAnchor).toBe('center');
    expect(badge()).not.toBeNull();
  });

  it('a 2:1 panorama is inside the bound and untouched', async () => {
    decodeAs(4000, 2000);
    await mount();
    expect(frame().dataset.chatImageCropped).toBe('false');
  });
});

describe('web: degenerate and hostile input', () => {
  it('an image that fails to decode falls back to a square, uncropped', async () => {
    decoded = null;
    await mount();
    expect(boxOf()).toEqual({ width: SLOT, height: SLOT });
    expect(badge()).toBeNull();
  });

  it('zero natural dimensions do not produce a NaN box', async () => {
    decodeAs(0, 0);
    await mount();
    const box = boxOf();
    expect(Number.isFinite(box.width)).toBe(true);
    expect(Number.isFinite(box.height)).toBe(true);
  });

  it('a null src reserves the frame and renders no picture', async () => {
    await mount({ src: null });
    expect(boxOf()).toEqual({ width: SLOT, height: SLOT });
    expect(img()).toBeNull();
  });

  it('shows the picture even when the host never reports a size', async () => {
    /*
     * The regression that cost two other suites. An earlier version awaited the
     * probe before publishing the object URL, so anywhere `load` and `error`
     * both stay silent — jsdom, a stalled decode — the <img> was never
     * rendered at all. The picture must appear; only its BOX waits on the
     * measurement.
     */
    deferred = () => {};
    decodeAs(1179, 2556);
    await mount();
    expect(img()).not.toBeNull();
    expect(img()?.getAttribute('src')).toBe(SRC);
    expect(boxOf()).toEqual({ width: SLOT, height: SLOT });
  });

  it('unmounting mid-probe does not set state afterwards', async () => {
    deferred = () => {};
    decodeAs(1179, 2556);
    await mount();
    const settle = deferred;
    await act(async () => root.unmount());
    expect(() => settle?.()).not.toThrow();
    // Re-created so `afterEach` has something to unmount.
    root = createRoot(container);
  });
});

describe('both clients still route their pictures through the shared rule', () => {
  /*
   * The channel between the rule and the two screens, checked at the join.
   *
   * The tests above prove `ChatImage` behaves. They cannot notice a screen that
   * stops using it — and that is exactly how the bug arrived, as a hand-written
   * <img> style at each picture site. Pinned at the CALL rather than at any
   * literal, so extracting a constant does not make this red.
   */
  const root_ = join(process.cwd());
  const read = (p: string) => readFileSync(join(root_, p), 'utf8');

  const surfaces: ReadonlyArray<readonly [string, string]> = [
    ['web ChatPanel', 'src/components/ChatPanel.tsx'],
    ['mini-app ChatRoomScreen', 'packages/mobile/src/screens/chat/ChatRoomScreen.tsx'],
  ];

  for (const [name, path] of surfaces) {
    it(`${name} renders its chat pictures with ChatImage`, () => {
      const source = read(path);
      // Both picture sites: the encrypted attachment and the legacy plain URL.
      expect(source.split('<ChatImage').length - 1).toBeGreaterThanOrEqual(2);
    });

    it(`${name} no longer caps a picture by height alone`, () => {
      /*
       * The shape of the defect, refused by name. `maxHeight` on a picture whose
       * width follows the intrinsic ratio IS the sliver, and a fixed square is
       * the mini-app's version of over-correcting for it.
       */
      const source = read(path);
      expect(source).not.toContain('maxHeight: roomy ?');
      expect(source).not.toMatch(/width: 220,\s*\n\s*height: 220,/);
    });
  }
});
