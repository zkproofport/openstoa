/*
 * WHY THIS EXISTS. "Pick several photos at once and all of them attach."
 *
 * `sendPickedAssets` is the whole of that promise on the mini-app: the picker
 * hands back up to `MAX_ATTACHMENTS_PER_PICK` assets and this loop turns each
 * one into a message. Nothing tested it. Neither platform had a case naming
 * the count — searching the suites for `MAX_ATTACHMENTS_PER_PICK` or
 * `allowsMultipleSelection` returned nothing at all.
 *
 * The loop is written to survive a bad asset without dropping its neighbours,
 * which is the interesting part and exactly the part a rewrite would lose: a
 * `Promise.all` or an early `return` reads cleaner and silently turns "four
 * picked, one unreadable" into "nothing sent". The cases below fail if that
 * happens.
 *
 * Written 2026-08-26 after trying to count four attachments on a real device
 * and failing to — the room under test was 44 key-locked placeholders deep and
 * the list would not scroll to its own tail under `adb`. A guard that does not
 * need a screen is the more useful half of that afternoon.
 */
import { describe, it, expect, vi } from 'vitest';

import { sendPickedAssets } from '../lib/pickedAttachments';
import { MAX_ATTACHMENTS_PER_PICK } from '../lib/chatMedia';

type Asset = Parameters<typeof sendPickedAssets>[0][number];

const asset = (over: Partial<Asset> = {}): Asset =>
  ({
    base64: 'AAAA',
    mimeType: 'image/png',
    fileName: 'p.png',
    ...over,
  }) as Asset;

/** Records what each call was handed, so order and content are both checkable. */
function recorder() {
  const seen: Array<{ base64: string; mime: string; filename?: string }> = [];
  const send = vi.fn(async (a: { base64: string; mime: string; filename?: string }) => {
    seen.push(a);
  });
  return { send, seen };
}

describe('every photo the picker returns becomes a message', () => {
  it.each([1, 2, 4, MAX_ATTACHMENTS_PER_PICK])('%i picked → %i sent', async (n) => {
    const { send, seen } = recorder();
    const picked = Array.from({ length: n }, (_, i) =>
      asset({ base64: `bytes-${i}`, fileName: `p${i}.png` }),
    );

    const result = await sendPickedAssets(picked, send);

    expect(result).toEqual({ sent: n, unreadable: 0, failed: 0 });
    expect(seen.map((s) => s.base64)).toEqual(picked.map((p) => p.base64));
  });

  it('INTEGRITY: they are sent in the order they were picked', async () => {
    // Not incidental — a gallery selection has an order and the room shows it.
    const { send, seen } = recorder();
    await sendPickedAssets(
      ['a', 'b', 'c'].map((k) => asset({ base64: k })),
      send,
    );
    expect(seen.map((s) => s.base64)).toEqual(['a', 'b', 'c']);
  });

  it('CONTRACT: one unreadable file does not take the others down with it', async () => {
    /*
     * The failure this catches: a `Promise.all` or an early return. Four picked,
     * the third unreadable, and a rewrite quietly sends zero — or one — instead
     * of three.
     */
    const { send, seen } = recorder();
    const picked = [
      asset({ base64: 'a' }),
      asset({ base64: 'b' }),
      asset({ base64: undefined as unknown as string }),
      asset({ base64: 'd' }),
    ];

    const result = await sendPickedAssets(picked, send);

    expect(result).toEqual({ sent: 3, unreadable: 1, failed: 0 });
    expect(seen.map((s) => s.base64)).toEqual(['a', 'b', 'd']);
  });

  it('CONTRACT: one send that throws does not take the others down either', async () => {
    const seen: string[] = [];
    const send = vi.fn(async (a: { base64: string }) => {
      if (a.base64 === 'b') throw new Error('upload refused');
      seen.push(a.base64);
    });

    const result = await sendPickedAssets(
      ['a', 'b', 'c'].map((k) => asset({ base64: k })),
      send,
    );

    expect(result).toEqual({ sent: 2, unreadable: 0, failed: 1 });
    expect(seen).toEqual(['a', 'c']);
  });

  it('reports which asset was unreadable, and where it sat', async () => {
    const { send } = recorder();
    const onUnreadable = vi.fn();
    const bad = asset({ base64: undefined as unknown as string, fileName: 'broken.heic' });

    await sendPickedAssets([asset({ base64: 'a' }), bad], send, onUnreadable);

    expect(onUnreadable).toHaveBeenCalledTimes(1);
    expect(onUnreadable.mock.calls[0][1]).toBe(1);
    expect((onUnreadable.mock.calls[0][0] as Asset).fileName).toBe('broken.heic');
  });

  it.each([
    ['an empty selection', []],
    ['a selection of nothing but unreadable files', [undefined, undefined]],
  ])('EMPTY: %s sends nothing and does not throw', async (_label, shape) => {
    const { send } = recorder();
    const picked = (shape as unknown[]).map(() =>
      asset({ base64: undefined as unknown as string }),
    );

    const result = await sendPickedAssets(picked, send);

    expect(send).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(result.unreadable).toBe(picked.length);
  });

  it('BOUNDARY: a mime the picker did not report becomes an empty string, not undefined', async () => {
    /*
     * The transport puts this straight into the envelope; `undefined` there
     * serialises away and the receiver gets a picture with no type at all.
     */
    const { send, seen } = recorder();
    await sendPickedAssets([asset({ mimeType: undefined })], send);
    expect(seen[0].mime).toBe('');
  });
});
