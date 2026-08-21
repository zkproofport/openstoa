/**
 * Picking several photos sends several photos — independently.
 *
 * The screen read `result.assets[0]` and dropped the rest, so one trip to the
 * library meant one attachment, with nothing in the code explaining why. The
 * interesting part of widening it is not the loop; it is what the loop
 * promises: the order somebody picked, and outcomes that do not contaminate
 * each other. A middle photo failing must leave the ones either side sent.
 *
 * The ordering guarantee has a trap under it. `useAuthGuardedAction` returns
 * `void` and fires its inner function with `void fn(...)`, so awaiting the
 * guarded wrapper returns immediately — a loop written against it would launch
 * every upload at once, hold every multi-megabyte buffer simultaneously, and
 * land the messages in completion order. That is why the screen hands this the
 * RAW worker and guards the pick itself, and why the concurrency assertion
 * below is not decoration.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract    → every asset is sent, in the order it was picked, carrying
 *                 its own mime and filename
 *   integrity   → sends are SEQUENTIAL: never two in flight at once
 *   integrity   → a throwing send is stepped over; the assets after it still go
 *   boundary    → one asset behaves exactly as before; an empty pick sends
 *                 nothing
 *   empty       → an asset with no base64, with `null`, and with `''` are all
 *                 skipped and reported, not sent as empty attachments
 *   hostile     → a hole in the array does not throw
 *   integrity   → optional fields absent → mime falls back to '', filename to
 *                 undefined, rather than reaching the sender as null
 *   UTF-8 / very large / authz / race → N/A: this sequences opaque values it
 *                 does not inspect; the guard runs once, above it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  sendPickedAssets,
  type PickedAsset,
  type SendOneAttachment,
} from '../lib/pickedAttachments';

const asset = (over: Partial<PickedAsset> = {}): PickedAsset => ({
  base64: 'AQID',
  mimeType: 'image/jpeg',
  fileName: 'IMG.jpg',
  ...over,
});

describe('sendPickedAssets', () => {
  it('CONTRACT: sends every asset, in the order it was picked', async () => {
    const seen: string[] = [];
    const send = vi.fn(async (i: { base64: string }) => {
      seen.push(i.base64);
    });

    const result = await sendPickedAssets(
      [asset({ base64: 'one' }), asset({ base64: 'two' }), asset({ base64: 'three' })],
      send,
    );

    expect(seen).toEqual(['one', 'two', 'three']);
    expect(result).toEqual({ sent: 3, unreadable: 0, failed: 0 });
  });

  it('CONTRACT: each asset carries its own mime and filename', async () => {
    const send = vi.fn<SendOneAttachment>(async () => {});

    await sendPickedAssets(
      [
        asset({ base64: 'a', mimeType: 'image/png', fileName: 'a.png' }),
        asset({ base64: 'b', mimeType: 'image/webp', fileName: 'b.webp' }),
      ],
      send,
    );

    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { base64: 'a', mime: 'image/png', filename: 'a.png' },
      { base64: 'b', mime: 'image/webp', filename: 'b.webp' },
    ]);
  });

  it('INTEGRITY: sends are sequential — never two in flight', async () => {
    /*
     * The assertion that catches the auth-guard trap. If this is ever wired to
     * a function that returns `void` instead of a promise, `inFlight` climbs
     * above one here and the memory/ordering guarantees are gone.
     */
    let inFlight = 0;
    let peak = 0;
    const send = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });

    await sendPickedAssets([asset(), asset(), asset(), asset()], send);

    expect(peak).toBe(1);
  });

  it('INTEGRITY: a failure in the middle does not cancel the rest', async () => {
    // The whole reason this is a function and not a for-loop in a component.
    const seen: string[] = [];
    const send = vi.fn(async (i: { base64: string }) => {
      if (i.base64 === 'two') throw new Error('upload refused');
      seen.push(i.base64);
    });

    const result = await sendPickedAssets(
      [asset({ base64: 'one' }), asset({ base64: 'two' }), asset({ base64: 'three' })],
      send,
    );

    expect(seen).toEqual(['one', 'three']);
    expect(result).toEqual({ sent: 2, unreadable: 0, failed: 1 });
  });

  it('INTEGRITY: every send failing is still every send attempted', async () => {
    const send = vi.fn(async () => {
      throw new Error('nope');
    });

    const result = await sendPickedAssets([asset(), asset(), asset()], send);

    expect(send).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ sent: 0, unreadable: 0, failed: 3 });
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
  ])('EMPTY: an asset whose base64 is %s is skipped, not sent', async (_label, base64) => {
    // Sending it would upload a zero-byte attachment the recipient cannot open.
    const send = vi.fn<SendOneAttachment>(async () => {});
    const onUnreadable = vi.fn();

    const result = await sendPickedAssets(
      [asset({ base64: base64 as string | null | undefined }), asset({ base64: 'good' })],
      send,
      onUnreadable,
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].base64).toBe('good');
    expect(onUnreadable).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 1, unreadable: 1, failed: 0 });
  });

  it('BOUNDARY: a single asset behaves exactly as the old single-shot path', async () => {
    const send = vi.fn<SendOneAttachment>(async () => {});

    const result = await sendPickedAssets([asset({ base64: 'only' })], send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
  });

  it('BOUNDARY: an empty pick sends nothing and reports nothing', async () => {
    const send = vi.fn<SendOneAttachment>(async () => {});
    const onUnreadable = vi.fn();

    expect(await sendPickedAssets([], send, onUnreadable)).toEqual({
      sent: 0,
      unreadable: 0,
      failed: 0,
    });
    expect(send).not.toHaveBeenCalled();
    expect(onUnreadable).not.toHaveBeenCalled();
  });

  it('HOSTILE: a hole in the array is skipped rather than thrown on', async () => {
    const send = vi.fn<SendOneAttachment>(async () => {});

    const result = await sendPickedAssets(
      [undefined as unknown as PickedAsset, asset({ base64: 'real' })],
      send,
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 1, unreadable: 1, failed: 0 });
  });

  it('INTEGRITY: absent optional fields reach the sender as the shapes it expects', async () => {
    // `mimeType`/`fileName` are optional AND nullable on the picker's asset.
    // Passing null through would defeat the sender's own type sniffing.
    const send = vi.fn<SendOneAttachment>(async () => {});

    await sendPickedAssets([{ base64: 'x', mimeType: null, fileName: null }], send);

    expect(send.mock.calls[0][0]).toEqual({ base64: 'x', mime: '', filename: undefined });
  });

  it('CONTRACT: onUnreadable is optional', async () => {
    const send = vi.fn<SendOneAttachment>(async () => {});

    await expect(sendPickedAssets([asset({ base64: null })], send)).resolves.toEqual({
      sent: 0,
      unreadable: 1,
      failed: 0,
    });
  });
});
