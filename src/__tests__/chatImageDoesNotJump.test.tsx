// @vitest-environment jsdom
/*
 * WHY THIS EXISTS. The web twin of
 * `packages/mobile/src/__tests__/chatImageDoesNotJump.test.tsx`.
 *
 * Putting the sender's dimensions in the attachment envelope fixed the FIRST
 * window — `ChatPanel` reserves the right-shaped row before the ciphertext is
 * fetched. It did nothing for the SECOND: `ChatImage` measures the decoded
 * picture itself, and until that measurement lands it has nothing to reserve
 * from and falls back to the shared square. Anything that is not square
 * therefore changed shape at decode time. Measured on the mini-app, whose rule
 * is the same module: a screenshot's row grew 80px, a panorama's shrank 144px.
 *
 * `chatTallImage.test.tsx` already proves the box is the RIGHT SHAPE once the
 * bytes are in. It decodes synchronously, so it is never in the state this file
 * puts the component in: probe outstanding, frame already on screen. That gap
 * is the jump.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatImage, CHAT_IMAGE_SLOT_WIDTH } from '@/components/ChatImage';
import { chatMediaBox } from '@/lib/chatMediaLayout';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SLOT = CHAT_IMAGE_SLOT_WIDTH;
const SRC = 'blob:https://openstoa.test/8f2c';

/**
 * The same stand-in `chatTallImage.test.tsx` uses, held open on purpose: jsdom
 * never decodes, so `onload` only fires when this test says so. Holding it is
 * the whole point here.
 */
let decoded: { width: number; height: number } | null = null;
let release: (() => void) | null = null;

class HeldImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(_value: string) {
    release = () => {
      if (decoded) {
        this.naturalWidth = decoded.width;
        this.naturalHeight = decoded.height;
        this.onload?.();
      } else {
        this.onerror?.();
      }
    };
  }
}

let container: HTMLDivElement;
let root: Root;
const realImage = globalThis.window?.Image;

beforeEach(() => {
  decoded = null;
  release = null;
  (window as unknown as { Image: unknown }).Image = HeldImage;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  (window as unknown as { Image: unknown }).Image = realImage;
});

async function mount(hint?: { w: number; h: number }) {
  await act(async () => {
    root.render(
      <ChatImage
        src={SRC}
        alt="Encrypted image"
        slotWidth={SLOT}
        croppedLabel="See full image"
        hintWidth={hint?.w}
        hintHeight={hint?.h}
        data-testid="pic"
      />,
    );
  });
  await act(async () => {});
}

/** Let the held decode land, then let the re-render settle. */
async function finishDecode(width: number, height: number) {
  decoded = { width, height };
  await act(async () => {
    release?.();
  });
  await act(async () => {});
}

function frame(): HTMLElement {
  const el = container.querySelector('[data-testid="pic"]');
  if (!el) throw new Error('picture frame not rendered');
  return el as HTMLElement;
}

/**
 * The row is stated as an explicit width plus `aspect-ratio: W / H`, so the
 * RATIO is what moves when the box changes — the rendered height tracks
 * whatever width the bubble grants.
 */
function ratioOf(el: HTMLElement): number {
  const [w, h] = el.style.aspectRatio.split('/').map((n) => Number(n.trim()));
  return h / w;
}

const ratioFor = (w: number, h: number) => {
  const box = chatMediaBox(w, h, SLOT);
  return box.height / box.width;
};

const SQUARE = ratioFor(NaN, NaN);

describe('web: the row a decoding picture sits in', () => {
  it.each([
    ['a phone screenshot', 1179, 2556],
    ['a landscape photo', 4000, 3000],
    ['a panorama', 8000, 1200],
  ])('%s given the sender dimensions never changes shape', async (_n, w, h) => {
    await mount({ w, h });

    const before = ratioOf(frame());
    expect(before).toBeCloseTo(ratioFor(w, h), 5);

    await finishDecode(w, h);
    expect(ratioOf(frame())).toBeCloseTo(before, 5);
  });

  it.each([
    ['a phone screenshot', 1179, 2556],
    ['a panorama', 8000, 1200],
  ])('%s WITHOUT the sender dimensions is a square first, then moves', async (_n, w, h) => {
    /*
     * Recorded, not endorsed. This is still what any caller that does not pass
     * the hint gets, and it is the reason the hint exists. Asserted rather than
     * commented so that wiring a second caller through changes this file too.
     */
    await mount();
    expect(ratioOf(frame())).toBeCloseTo(SQUARE, 5);

    await finishDecode(w, h);
    expect(ratioOf(frame())).toBeCloseTo(ratioFor(w, h), 5);
    expect(ratioOf(frame())).not.toBeCloseTo(SQUARE, 2);
  });

  it('a hint the file disagrees with loses to the file', async () => {
    // The sender is used early, never trusted. One reflow beats a wrong box.
    await mount({ w: 1000, h: 1000 });
    expect(ratioOf(frame())).toBeCloseTo(1, 5);

    await finishDecode(1179, 2556);
    expect(ratioOf(frame())).toBeCloseTo(ratioFor(1179, 2556), 5);
  });

  it('a hinted picture that never decodes keeps the hinted shape', async () => {
    await mount({ w: 1179, h: 2556 });
    decoded = null;
    await act(async () => {
      release?.();
    });
    await act(async () => {});
    expect(ratioOf(frame())).toBeCloseTo(ratioFor(1179, 2556), 5);
  });

  it.each([
    ['zero', 0, 0],
    ['negative', -5, -5],
    ['NaN', Number.NaN, Number.NaN],
  ])('a %s hint produces a real box, not an impossible one', async (_n, w, h) => {
    await mount({ w, h });
    const r = ratioOf(frame());
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeGreaterThan(0);
    expect(parseFloat(frame().style.width)).toBeGreaterThan(0);
  });

  it('a decode that lands after unmount does not throw', async () => {
    await mount({ w: 1179, h: 2556 });
    act(() => root.unmount());
    decoded = { width: 1179, height: 2556 };
    expect(() => release?.()).not.toThrow();
    // Re-created so the shared afterEach has something to unmount.
    root = createRoot(container);
  });
});
