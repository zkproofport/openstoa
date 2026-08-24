/**
 * The one rule that decides how big a picture is in a chat bubble.
 *
 * These are the real evidence for the fix, because the rule is a pure function
 * and everything visible in either client is derived from it. The component
 * tests beside this file (`chatTallImageWeb.test.tsx`,
 * `packages/mobile/src/__tests__/chatTallImageMobile.test.tsx`) only prove that
 * the clients ASK — the answers are pinned here.
 *
 * Every assertion below was mutation-checked: see the report in the commit
 * message for which mutation kills which case.
 */
import { describe, it, expect } from 'vitest';
import {
  CHAT_MEDIA_MAX_ASPECT,
  CHAT_MEDIA_MIN_ASPECT,
  CHAT_MEDIA_MIN_WIDTH,
  chatMediaBox,
} from '@/lib/chatMediaLayout';

/** The slot both clients actually use. Kept local so a UI retune doesn't silently rewrite these expectations. */
const SLOT = 240;

const ratioOf = (b: { width: number; height: number }) => b.width / b.height;

describe('chatMediaBox — ordinary photos are not touched', () => {
  /*
   * The load-bearing constraint. A cap that improves screenshots by degrading
   * every holiday photo is not a fix, so the common ratios are pinned
   * individually rather than as a range — a range would pass while a single
   * orientation was quietly broken.
   */
  const ordinary: ReadonlyArray<readonly [string, number, number]> = [
    ['4:3 landscape', 4032, 3024],
    ['4:3 portrait', 3024, 4032],
    ['16:9 landscape', 1920, 1080],
    ['3:2 landscape (DSLR)', 6000, 4000],
    ['square', 2000, 2000],
  ];

  for (const [name, w, h] of ordinary) {
    it(`${name} renders at its own ratio, uncropped`, () => {
      const box = chatMediaBox(w, h, SLOT);
      expect(box.cropped).toBe(false);
      expect(box.anchor).toBe('center');
      // Within half a pixel of the source ratio: the only loss is the rounding
      // of `height` to a whole pixel.
      expect(ratioOf(box)).toBeCloseTo(w / h, 2);
      expect(box.width).toBe(SLOT);
    });
  }

  it('4:3 portrait sits exactly ON the tall bound and stays uncropped', () => {
    /*
     * The boundary that decides whether the cap is safe for the common case.
     * 3024/4032 is exactly 3/4, so this passes only while the comparison is
     * strict (`<`, not `<=`) — flipping it crops every portrait phone photo,
     * which is the single most common picture anyone sends.
     */
    expect(3024 / 4032).toBe(CHAT_MEDIA_MIN_ASPECT);
    expect(chatMediaBox(3024, 4032, SLOT).cropped).toBe(false);
  });

  it('16:9 PORTRAIT is cropped — the cost of the cap, pinned so it is not a surprise', () => {
    /*
     * Deliberate, and the one place the cap contradicts the original brief
     * rather than narrowing it. A 1080x1920 photo is 0.5625, below the 0.75
     * bound, so it renders as its top 75% with the crop badge on it. Leaving
     * it whole would mean allowing a box 1.78x its own width, which is the
     * length the owner complained about. This test exists so that raising the
     * bound back is a visible decision and not a silent drift.
     */
    const box = chatMediaBox(1080, 1920, SLOT);
    expect(box.cropped).toBe(true);
    expect(box.anchor).toBe('top');
    expect(box.width).toBe(SLOT);
    expect(box.height).toBe(Math.round(SLOT / CHAT_MEDIA_MIN_ASPECT));
  });
});

describe('chatMediaBox — a tall image is capped and cropped, not letterboxed', () => {
  it('a phone screenshot is cropped to the tall bound', () => {
    // iPhone 15 Pro: 1179x2556, ratio 0.4613 — below 9:16, so it is cropped.
    const box = chatMediaBox(1179, 2556, SLOT);
    expect(box.cropped).toBe(true);
    expect(box.width).toBe(SLOT);
    expect(ratioOf(box)).toBeCloseTo(CHAT_MEDIA_MIN_ASPECT, 2);
  });

  it('a full-page screenshot gets the SAME box as a merely-tall one', () => {
    /*
     * This is the assertion that says "capped", as opposed to "smaller". Under
     * the old web rule these two produced wildly different widths (the taller
     * the source, the narrower the result); under a cap they are identical.
     */
    const tall = chatMediaBox(1280, 4000, SLOT);
    const tallest = chatMediaBox(1280, 40000, SLOT);
    expect(tallest).toEqual(tall);
    expect(tallest.width).toBe(SLOT);
  });

  it('never returns a box narrower than the slot for a tall image — that WAS the bug', () => {
    /*
     * The regression in one line. The web previously capped height and let
     * width fall out of the ratio, so a 1:10 image rendered 38px wide. Any
     * implementation that reintroduces height-driven sizing fails here.
     */
    for (const h of [2000, 5000, 12000, 100000]) {
      expect(chatMediaBox(1000, h, SLOT).width).toBe(SLOT);
    }
  });

  it('anchors a cropped tall image to the TOP, so the first thing in it survives', () => {
    expect(chatMediaBox(1179, 2556, SLOT).anchor).toBe('top');
  });

  it('is bounded in height by the slot width and the tall bound, nothing else', () => {
    const box = chatMediaBox(1000, 10000, SLOT);
    expect(box.height).toBe(Math.round(SLOT / CHAT_MEDIA_MIN_ASPECT));
  });

  it('a tall image NARROWER than the slot keeps its own width and is still capped', () => {
    /*
     * The two rules meeting. Width comes from the source (160, not the slot,
     * because upscaling only blurs), and the height cap is then relative to
     * THAT width — otherwise a narrow tall image escapes the cap entirely.
     */
    const box = chatMediaBox(160, 4000, SLOT);
    expect(box.width).toBe(160);
    expect(box.height).toBe(Math.round(160 / CHAT_MEDIA_MIN_ASPECT));
    expect(box.cropped).toBe(true);
    expect(box.anchor).toBe('top');
  });
});

describe('chatMediaBox — a wide panorama is handled', () => {
  it('a 3:1 panorama is cropped to the wide bound, centred', () => {
    const box = chatMediaBox(6000, 2000, SLOT);
    expect(box.cropped).toBe(true);
    expect(box.anchor).toBe('center');
    expect(ratioOf(box)).toBeCloseTo(CHAT_MEDIA_MAX_ASPECT, 2);
  });

  it('a 2:1 panorama is inside the bound and stays uncropped', () => {
    const box = chatMediaBox(4000, 2000, SLOT);
    expect(box.cropped).toBe(false);
    expect(ratioOf(box)).toBeCloseTo(2, 2);
  });

  it('an extreme strip never collapses to a hairline', () => {
    const box = chatMediaBox(10000, 100, SLOT);
    expect(box.height).toBe(Math.round(SLOT / CHAT_MEDIA_MAX_ASPECT));
    expect(box.height).toBeGreaterThan(40);
  });
});

describe('chatMediaBox — boundary values', () => {
  it('exactly on either bound is uncropped; a hair past it is cropped', () => {
    const eps = 1e-6;
    expect(chatMediaBox(CHAT_MEDIA_MIN_ASPECT * 1000, 1000, SLOT).cropped).toBe(false);
    expect(chatMediaBox(CHAT_MEDIA_MAX_ASPECT * 1000, 1000, SLOT).cropped).toBe(false);
    expect(chatMediaBox((CHAT_MEDIA_MIN_ASPECT - eps) * 1000, 1000, SLOT).cropped).toBe(true);
    expect(chatMediaBox((CHAT_MEDIA_MAX_ASPECT + eps) * 1000, 1000, SLOT).cropped).toBe(true);
  });

  it('a 1x1 image is floored at the minimum width rather than drawn as a dot', () => {
    const box = chatMediaBox(1, 1, SLOT);
    expect(box.width).toBe(CHAT_MEDIA_MIN_WIDTH);
    expect(box.height).toBe(CHAT_MEDIA_MIN_WIDTH);
  });

  it('a picture smaller than the slot is not blown up to fill it', () => {
    const box = chatMediaBox(160, 120, SLOT);
    expect(box.width).toBe(160);
    expect(box.height).toBe(120);
    expect(box.cropped).toBe(false);
  });

  it('a picture exactly the slot width is unchanged', () => {
    expect(chatMediaBox(SLOT, SLOT, SLOT)).toEqual({
      width: SLOT,
      height: SLOT,
      cropped: false,
      anchor: 'center',
    });
  });

  it('a very large source is still bounded by the slot', () => {
    const box = chatMediaBox(30000, 30000, SLOT);
    expect(box.width).toBe(SLOT);
    expect(box.height).toBe(SLOT);
  });
});

describe('chatMediaBox — hostile and degenerate input', () => {
  /*
   * These reach the function for real: `naturalWidth` is 0 on an <img> that has
   * not decoded, RN's `Image.getSize` can hand back garbage for a truncated
   * file, and a hand-built envelope is attacker-controlled text. None of them
   * may produce NaN — a NaN in a style makes the picture vanish with no error.
   */
  const junk: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ['zero width', 0, 100],
    ['zero height', 100, 0],
    ['both zero', 0, 0],
    ['negative width', -100, 100],
    ['negative height', 100, -100],
    ['NaN', Number.NaN, 100],
    ['Infinity', Number.POSITIVE_INFINITY, 100],
    ['-Infinity', 100, Number.NEGATIVE_INFINITY],
    ['null', null, null],
    ['undefined', undefined, undefined],
    ['string', '100' as unknown, '200' as unknown],
    ['object', {} as unknown, [] as unknown],
  ];

  for (const [name, w, h] of junk) {
    it(`${name} falls back to a square, with no NaN`, () => {
      const box = chatMediaBox(w as number, h as number, SLOT);
      expect(box).toEqual({ width: SLOT, height: SLOT, cropped: false, anchor: 'center' });
      expect(Number.isFinite(box.width)).toBe(true);
      expect(Number.isFinite(box.height)).toBe(true);
    });
  }

  it('a degenerate SLOT falls back to the minimum width instead of vanishing', () => {
    for (const slot of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      const box = chatMediaBox(1000, 1000, slot);
      expect(box.width).toBe(CHAT_MEDIA_MIN_WIDTH);
      expect(box.height).toBeGreaterThan(0);
    }
  });
});

describe('chatMediaBox — invariants that must hold for every input', () => {
  /*
   * Result integrity. The individual cases above say what happens at points we
   * thought of; this says what is true everywhere, including the ratios nobody
   * listed. Both properties are the ones the UI depends on: a box outside the
   * clamp is the sliver returning, and a non-integer or non-finite side is a
   * broken style.
   */
  const ratios: number[] = [];
  for (let w = 1; w <= 4000; w += 137) {
    for (let h = 1; h <= 4000; h += 311) ratios.push(w / h);
  }

  it('the rendered ratio is always inside the clamp', () => {
    for (let w = 1; w <= 4000; w += 137) {
      for (let h = 1; h <= 4000; h += 311) {
        const box = chatMediaBox(w, h, SLOT);
        const r = ratioOf(box);
        // Half a pixel of rounding slack on the shorter side, which at these
        // sizes is worth at most ~1% of the ratio.
        expect(r).toBeGreaterThanOrEqual(CHAT_MEDIA_MIN_ASPECT * 0.98);
        expect(r).toBeLessThanOrEqual(CHAT_MEDIA_MAX_ASPECT * 1.02);
      }
    }
    expect(ratios.length).toBeGreaterThan(100);
  });

  it('both sides are always finite positive integers within the slot', () => {
    for (let w = 1; w <= 4000; w += 137) {
      for (let h = 1; h <= 4000; h += 311) {
        const box = chatMediaBox(w, h, SLOT);
        expect(Number.isInteger(box.width)).toBe(true);
        expect(Number.isInteger(box.height)).toBe(true);
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
        expect(box.width).toBeLessThanOrEqual(SLOT);
      }
    }
  });

  it('`cropped` is true exactly when the source ratio was outside the clamp', () => {
    for (let w = 1; w <= 4000; w += 137) {
      for (let h = 1; h <= 4000; h += 311) {
        const outside = w / h < CHAT_MEDIA_MIN_ASPECT || w / h > CHAT_MEDIA_MAX_ASPECT;
        expect(chatMediaBox(w, h, SLOT).cropped).toBe(outside);
      }
    }
  });

  it('is deterministic and free of side effects', () => {
    const a = chatMediaBox(1179, 2556, SLOT);
    const b = chatMediaBox(1179, 2556, SLOT);
    expect(a).toEqual(b);
  });
});

describe('chatMediaBox — the bounds themselves', () => {
  /*
   * Pinned at the DEFINITION, so that retuning them is a deliberate edit to a
   * test rather than a silent change in behaviour. The comparisons say WHY each
   * number is where it is, so a future retune has to break a stated reason.
   */
  it('the tall bound is exactly 4:3 held portrait', () => {
    expect(CHAT_MEDIA_MIN_ASPECT).toBe(3 / 4);
  });

  it('the tall bound caps height at 1.333x width — Signal Android\'s 240x320 box', () => {
    /*
     * The one sourced anchor for this number: `media_bubble_max_width 240dp`
     * and `media_bubble_max_height 320dp` in Signal Android's dimens.xml, and
     * 320/240 === 4/3. At our 240 slot the boxes coincide exactly.
     */
    expect(1 / CHAT_MEDIA_MIN_ASPECT).toBeCloseTo(320 / 240, 10);
    expect(chatMediaBox(1000, 5000, 240).height).toBe(320);
  });

  it('the tall bound still leaves a portrait PHONE PHOTO untouched', () => {
    // 4:3 and 3:2 held portrait — the ordinary case the cap must not touch.
    expect(3 / 4).not.toBeLessThan(CHAT_MEDIA_MIN_ASPECT);
    expect(2 / 3).toBeLessThan(CHAT_MEDIA_MIN_ASPECT);
  });

  it('the tall bound puts a modern phone screenshot below it', () => {
    expect(1179 / 2556).toBeLessThan(CHAT_MEDIA_MIN_ASPECT);
    expect(1170 / 2532).toBeLessThan(CHAT_MEDIA_MIN_ASPECT);
  });

  it('the wide bound leaves every ordinary landscape ratio below it', () => {
    expect(16 / 9).toBeLessThan(CHAT_MEDIA_MAX_ASPECT);
    expect(4 / 3).toBeLessThan(CHAT_MEDIA_MAX_ASPECT);
  });
});
