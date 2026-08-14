/**
 * Browser-side HEIC conversion (H-1).
 *
 * iPhone photos were refused on the web because the server used to transcode
 * them and end-to-end encryption removed that: once the bytes are sealed,
 * nothing downstream can decode a format the browser will not render. So the
 * conversion moved into the tab, before the seal.
 *
 * The one thing that must never happen is the reason this file is careful: a
 * conversion that fails must produce a REFUSAL, never a send of the original.
 * An unviewable picture and an unencrypted one are both worse than a clear no.
 *
 * The decode/encode pair is injected, so these run without a browser and can
 * exercise the failure paths a real canvas would only produce by accident.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MAX_HEIC_INPUT_BYTES,
  convertHeicToJpeg,
  type HeicConvertDeps,
  type HeicDecoder,
  type HeicDecoderLoader,
} from '@/lib/chatMediaHeic';
import { isHeicBytes, resolveChatMediaMime } from '@/lib/chatMedia';

/** Bytes that sniff as HEIC — `ftyp` + a container brand at 4..12. */
function heicBytes(brand = 'heic', length = 64): Uint8Array {
  const b = new Uint8Array(length);
  const head = `0000ftyp${brand}`;
  for (let i = 0; i < head.length && i < length; i++) b[i] = head.charCodeAt(i);
  return b;
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/**
 * No second attempt.
 *
 * The existing cases are about the PLATFORM path, so they pass a loader that
 * yields nothing — otherwise a platform failure would silently be rescued by
 * the decoder and the case would stop testing what it says it tests.
 */
const noDecoder: HeicDecoderLoader = async () => null;

function deps(over: Partial<HeicConvertDeps> = {}, closed = { count: 0 }): HeicConvertDeps {
  return {
    decode: vi.fn(async () => ({ width: 4032, height: 3024, close: () => void closed.count++ })),
    encode: vi.fn(async () => JPEG),
    ...over,
  };
}

describe('converting a HEIC photo in the tab', () => {
  it('returns JPEG bytes the sniffer recognises', async () => {
    const out = await convertHeicToJpeg(heicBytes(), deps(), noDecoder);
    expect(out).not.toBeNull();
    // The point of the whole exercise: what comes out is renderable everywhere.
    expect(resolveChatMediaMime(out!, '', 'IMG_0001.HEIC')).toBe('image/jpeg');
    expect(isHeicBytes(out!)).toBe(false);
  });

  it('CONTRACT: decodes at the image own dimensions, at a real quality', async () => {
    const d = deps();
    await convertHeicToJpeg(heicBytes(), d, noDecoder);
    expect(d.encode).toHaveBeenCalledWith(expect.anything(), 4032, 3024, expect.any(Number));
    const quality = (d.encode as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][3] as number;
    expect(quality).toBeGreaterThan(0.8);
    expect(quality).toBeLessThanOrEqual(1);
  });

  it('MEMORY: closes the decoded bitmap, on success and on failure', async () => {
    // An ImageBitmap holds decoded pixels until closed. Several photos in a row
    // without this is how a tab runs out of memory.
    const closed = { count: 0 };
    await convertHeicToJpeg(heicBytes(), deps({}, closed), noDecoder);
    expect(closed.count).toBe(1);

    await convertHeicToJpeg(
      heicBytes(),
      deps(
        {
          encode: async () => {
            throw new Error('canvas would not allocate');
          },
        },
        closed,
      ),
    );
    expect(closed.count, 'a failed encode must still release the pixels').toBe(2);
  });
});

describe('every way it can fail returns null — never the original', () => {
  it('no decoder in this browser', async () => {
    // Chrome and Firefox cannot decode HEIC; there is nothing to convert with.
    expect(await convertHeicToJpeg(heicBytes(), null, noDecoder)).toBeNull();
  });

  it('a decoder that cannot read this container', async () => {
    const out = await convertHeicToJpeg(
      heicBytes(),
      deps({
        decode: async () => {
          throw new Error('unsupported container');
        },
      }),
    );
    expect(out).toBeNull();
  });

  it('a decode that yields no dimensions', async () => {
    expect(await convertHeicToJpeg(heicBytes(), deps({ decode: async () => ({ width: 0, height: 0 }) }), noDecoder)).toBeNull();
  });

  it('an encode that yields nothing', async () => {
    expect(await convertHeicToJpeg(heicBytes(), deps({ encode: async () => null }), noDecoder)).toBeNull();
  });

  it('an encode that yields ZERO bytes — a "photo" nobody can open', async () => {
    expect(
      await convertHeicToJpeg(heicBytes(), deps({ encode: async () => new Uint8Array(0) }), noDecoder),
    ).toBeNull();
  });

  it('an empty file', async () => {
    expect(await convertHeicToJpeg(new Uint8Array(0), deps(), noDecoder)).toBeNull();
  });

  it('BOUNDARY: at the input cap it converts, one byte past it does not', async () => {
    // The cap is on the INPUT because decoding is what kills a tab; the output
    // is capped separately, by the caller, against the converted bytes.
    const d = deps();
    expect(await convertHeicToJpeg(heicBytes('heic', MAX_HEIC_INPUT_BYTES), d, noDecoder)).not.toBeNull();
    expect(await convertHeicToJpeg(heicBytes('heic', MAX_HEIC_INPUT_BYTES + 1), d, noDecoder)).toBeNull();
    expect(d.decode, 'an oversized input must not even be decoded').toHaveBeenCalledTimes(1);
  });
});

describe('what gets converted at all', () => {
  it('every HEIC brand the sniffer knows is a candidate', () => {
    for (const brand of ['heic', 'heix', 'heim', 'heis', 'hevc', 'mif1', 'msf1']) {
      expect(isHeicBytes(heicBytes(brand)), brand).toBe(true);
    }
  });

  it('HOSTILE: a file CLAIMING .heic that is not one is never sent through the decoder', () => {
    // The caller converts on the BYTES, not the name — a PNG called `photo.heic`
    // is a PNG, and passing it to a HEIC decode would fail for a reason that
    // has nothing to do with the user.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(isHeicBytes(png)).toBe(false);
    expect(resolveChatMediaMime(png, 'image/heic', 'photo.heic')).toBe('image/png');
  });

  it('a multi-image container is still one photo to us', async () => {
    /*
     * A burst, a Live Photo or a depth-map pair decodes to its PRIMARY image —
     * the one Photos shows and the one the sender means. Asserted as a
     * contract: one decode, one encode, one output.
     */
    const d = deps();
    const out = await convertHeicToJpeg(heicBytes('msf1'), d, noDecoder);
    expect(out).not.toBeNull();
    expect(d.decode).toHaveBeenCalledTimes(1);
    expect(d.encode).toHaveBeenCalledTimes(1);
  });
});

describe('the second attempt — a decoder imported only when needed', () => {
  const JPEG_FROM_DECODER = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 9, 9]);
  const decoder = (out: Uint8Array | Error = JPEG_FROM_DECODER) =>
    vi.fn(async () => {
      if (out instanceof Error) throw out;
      return out.buffer.slice(0) as ArrayBuffer;
    }) as unknown as HeicDecoder;

  it('ORDER: the platform goes first and the decoder is never imported when it works', async () => {
    /*
     * The whole economy of this design. Safari converts for free; pulling down
     * a megabyte anyway would spend a person's bandwidth to duplicate something
     * their browser already did.
     */
    const load = vi.fn(async () => decoder());
    const out = await convertHeicToJpeg(heicBytes(), deps(), load);

    expect(out).not.toBeNull();
    expect(load, 'nothing should be downloaded when the platform can do it').not.toHaveBeenCalled();
  });

  it('a browser with NO decoder gets the picture through', async () => {
    // Chrome, Firefox: `createImageBitmap` cannot read HEIC, so `browserDeps()`
    // is effectively absent. This is the person the refusal used to turn away.
    const load = vi.fn(async () => decoder());
    const out = await convertHeicToJpeg(heicBytes(), null, load);

    expect(load).toHaveBeenCalledTimes(1);
    expect(Array.from(out!.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
  });

  it('a platform decode that FAILS falls through to the decoder', async () => {
    const load = vi.fn(async () => decoder());
    const out = await convertHeicToJpeg(
      heicBytes(),
      deps({
        decode: async () => {
          throw new Error('cannot read this container');
        },
      }),
      load,
    );

    expect(load).toHaveBeenCalledTimes(1);
    expect(out).not.toBeNull();
  });

  it('BOUNDARY: an over-cap file is refused BEFORE anything is imported', async () => {
    // Pulling down a decoder to then refuse the file wastes bandwidth for
    // nothing — the check has to come first.
    const load = vi.fn(async () => decoder());
    const out = await convertHeicToJpeg(heicBytes('heic', MAX_HEIC_INPUT_BYTES + 1), null, load);

    expect(out).toBeNull();
    expect(load, 'never download a decoder for a file we will not accept').not.toHaveBeenCalled();
  });

  it('an import that fails is a refusal, not a crash', async () => {
    // Offline, a blocked chunk, a deploy mid-flight.
    const out = await convertHeicToJpeg(heicBytes(), null, async () => null);
    expect(out).toBeNull();
  });

  it('a decoder that throws is a refusal — never the original', async () => {
    const load = async () => decoder(new Error('libheif said no'));
    expect(await convertHeicToJpeg(heicBytes(), null, load)).toBeNull();
  });

  it('a decoder that yields ZERO bytes is a refusal', async () => {
    const load = async () => decoder(new Uint8Array(0));
    expect(await convertHeicToJpeg(heicBytes(), null, load)).toBeNull();
  });

  it('CONTRACT: the decoder is asked for JPEG at a real quality', async () => {
    const dec = decoder();
    await convertHeicToJpeg(heicBytes(), null, async () => dec);
    const call = (dec as unknown as { mock: { calls: Array<[{ format: string; quality: number }]> } }).mock
      .calls[0][0];
    expect(call.format).toBe('JPEG');
    expect(call.quality).toBeGreaterThan(0.8);
    expect(call.quality).toBeLessThanOrEqual(1);
  });
});
