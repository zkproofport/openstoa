/**
 * The rule behind the web composer's multi-select, tested directly.
 *
 * THE DEFECT: the web could not attach more than one image. Its file input had
 * no `multiple` and its change handler read `files[0]`. The mini-app has sent a
 * whole pick as several messages for a while (`sendPickedAssets`), so the two
 * clients disagreed about what picking three photos means.
 *
 * Adding `multiple` alone would have been the WORSE bug: the picker would
 * offer three, accept three, and send one, with nothing on screen to say the
 * other two were dropped. This file pins the half that makes the attribute
 * honest — three files in, three sends out — and
 * `chatComposerMultiSelect.test.tsx` pins that the composer is actually wired
 * to it.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract     — three files produce three sends, IN PICK ORDER
 *   integrity    — sequential, not concurrent: the next send does not begin
 *                  until the previous one has finished (they share one
 *                  `uploading` flag and one main thread)
 *   integrity    — one failure does not sink the rest; the middle one throwing
 *                  still leaves the first and third sent
 *   boundary     — zero files is a no-op; one file behaves exactly as before
 *   empty/null   — a null or undefined entry is counted and stepped over, not
 *                  handed to `send`
 *   hostile      — a `send` that throws SYNCHRONOUSLY is caught too, not only
 *                  a rejected promise
 *   authz/UTF-8/very large/race — N/A: a loop over opaque handles; the bytes,
 *                  the type sniff and the size cap all live in `sendImage`,
 *                  which this deliberately does not re-test.
 */
import { describe, expect, it, vi } from 'vitest';
import { sendPickedFiles } from '@/lib/pickedFiles';

function file(name: string): File {
  return { name } as unknown as File;
}

describe('sendPickedFiles — a selection is several messages', () => {
  it('CONTRACT: three files produce three sends, in pick order', async () => {
    const seen: string[] = [];
    const result = await sendPickedFiles(
      [file('a.png'), file('b.png'), file('c.png')],
      async (f) => {
        seen.push(f.name);
      },
    );
    expect(
      seen,
      'the selection was truncated — this is the `files[0]` bug the `multiple` attribute exposes',
    ).toEqual(['a.png', 'b.png', 'c.png']);
    expect(result).toEqual({ sent: 3, unreadable: 0, failed: 0 });
  });

  it('INTEGRITY: sends are sequential, never overlapping', async () => {
    // `sendImage` drives one `uploading` flag and reads multi-megabyte buffers
    // into the tab. Overlapping calls would race the spinner and land the
    // messages in whatever order the uploads happened to finish.
    let inFlight = 0;
    let maxInFlight = 0;
    await sendPickedFiles([file('a'), file('b'), file('c')], async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
    });
    expect(maxInFlight, 'two sends were in flight at once').toBe(1);
  });

  it('INTEGRITY: one failure does not sink the rest', async () => {
    const seen: string[] = [];
    const result = await sendPickedFiles(
      [file('a'), file('boom'), file('c')],
      async (f) => {
        if (f.name === 'boom') throw new Error('seal failed');
        seen.push(f.name);
      },
    );
    expect(seen, 'a failure in the middle cancelled the rest of the selection').toEqual(['a', 'c']);
    expect(result).toEqual({ sent: 2, unreadable: 0, failed: 1 });
  });

  it('HOSTILE: a send that throws synchronously is caught too', async () => {
    const send = vi.fn((f: File) => {
      if (f.name === 'boom') throw new Error('sync blow-up');
      return Promise.resolve();
    });
    const result = await sendPickedFiles([file('boom'), file('c')], send as never);
    expect(result).toEqual({ sent: 1, unreadable: 0, failed: 1 });
  });

  it('BOUNDARY: zero files sends nothing and does not throw', async () => {
    const send = vi.fn(async () => {});
    expect(await sendPickedFiles([], send)).toEqual({ sent: 0, unreadable: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('BOUNDARY: one file behaves exactly as the single-file path did', async () => {
    const send = vi.fn(async () => {});
    expect(await sendPickedFiles([file('only.png')], send)).toEqual({ sent: 1, unreadable: 0, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('EMPTY: a null or undefined entry is stepped over, not sent', async () => {
    const send = vi.fn(async () => {});
    const result = await sendPickedFiles([null, file('a'), undefined], send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 1, unreadable: 2, failed: 0 });
  });
});
