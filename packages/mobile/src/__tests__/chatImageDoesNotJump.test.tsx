/*
 * WHY THIS EXISTS. "Entering a room full of photos makes the list jump" was
 * reported against the mini-app, and the fix put the sender's measured
 * dimensions into the attachment envelope so `ChatRoomScreen` can reserve the
 * right-shaped row before a byte is fetched.
 *
 * That covers the FIRST window — ciphertext not yet downloaded. It says nothing
 * about the SECOND one. Once the file is on disk, `ChatRoomScreen` hands the
 * uri to `ChatImage`, which measures the file itself with `Image.getSize` and
 * renders the shared fallback (a square) until that returns. If the reserved
 * row was not a square, the row changes height at that moment — the same
 * symptom, one step later, and invisible to every existing test because they
 * all stub `getSize` to answer synchronously.
 *
 * So this file measures rather than argues: hold the probe open, read the
 * frame, let the probe answer, read the frame again. Whatever the numbers say
 * is what goes in the report.
 *
 * Written 2026-08-26, when the phone (R59T600DXYZ) was locked and the machine
 * had 973 MB free, so neither the device nor an emulator could show it.
 */
import React from 'react';
import { Image } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, it, expect, afterEach } from 'vitest';

import { ChatImage, CHAT_IMAGE_SLOT_WIDTH } from '../components/ChatImage';
import { chatMediaBox } from '../lib/chatMediaLayout';
import { render, flush } from './harness/render';

const URI = 'file:///tmp/openstoa-view-deadbeef.png';

type Style = Record<string, number | string | undefined>;
type GetSize = (
  uri: string,
  ok: (w: number, h: number) => void,
  fail?: (e: Error) => void,
) => void;

const slot = Image as unknown as { getSize: GetSize };
const original = slot.getSize;
afterEach(() => {
  slot.getSize = original;
});

/**
 * A probe that does NOT answer until told — the state the component is in for
 * as long as decoding takes on a real phone, and the state every other test in
 * this tree skips past.
 */
function deferredProbe(): (w: number, h: number) => void {
  let answer: ((w: number, h: number) => void) | null = null;
  slot.getSize = (_uri, ok) => {
    answer = ok;
  };
  return (w, h) => answer?.(w, h);
}

function frameStyle(root: ReactTestInstance, testID: string): Style {
  const frame = root.findAll(
    (n) => typeof n.type === 'string' && (n.props as { testID?: string }).testID === testID,
  )[0];
  const raw = (frame.props as { style?: Style | Style[] }).style;
  return Array.isArray(raw) ? Object.assign({}, ...raw) : (raw ?? {});
}

async function mount(hint?: { w: number; h: number }) {
  return render(
    <ChatImage
      uri={URI}
      accessibilityLabel="Encrypted image"
      croppedLabel="See full image"
      hintWidth={hint?.w}
      hintHeight={hint?.h}
      testID="pic"
    />,
  );
}

describe('the row a downloaded picture lands in, measured on both sides of the probe', () => {
  it.each([
    ['a phone screenshot', 1179, 2556],
    ['a landscape photo', 4000, 3000],
    ['a panorama', 8000, 1200],
  ])('%s', async (_name, w, h) => {
    const answer = deferredProbe();
    const r = await mount();

    const before = frameStyle(r.root, 'pic');
    answer(w, h);
    await flush();
    const after = frameStyle(r.root, 'pic');

    const settled = chatMediaBox(w, h, CHAT_IMAGE_SLOT_WIDTH);
    expect(Number(after.width)).toBe(settled.width);
    expect(Number(after.height)).toBe(settled.height);

    /*
     * Recorded as observed. `ChatImage` takes a uri and nothing else, so while
     * the probe is open it has no dimensions to reserve from and shows the
     * shared square. For any picture that is not square, the row therefore
     * changes height when the probe answers.
     *
     * Left as an assertion rather than a comment so the day someone gives
     * `ChatImage` the envelope's w/h — closing this window the way
     * `ChatRoomScreen` already closed the first one — this test fails and says
     * exactly what changed, instead of quietly continuing to describe the old
     * behaviour.
     */
    const square = chatMediaBox(undefined, undefined, CHAT_IMAGE_SLOT_WIDTH);
    expect(Number(before.width)).toBe(square.width);
    expect(Number(before.height)).toBe(square.height);
    expect(Number(after.height)).not.toBe(Number(before.height));
  });

  it('a square picture is the one case that never moves', async () => {
    const answer = deferredProbe();
    const r = await mount();

    const before = frameStyle(r.root, 'pic');
    answer(1000, 1000);
    await flush();
    const after = frameStyle(r.root, 'pic');

    expect(Number(after.height)).toBe(Number(before.height));
    expect(Number(after.width)).toBe(Number(before.width));
  });

  it('a file that never decodes keeps the reserved square rather than collapsing', async () => {
    slot.getSize = (_uri, _ok, fail) => fail?.(new Error('cannot decode'));
    const r = await mount();
    await flush();

    const frame = frameStyle(r.root, 'pic');
    const square = chatMediaBox(undefined, undefined, CHAT_IMAGE_SLOT_WIDTH);
    expect(Number(frame.width)).toBe(square.width);
    expect(Number(frame.height)).toBe(square.height);
  });

  it('a probe that answers after unmount does not throw', async () => {
    const answer = deferredProbe();
    const r = await mount();
    r.unmount();
    expect(() => answer(1179, 2556)).not.toThrow();
  });
});

describe('given the sender\'s dimensions, the row never moves at all', () => {
  it.each([
    ['a phone screenshot', 1179, 2556],
    ['a landscape photo', 4000, 3000],
    ['a panorama', 8000, 1200],
  ])('%s holds its box across the probe', async (_name, w, h) => {
    const answer = deferredProbe();
    const r = await mount({ w, h });

    const before = frameStyle(r.root, 'pic');
    answer(w, h);
    await flush();
    const after = frameStyle(r.root, 'pic');

    const settled = chatMediaBox(w, h, CHAT_IMAGE_SLOT_WIDTH);
    expect(Number(before.width)).toBe(settled.width);
    expect(Number(before.height)).toBe(settled.height);
    expect(Number(after.height)).toBe(Number(before.height));
  });

  it('a hint the file disagrees with is corrected — one reflow, not a wrong box forever', async () => {
    /*
     * The sender is not trusted, only used early. A hint that says "square"
     * for a file that is actually a screenshot must lose to the file.
     */
    const answer = deferredProbe();
    const r = await mount({ w: 1000, h: 1000 });

    const before = frameStyle(r.root, 'pic');
    answer(1179, 2556);
    await flush();
    const after = frameStyle(r.root, 'pic');

    const truth = chatMediaBox(1179, 2556, CHAT_IMAGE_SLOT_WIDTH);
    expect(Number(after.height)).toBe(truth.height);
    expect(Number(after.height)).not.toBe(Number(before.height));
  });

  it.each([
    ['zero', 0, 0],
    ['negative', -5, -5],
    ['NaN', Number.NaN, Number.NaN],
  ])('a %s hint is refused rather than producing an impossible box', async (_n, w, h) => {
    const answer = deferredProbe();
    const r = await mount({ w, h });
    const before = frameStyle(r.root, 'pic');
    expect(Number(before.width)).toBeGreaterThan(0);
    expect(Number.isFinite(Number(before.height))).toBe(true);
    answer(1179, 2556);
    await flush();
    expect(Number(frameStyle(r.root, 'pic').height)).toBe(
      chatMediaBox(1179, 2556, CHAT_IMAGE_SLOT_WIDTH).height,
    );
  });

  it('a hint with no file behind it still reserves that shape', async () => {
    slot.getSize = (_uri, _ok, fail) => fail?.(new Error('cannot decode'));
    const r = await mount({ w: 1179, h: 2556 });
    await flush();
    const frame = frameStyle(r.root, 'pic');
    const hinted = chatMediaBox(1179, 2556, CHAT_IMAGE_SLOT_WIDTH);
    expect(Number(frame.height)).toBe(hinted.height);
  });
});
