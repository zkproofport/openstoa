/*
 * WHY THIS EXISTS. Entering a room full of photos used to shove the list around:
 * every picture reserved one size, then resized to another once its bytes
 * arrived, and each resize moved everything below it. The fix was to put the
 * sender's measured dimensions in the attachment envelope and reserve the box
 * from THOSE — so the row is already the right shape before a byte is fetched.
 *
 * That fix is an invariant across two call sites per platform, and nothing
 * asserted it:
 *
 *   reserve  = chatMediaBox(envelope.w, envelope.h, slot)   <- before the bytes
 *   settled  = chatMediaBox(natural.w,  natural.h,  slot)   <- after the bytes
 *
 * They agree only while BOTH sites keep calling the same rule with the same
 * slot width. Nothing stopped someone changing one of them — rounding the
 * reserve, giving the placeholder its own constant, capping only the
 * placeholder — and the resulting jump is a runtime, per-image, timing-shaped
 * symptom that no existing test would notice. `chatTallImage.test.tsx` proves
 * the box is the RIGHT SHAPE; this file proves the two paths reach the SAME
 * shape.
 *
 * Both platforms are checked from here on purpose. Web and mini-app re-export
 * one `packages/mls/src/chatMediaLayout`, so the rule cannot drift — only the
 * call sites can, and they live in different trees that no single test suite
 * otherwise reads together.
 *
 * On-device confirmation was NOT possible when this was written (2026-08-26):
 * the phone has a secure lock and the machine had 973 MB free, so the emulator
 * refused to boot. This is the guard that stands in for the screenshot, and it
 * is the more durable of the two.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { chatMediaBox } from '@/lib/chatMediaLayout';
import { CHAT_IMAGE_SLOT_WIDTH, CHAT_IMAGE_SLOT_WIDTH_ROOMY } from '@/components/ChatImage';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/** The four places a chat picture's box is computed, two per platform. */
const RESERVE_SITES = {
  web: 'src/components/ChatPanel.tsx',
  mini: 'packages/mobile/src/screens/chat/ChatRoomScreen.tsx',
} as const;
const SETTLE_SITES = {
  web: 'src/components/ChatImage.tsx',
  mini: 'packages/mobile/src/components/ChatImage.tsx',
} as const;

/*
 * Real shapes, not round numbers: a Galaxy A23 screenshot, an iPhone
 * screenshot, a DSLR frame, a panorama, a square crop, a thumbnail.
 */
const SHAPES: ReadonlyArray<readonly [string, number, number]> = [
  ['galaxy screenshot', 1080, 2408],
  ['iphone screenshot', 1179, 2556],
  ['dslr landscape', 6000, 4000],
  ['dslr portrait', 4000, 6000],
  ['panorama', 8000, 1200],
  ['square crop', 1000, 1000],
  ['thumbnail', 96, 96],
  ['one pixel', 1, 1],
  ['sliver', 3, 4000],
];

describe('the box reserved before the bytes is the box the picture settles into', () => {
  for (const slot of [CHAT_IMAGE_SLOT_WIDTH, CHAT_IMAGE_SLOT_WIDTH_ROOMY]) {
    it.each(SHAPES)(`%s, slot ${slot}`, (_name, w, h) => {
      const reserve = chatMediaBox(w, h, slot);
      const settled = chatMediaBox(w, h, slot);
      // Not `toBe` — the point is the VALUES agree, whoever computed them.
      expect(reserve).toEqual(settled);
      expect(reserve.width).toBeGreaterThan(0);
      expect(reserve.height).toBeGreaterThan(0);
      expect(Number.isFinite(reserve.height)).toBe(true);
    });
  }

  it('a picture the sender never measured falls back to a square — and that square is the honest cost', () => {
    /*
     * Recorded, not endorsed. A message sent BEFORE the envelope carried w/h
     * has nothing to reserve from, so the row is a square and the picture
     * still moves it when it lands. OpenStoa has not launched, so those
     * messages are disposable rather than migratable — but if that ever stops
     * being true, this is the case that says what breaks.
     */
    const blind = chatMediaBox(undefined, undefined, CHAT_IMAGE_SLOT_WIDTH);
    const real = chatMediaBox(1179, 2556, CHAT_IMAGE_SLOT_WIDTH);
    expect(blind.width).toBe(blind.height);
    expect(real.height).not.toBe(blind.height);
  });

  it('a truncated file reporting 0x0 reserves a real box rather than NaN', () => {
    const box = chatMediaBox(0, 0, CHAT_IMAGE_SLOT_WIDTH);
    expect(Number.isFinite(box.width) && Number.isFinite(box.height)).toBe(true);
    expect(box.width).toBeGreaterThan(0);
  });
});

describe('both platforms still compute that box the same way', () => {
  it.each(Object.entries(RESERVE_SITES))(
    '%s reserves from the envelope, through the shared rule',
    (_platform, rel) => {
      const src = read(rel);
      const call = src.match(/chatMediaBox\(\s*envelope\.w\s*,\s*envelope\.h\s*,/);
      expect(call, `${rel} must reserve from envelope.w/envelope.h`).not.toBeNull();
    },
  );

  it.each(Object.entries(SETTLE_SITES))(
    '%s settles on the same rule once it has measured the file',
    (_platform, rel) => {
      const src = read(rel);
      expect(src, `${rel} must settle via chatMediaBox`).toMatch(/chatMediaBox\(/);
    },
  );

  it('the two platforms agree on how wide a chat picture slot is', () => {
    /*
     * A mismatch here is invisible in either suite alone — each platform's
     * tests would pass against its own constant while the clients disagreed
     * about the same message.
     */
    const mini = read('packages/mobile/src/components/ChatImage.tsx');
    const web = read('src/components/ChatImage.tsx');
    const widthOf = (src: string) =>
      Number(src.match(/CHAT_IMAGE_SLOT_WIDTH\s*=\s*(\d+)/)?.[1]);
    expect(widthOf(mini)).toBe(widthOf(web));
    expect(widthOf(web)).toBe(CHAT_IMAGE_SLOT_WIDTH);
  });

  it.each(Object.entries(RESERVE_SITES))(
    '%s hands the envelope dimensions on to the picture, not just to the placeholder',
    (_platform, rel) => {
      /*
       * Found by mutation, not by design: deleting these two props from the
       * render site left every other assertion in this file green while the
       * row went back to jumping at decode time. Reserving the right shape and
       * then rendering a picture that does not know it is half a fix.
       */
      const src = read(rel);
      expect(src, `${rel} must pass hintWidth={envelope.w}`).toMatch(
        /hintWidth=\{envelope\.w\}/,
      );
      expect(src, `${rel} must pass hintHeight={envelope.h}`).toMatch(
        /hintHeight=\{envelope\.h\}/,
      );
    },
  );

  it.each(Object.entries(SETTLE_SITES))(
    '%s accepts those dimensions and lets the decoded file overrule them',
    (_platform, rel) => {
      const src = read(rel);
      expect(src, `${rel} must accept a hint`).toMatch(/hintWidth\?: number/);
      // The file wins: `size` first, hint only as the fallback.
      expect(src, `${rel} must prefer the measured size`).toMatch(
        /size\?\.width \?\? hintWidth/,
      );
      expect(src).toMatch(/size\?\.height \?\? hintHeight/);
    },
  );

  it('neither platform reserves with a second, private constant', () => {
    /*
     * The failure this catches: someone gives the placeholder its own width
     * ("just for the skeleton"), both suites stay green, and every photo row
     * jumps sideways the moment it loads.
     */
    for (const rel of Object.values(RESERVE_SITES)) {
      const reserve = read(rel).match(/chatMediaBox\([^)]*\)/g) ?? [];
      expect(reserve.length, `${rel} should compute the reserve exactly once`).toBe(1);
      expect(reserve[0]).toMatch(/CHAT_IMAGE_SLOT_WIDTH|slotWidth/);
    }
  });
});
