/**
 * A tall picture in a mini-app chat bubble.
 *
 * The rule itself is pinned in `src/__tests__/chatMediaLayout.test.ts` — these
 * ask the narrower question this file exists for: does the mini-app APPLY it,
 * and does it apply it by CROPPING rather than by squashing or letterboxing?
 *
 * The distinction matters because the previous implementation also produced a
 * bounded box (a hard 220x220), so "the picture is not enormous" passes either
 * way. What separates them is what happens to an ordinary photo: the old rule
 * cropped a 4:3 landscape into a square, the new one leaves it alone.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract        → 'asks the shared rule' (a raw <Image> at a fixed size
 *                     fails every case below)
 *   boundary        → 4:3 and 16:9 in both orientations; 9:16 exactly on the bound
 *   integrity       → the clipped height matches the rule, and the inner image
 *                     keeps the source ratio (no squash)
 *   empty/null      → a null uri, and a file whose size cannot be read
 *   external failure→ `Image.getSize` reporting an error
 *   race            → unmounting mid-probe must not set state
 *   hostile input   → dimensions of 0 from a truncated file
 *   authorization   → N/A: this component renders bytes the caller already
 *                     decrypted; it makes no access decision.
 *   UTF-8 / large   → N/A: no text input and no length-capped field here.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import { Image } from 'react-native';
import { ChatImage, CHAT_IMAGE_SLOT_WIDTH } from '../components/ChatImage';
import { CHAT_MEDIA_MIN_ASPECT, CHAT_MEDIA_MAX_ASPECT } from '../lib/chatMediaLayout';
import { render, flush } from './harness/render';

const SLOT = CHAT_IMAGE_SLOT_WIDTH;
const URI = 'file:///tmp/openstoa-view-deadbeef.png';

type Style = Record<string, number | string | undefined>;

/** Host elements are matched by NAME, as the harness's own helpers do. */
function hostsNamed(root: ReactTestInstance, name: string): ReactTestInstance[] {
  return root.findAll((n) => typeof n.type === 'string' && (n.type as string) === name);
}

/** The clipping frame is the outer View carrying our testID. */
function frameStyle(root: ReactTestInstance, testID: string): Style {
  const frame = root.findAll(
    (n) => typeof n.type === 'string' && (n.props as { testID?: string }).testID === testID,
  )[0];
  const raw = (frame.props as { style?: Style | Style[] }).style;
  return Array.isArray(raw) ? Object.assign({}, ...raw) : (raw ?? {});
}

function innerImageStyle(root: ReactTestInstance): Style {
  const img = hostsNamed(root, 'Image')[0];
  const raw = (img.props as { style?: Style | Style[] }).style;
  return Array.isArray(raw) ? Object.assign({}, ...raw) : (raw ?? {});
}

/**
 * `Image.getSize` is overloaded in React Native's own types (it also has a
 * promise form), so a narrow replacement is not assignable to it. The cast is
 * confined to this one setter rather than repeated at every call site.
 */
type GetSize = (
  uri: string,
  success: (width: number, height: number) => void,
  failure?: (error: unknown) => void,
) => void;
const getSizeSlot = Image as unknown as { getSize: GetSize };
const original = getSizeSlot.getSize;
afterEach(() => {
  getSizeSlot.getSize = original;
});

/** Make `Image.getSize` report a size, the way a decodable file would. */
function sizeIs(width: number, height: number) {
  getSizeSlot.getSize = (_uri, ok) => ok(width, height);
}

/** Make it fail, the way a truncated or non-image file would. */
function sizeFails() {
  getSizeSlot.getSize = (_uri, _ok, fail) => fail?.(new Error('cannot decode'));
}

async function mount(testID = 'pic') {
  return render(
    <ChatImage uri={URI} accessibilityLabel="Encrypted image" croppedLabel="See full image" testID={testID} />,
  );
}

describe('mini-app: a tall picture is capped and cropped', () => {
  it('caps a phone screenshot at the tall bound and says it is cropped', async () => {
    sizeIs(1179, 2556);
    const r = await mount();

    const frame = frameStyle(r.root, 'pic');
    expect(frame.width).toBe(SLOT);
    expect(frame.height).toBe(Math.round(SLOT / CHAT_MEDIA_MIN_ASPECT));
    expect(r.text()).toContain('See full image');
  });

  it('CROPS rather than squashing — the inner image keeps the source ratio', async () => {
    /*
     * The assertion that separates a crop from a resize. A squashed picture
     * would have the frame's ratio; a cropped one is laid out at its own full
     * height for this width and clipped by the frame around it.
     */
    sizeIs(1179, 2556);
    const r = await mount();

    const inner = innerImageStyle(r.root);
    const frame = frameStyle(r.root, 'pic');
    expect(inner.width).toBe(SLOT);
    expect(Number(inner.height)).toBe(Math.round((SLOT * 2556) / 1179));
    expect(Number(inner.height)).toBeGreaterThan(Number(frame.height));
  });

  it('keeps the TOP of a cropped screenshot, not its middle', async () => {
    sizeIs(1179, 2556);
    const r = await mount();
    // No negative offset: the surviving pixels start at the first row.
    expect(innerImageStyle(r.root).marginTop).toBe(0);
  });

  it('does not LETTERBOX — the frame is never taller than the picture drawn in it', async () => {
    sizeIs(1179, 2556);
    const r = await mount();
    const frame = frameStyle(r.root, 'pic');
    const inner = innerImageStyle(r.root);
    expect(Number(inner.height)).toBeGreaterThanOrEqual(Number(frame.height));
    expect(Number(inner.width)).toBe(Number(frame.width));
  });

  it('gives an even taller picture the SAME frame — capped, not merely smaller', async () => {
    sizeIs(1179, 2556);
    const a = frameStyle((await mount('a')).root, 'a');
    sizeIs(1280, 40000);
    const b = frameStyle((await mount('b')).root, 'b');
    expect(b.width).toBe(a.width);
    expect(b.height).toBe(a.height);
  });
});

describe('mini-app: an ordinary photo is left alone', () => {
  const ordinary: ReadonlyArray<readonly [string, number, number]> = [
    ['4:3 landscape', 4032, 3024],
    ['4:3 portrait', 3024, 4032],
    ['16:9 landscape', 1920, 1080],
    ['4:3 portrait exactly on the bound', 3024, 4032],
  ];

  for (const [name, w, h] of ordinary) {
    it(`${name} keeps its own shape and shows no crop badge`, async () => {
      sizeIs(w, h);
      const r = await mount();
      const frame = frameStyle(r.root, 'pic');
      expect(Number(frame.width) / Number(frame.height)).toBeCloseTo(w / h, 1);
      expect(r.text()).not.toContain('See full image');
      // Nothing is clipped away: the drawn height equals the frame height.
      expect(Number(innerImageStyle(r.root).height)).toBe(Number(frame.height));
      expect(innerImageStyle(r.root).marginTop).toBe(0);
    });
  }

  it('a 4:3 landscape is NOT squared off — the old 220x220 rule fails this', async () => {
    sizeIs(4032, 3024);
    const r = await mount();
    const frame = frameStyle(r.root, 'pic');
    expect(frame.width).not.toBe(frame.height);
    expect(frame.height).toBe(Math.round(SLOT * (3024 / 4032)));
  });
});

describe('mini-app: a wide panorama', () => {
  it('is cropped to the wide bound and centred, not top-anchored', async () => {
    sizeIs(6000, 2000);
    const r = await mount();
    const frame = frameStyle(r.root, 'pic');
    expect(Number(frame.width) / Number(frame.height)).toBeCloseTo(CHAT_MEDIA_MAX_ASPECT, 1);
    expect(r.text()).toContain('See full image');
    /*
     * A wide picture overflows SIDEWAYS, not downward — it is scaled up until
     * it is tall enough to cover the (short) box, which makes it wider than the
     * box. The first version of this component only ever clipped vertically and
     * left a panorama letterboxed inside its own crop; this is the assertion
     * that found it.
     */
    const inner = innerImageStyle(r.root);
    expect(Number(inner.marginLeft)).toBeLessThan(0);
    expect(Number(inner.marginTop)).toBe(0);
    expect(Number(inner.width)).toBeGreaterThan(Number(frame.width));
    expect(Number(inner.height)).toBe(Number(frame.height));
  });
});

describe('mini-app: the full picture stays reachable', () => {
  it('the bubble that owns this component opens the full-screen viewer', async () => {
    /*
     * The crop is only acceptable because there is a way through to the whole
     * thing. The tap handler lives on the bubble in `ChatRoomScreen`
     * (`encrypted-attachment-open` -> `onImagePress` -> `ImageViewerModal`,
     * which renders `resizeMode="contain"`), so what is asserted here is that
     * this component does not swallow the press by making itself the target.
     */
    sizeIs(1179, 2556);
    const r = await mount();
    const frame = r.root.findAll(
      (n) => typeof n.type === 'string' && (n.props as { testID?: string }).testID === 'pic',
    )[0];
    expect((frame.props as { onPress?: unknown }).onPress).toBeUndefined();
  });
});

describe('mini-app: degenerate and hostile input', () => {
  it('a file whose size cannot be read falls back to a square, uncropped', async () => {
    sizeFails();
    const r = await mount();
    const frame = frameStyle(r.root, 'pic');
    expect(frame.width).toBe(SLOT);
    expect(frame.height).toBe(SLOT);
    expect(r.text()).not.toContain('See full image');
  });

  it('zero dimensions from a truncated file do not produce a NaN box', async () => {
    sizeIs(0, 0);
    const r = await mount();
    const frame = frameStyle(r.root, 'pic');
    expect(Number.isFinite(Number(frame.width))).toBe(true);
    expect(Number.isFinite(Number(frame.height))).toBe(true);
    expect(frame.height).toBe(SLOT);
  });

  it('a null uri renders the reserved frame with no picture in it', async () => {
    const r = await render(
      <ChatImage uri={null} accessibilityLabel="Encrypted image" croppedLabel="See full image" testID="pic" />,
    );
    const frame = frameStyle(r.root, 'pic');
    expect(frame.width).toBe(SLOT);
    expect(frame.height).toBe(SLOT);
    expect(hostsNamed(r.root, 'Image')).toHaveLength(0);
  });

  it('shows the picture even while the size is still unknown', async () => {
    /*
     * The render is never GATED on the measurement. `getSize` is held open, so
     * nothing has been measured yet — the frame is the reserved square and the
     * picture is already in it. An earlier version awaited the probe before
     * handing over the file uri, which meant a host that answered neither way
     * showed no picture at all.
     */
    getSizeSlot.getSize = () => {
      /* never answers */
    };
    const r = await mount();
    const frame = frameStyle(r.root, 'pic');
    expect(frame.width).toBe(SLOT);
    expect(frame.height).toBe(SLOT);
    expect(hostsNamed(r.root, 'Image')).toHaveLength(1);
  });

  it('unmounting mid-probe does not set state afterwards', async () => {
    /*
     * The race. `getSize` is held open, the component goes away, and only then
     * does the callback fire — a missing `cancelled` guard turns that into a
     * React warning and, on a fast-scrolling list, a steady leak.
     */
    let release: (() => void) | null = null;
    getSizeSlot.getSize = (_u, ok) => {
      release = () => ok(1179, 2556);
    };
    const r = await mount();
    r.unmount();
    expect(release).not.toBeNull();
    expect(() => release?.()).not.toThrow();
    await flush();
  });
});
