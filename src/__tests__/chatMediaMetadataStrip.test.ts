/**
 * Metadata stripping for E2EE CHAT attachments — the client-side strip.
 *
 * The defect being closed: a chat picture was encrypted end to end and sent
 * with its GPS coordinates, capture time, camera make/model, body serial
 * number and embedded thumbnail still inside it. Encrypted against the
 * operator; fully readable by the recipient, and by anyone the recipient
 * forwards it to. The post-upload path had been scrubbed server-side with
 * sharp — but this path has no server that may look, so the strip has to
 * happen on the device, before `seal`.
 *
 * These tests run the SHARED implementation from `@openstoa/mls`, which is the
 * one both clients execute; `packages/mobile/src/__tests__/chatMediaMetadataStrip.test.ts`
 * runs the same code through the mini-app's import path with `Buffer` deleted,
 * because the mini-app has no Node.
 *
 * Fixtures come from two places on purpose:
 *   - `./fixtures/images` — real sharp output, so "orientation survives in
 *     effect" can be asserted by DECODING the result rather than by reading
 *     back the tag we just wrote;
 *   - `packages/mls/src/__tests__/imageFixtures` — hand-built bytes, for the
 *     hostile shapes no encoder will produce on request, and shared with the
 *     mini-app suite.
 *
 * Policy and evidence: `docs/design/image-metadata-policy.md`.
 */
import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import {
  ImageMetadataError,
  readOrientationFromTiff,
  sniffImageFormat,
  stripImageMetadata,
} from '../../packages/mls/src/imageMetadata';
import { stripImageMetadata as stripOnServer } from '@/lib/imageMetadata';
import {
  ChatMediaError,
  chatMediaObjectKey,
  parseChatMediaBody,
  sendEncryptedChatMedia,
} from '@/lib/chatMedia';
import {
  SECRETS as SHARP_SECRETS,
  gifWithMetadata,
  jpegWithMetadata,
  jpegWithThumbnail,
  pngWithMetadata,
  webpWithMetadata,
} from './fixtures/images';
import {
  SECRETS,
  bmpWithTrailingData,
  concatBytes,
  containsText,
  exifBlock,
  gifWithMetadata as pureGif,
  jpegSegment,
  jpegWithMetadata as pureJpeg,
  latin1,
  pngChunk,
  pngWithMetadata as purePng,
  riffChunk,
  webpWithMetadata as pureWebp,
} from '../../packages/mls/src/__tests__/imageFixtures';

/* --------------------------------------------------------------- helpers -- */

function assertNoSecrets(out: Uint8Array, secrets: readonly string[]) {
  for (const secret of secrets) {
    expect(containsText(out, secret), `output still contains "${secret}"`).toBe(false);
  }
}

/** Guards against a vacuous pass: the fixture must really carry the secret. */
function assertFixtureCarries(input: Uint8Array, secrets: readonly string[]) {
  for (const secret of secrets) {
    expect(containsText(input, secret), `fixture is missing "${secret}"`).toBe(true);
  }
}

function pngChunkTypes(buf: Uint8Array): string[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const types: string[] = [];
  let i = 8;
  while (i + 8 <= buf.length) {
    const length = view.getUint32(i);
    let type = '';
    for (let k = 0; k < 4; k++) type += String.fromCharCode(buf[i + 4 + k]);
    types.push(type);
    i += 12 + length;
  }
  return types;
}

function pngChunkData(buf: Uint8Array, wanted: string): Uint8Array | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 8;
  while (i + 8 <= buf.length) {
    const length = view.getUint32(i);
    let type = '';
    for (let k = 0; k < 4; k++) type += String.fromCharCode(buf[i + 4 + k]);
    if (type === wanted) return buf.subarray(i + 8, i + 8 + length);
    i += 12 + length;
  }
  return null;
}

function riffChunks(buf: Uint8Array): Array<{ fourcc: string; data: Uint8Array }> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Array<{ fourcc: string; data: Uint8Array }> = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    let fourcc = '';
    for (let k = 0; k < 4; k++) fourcc += String.fromCharCode(buf[i + k]);
    const size = view.getUint32(i + 4, true);
    out.push({ fourcc, data: buf.subarray(i + 8, i + 8 + size) });
    i += 8 + size + (size % 2);
  }
  return out;
}

/** JPEG marker bytes in order, so a dropped or kept segment is visible. */
function jpegMarkers(buf: Uint8Array): number[] {
  const markers: number[] = [];
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    markers.push(marker);
    if (marker === 0xda || marker === 0xd9) break;
    i += 2 + ((buf[i + 2] << 8) | buf[i + 3]);
  }
  return markers;
}

/** GIF block introducers/labels in order. */
function gifBlocks(buf: Uint8Array): string[] {
  const packed = buf[10];
  let i = 13;
  if (packed & 0x80) i += 3 * (1 << ((packed & 0x07) + 1));
  const blocks: string[] = [];
  const skip = (from: number) => {
    let p = from;
    for (;;) {
      const size = buf[p];
      if (size === 0) return p + 1;
      p += 1 + size;
    }
  };
  while (i < buf.length) {
    if (buf[i] === 0x3b) { blocks.push('trailer'); break; }
    if (buf[i] === 0x21) {
      blocks.push('ext:0x' + buf[i + 1].toString(16));
      i = skip(i + 2);
      continue;
    }
    if (buf[i] === 0x2c) {
      blocks.push('image');
      const localPacked = buf[i + 9];
      let p = i + 10;
      if (localPacked & 0x80) p += 3 * (1 << ((localPacked & 0x07) + 1));
      i = skip(p + 1);
      continue;
    }
    blocks.push('unknown');
    break;
  }
  return blocks;
}

const rawPixels = (buf: Uint8Array) => sharp(Buffer.from(buf)).raw().toBuffer();

/** What a decoder that honours the orientation tag actually displays. */
async function displayedSize(buf: Uint8Array): Promise<{ width: number; height: number }> {
  const { info } = await sharp(Buffer.from(buf)).rotate().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height };
}

const ALL_SECRETS = Object.values(SECRETS);
/** What each fixture actually carries — asserting more makes the guard lie. */
const JPEG_SECRETS = ALL_SECRETS.filter((v) => v !== SECRETS.pngText && v !== SECRETS.gifComment);

/* ----------------------------------------------------------------- sniff -- */

describe('sniffImageFormat — the bytes decide, never the declared type', () => {
  it('identifies every container the chat allowlist can carry', () => {
    expect(sniffImageFormat(pureJpeg())).toBe('jpeg');
    expect(sniffImageFormat(purePng())).toBe('png');
    expect(sniffImageFormat(pureWebp())).toBe('webp');
    expect(sniffImageFormat(pureGif())).toBe('gif');
    expect(sniffImageFormat(bmpWithTrailingData())).toBe('bmp');
  });

  it('an unknown container is unknown, however it is labelled', () => {
    expect(sniffImageFormat(new Uint8Array(64))).toBe('unknown');
    expect(sniffImageFormat(new Uint8Array([0x49, 0x49, 0x2a, 0x00]))).toBe('unknown'); // TIFF
    expect(sniffImageFormat(new Uint8Array(0))).toBe('unknown');
  });
});

/* ------------------------------------------------------------------ JPEG -- */

describe('JPEG — the camera-photo case', () => {
  it('P1: GPS, capture time, camera, serial, software, XMP, IPTC and comments all go', () => {
    const input = pureJpeg();
    assertFixtureCarries(input, JPEG_SECRETS);

    const { bytes: out, strategy } = stripImageMetadata(input);
    expect(strategy).toBe('surgical');
    assertNoSecrets(out, ALL_SECRETS);
  });

  it('P2: the segments that carry metadata are gone; JFIF and ICC stay', () => {
    const markers = jpegMarkers(stripImageMetadata(pureJpeg()).bytes);
    expect(markers).toContain(0xe0); // APP0 JFIF — density
    expect(markers).toContain(0xe2); // APP2 ICC — colour
    expect(markers).toContain(0xc0); // SOF0
    expect(markers).toContain(0xda); // SOS
    expect(markers.filter((m) => m === 0xed)).toEqual([]); // APP13 IPTC
    expect(markers.filter((m) => m === 0xfe)).toEqual([]); // COM
    // The one APP1 left is the rebuilt orientation block, not the camera's.
    expect(markers.filter((m) => m === 0xe1).length).toBe(1);
  });

  it('P3: the pixels are copied byte for byte — no re-encode, no generation loss', async () => {
    const input = await jpegWithMetadata();
    const { bytes: out } = stripImageMetadata(input);
    expect(await rawPixels(out)).toEqual(await rawPixels(input));
    expect(out.length).toBeLessThan(input.length);
  });

  it('P4: orientation survives IN EFFECT — a portrait photo stays portrait', async () => {
    // 60x40 pixels + Orientation=6 (rotate 90 CW) is a portrait photo.
    const input = await jpegWithMetadata({ width: 60, height: 40, orientation: 6 });
    expect(await displayedSize(input)).toEqual({ width: 40, height: 60 });

    const { bytes: out } = stripImageMetadata(input);
    expect((await sharp(Buffer.from(out)).metadata()).orientation).toBe(6);
    // Dropping the tag would make this 60x40 — the sideways-iPhone-photo bug.
    expect(await displayedSize(out)).toEqual({ width: 40, height: 60 });
  });

  it('P5: all eight orientations are carried across unchanged', () => {
    for (let orientation = 1; orientation <= 8; orientation++) {
      const { bytes: out } = stripImageMetadata(pureJpeg({ orientation }));
      const app1 = out.subarray(12, 38);
      if (orientation === 1) {
        // Nothing to carry: 1 is "normal", and re-emitting it is noise.
        expect(jpegMarkers(out).filter((m) => m === 0xe1)).toEqual([]);
      } else {
        expect(readOrientationFromTiff(app1), `orientation ${orientation}`).toBe(orientation);
      }
    }
  });

  it('P6: the embedded thumbnail goes — the redaction-bypass field', async () => {
    /*
     * The thumbnail is not regenerated when the main image is cropped or
     * painted over, so a "redacted" photo can hand the recipient the redacted
     * region in its own EXIF. Keeping IFD1 is the classic version of this bug.
     */
    const input = await jpegWithThumbnail(6);
    assertFixtureCarries(input, [SHARP_SECRETS.thumbnail]);

    const { bytes: out } = stripImageMetadata(input);
    expect(containsText(out, SHARP_SECRETS.thumbnail)).toBe(false);
    // The rebuilt block has no IFD1 pointer at all, so no thumbnail can hide.
    const app1 = out.subarray(12, 38);
    expect(readOrientationFromTiff(app1)).toBe(6);
    expect(app1.length).toBe(26);
  });

  it('P7: the ICC colour profile is KEPT — wrong colours are not a privacy win', async () => {
    const input = await jpegWithMetadata({ icc: true });
    const { bytes: out } = stripImageMetadata(input);
    expect((await sharp(Buffer.from(out)).metadata()).icc).toBeDefined();
  });
});

/* ------------------------------------------------------------------- PNG -- */

describe('PNG', () => {
  it('P8: tEXt / iTXt / tIME / eXIf are dropped, rendering chunks are kept', async () => {
    const input = await pngWithMetadata();
    assertFixtureCarries(input, [SHARP_SECRETS.pngText, SHARP_SECRETS.xmp]);

    const { bytes: out } = stripImageMetadata(input);
    const types = pngChunkTypes(out);
    expect(types).toContain('IHDR');
    expect(types).toContain('IDAT');
    expect(types).toContain('IEND');
    expect(types).toContain('iCCP');
    for (const dropped of ['tEXt', 'iTXt', 'zTXt', 'tIME', 'eXIf']) {
      expect(types, dropped).not.toContain(dropped);
    }
    assertNoSecrets(out, [SHARP_SECRETS.pngText, SHARP_SECRETS.xmp]);
    expect(await rawPixels(out)).toEqual(await rawPixels(input));
  });

  it('P9: a PNG orientation is re-emitted as an orientation-ONLY eXIf chunk', () => {
    /*
     * Where the client and the server diverge, on purpose. The server decodes,
     * bakes the rotation into the pixels and re-encodes; there is no decoder
     * here, so the tag is rebuilt instead — carrying the orientation and
     * nothing else, with no IFD1 and therefore no thumbnail. What the
     * recipient's decoder does with the tag is what the sender's decoder did.
     */
    const input = purePng({ orientation: 8 });
    const { bytes: out } = stripImageMetadata(input);
    const exif = pngChunkData(out, 'eXIf');
    expect(exif).not.toBeNull();
    expect(exif!.length).toBe(26); // one tag, no IFD1
    expect(readOrientationFromTiff(exif!)).toBe(8);
    assertNoSecrets(out, ALL_SECRETS);
  });

  it('P10: orientation 1 is not re-emitted — there is nothing to say', () => {
    const { bytes: out } = stripImageMetadata(purePng({ orientation: 1 }));
    expect(pngChunkTypes(out)).not.toContain('eXIf');
  });
});

/* ------------------------------------------------------------------ WebP -- */

describe('WebP', () => {
  it('P11: EXIF and XMP chunks go, ICCP and the image data stay', async () => {
    const input = await webpWithMetadata();
    assertFixtureCarries(input, [SHARP_SECRETS.make, SHARP_SECRETS.xmp]);

    const { bytes: out } = stripImageMetadata(input);
    const fourccs = riffChunks(out).map((c) => c.fourcc);
    expect(fourccs).not.toContain('XMP ');
    expect(fourccs.some((f) => f === 'VP8 ' || f === 'VP8L')).toBe(true);
    assertNoSecrets(out, [SHARP_SECRETS.make, SHARP_SECRETS.model, SHARP_SECRETS.xmp]);
    expect(await rawPixels(out)).toEqual(await rawPixels(input));
  });

  it('P12: the VP8X flags never advertise a chunk that is no longer there', () => {
    const out = stripImageMetadata(pureWebp({ orientation: 1 })).bytes;
    const vp8x = riffChunks(out).find((c) => c.fourcc === 'VP8X');
    expect(vp8x).toBeDefined();
    expect(vp8x!.data[0] & 0x04).toBe(0); // XMP bit clear — the chunk is gone
    expect(vp8x!.data[0] & 0x08).toBe(0); // EXIF bit clear — likewise
  });

  it('P13: an orientation is re-emitted as an EXIF chunk carrying only that', () => {
    const out = stripImageMetadata(pureWebp({ orientation: 6 })).bytes;
    const chunks = riffChunks(out);
    const exif = chunks.find((c) => c.fourcc === 'EXIF');
    expect(exif).toBeDefined();
    expect(exif!.data.length).toBe(26);
    expect(readOrientationFromTiff(exif!.data)).toBe(6);
    // The flag and the chunk agree, and metadata sits after the image data.
    expect(chunks.find((c) => c.fourcc === 'VP8X')!.data[0] & 0x08).toBe(0x08);
    expect(chunks[chunks.length - 1].fourcc).toBe('EXIF');
    assertNoSecrets(out, ALL_SECRETS);
  });

  it('P14: the caller’s buffer is never mutated', () => {
    // The VP8X flag byte is rewritten, and a `Buffer` slice is a VIEW.
    const input = pureWebp({ orientation: 6 });
    const before = Array.from(input);
    stripImageMetadata(input);
    expect(Array.from(input)).toEqual(before);
  });
});

/* ------------------------------------------------------------------- GIF -- */

describe('GIF', () => {
  it('P15: the comment and the XMP application extension go; looping stays', async () => {
    const input = await gifWithMetadata();
    assertFixtureCarries(input, [SHARP_SECRETS.gifComment, SHARP_SECRETS.xmp]);

    const { bytes: out } = stripImageMetadata(input);
    assertNoSecrets(out, [SHARP_SECRETS.gifComment, SHARP_SECRETS.xmp]);
    expect(gifBlocks(out)).not.toContain('ext:0xfe'); // comment extension
    expect(gifBlocks(out)).toContain('image');
    expect(await rawPixels(out)).toEqual(await rawPixels(input));
  });

  it('P16: the NETSCAPE loop extension and frame timing survive', () => {
    const blocks = gifBlocks(stripImageMetadata(pureGif()).bytes);
    expect(blocks).toContain('ext:0xff'); // NETSCAPE2.0 — the loop count
    expect(blocks).toContain('ext:0xf9'); // graphic control — frame timing
    expect(blocks).toContain('image');
    expect(blocks[blocks.length - 1]).toBe('trailer');
    assertNoSecrets(stripImageMetadata(pureGif()).bytes, [SECRETS.gifComment, SECRETS.xmp]);
  });
});

/* ------------------------------------------------------------------- BMP -- */

describe('BMP', () => {
  it('P17: BMP has no metadata container, so only appended data is trimmed', () => {
    const input = bmpWithTrailingData();
    assertFixtureCarries(input, [SECRETS.gps]);

    const { bytes: out, strategy } = stripImageMetadata(input);
    expect(strategy).toBe('passthrough');
    expect(containsText(out, SECRETS.gps)).toBe(false);
    expect(out.length).toBe(14 + 40 + 16);
  });

  it('a BMP whose header lies about its size is passed through, not truncated to junk', () => {
    const input = bmpWithTrailingData('');
    const lying = new Uint8Array(input);
    new DataView(lying.buffer).setUint32(2, 0xfffffff0, true);
    expect(stripImageMetadata(lying).bytes.length).toBe(lying.length);
  });
});

/* ------------------------------------------------- hostile / corrupt input -- */

describe('hostile and corrupt input — refused, never crashed, never passed through', () => {
  const cases: Array<[string, Uint8Array]> = [
    ['an empty buffer', new Uint8Array(0)],
    ['one byte', new Uint8Array([9])],
    ['text', latin1('this is not an image at all')],
    ['a TIFF (a real image we cannot walk)', new Uint8Array([0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4])],
    ['a JPEG that stops after SOI', new Uint8Array([0xff, 0xd8, 0xff, 0xe1])],
    ['a JPEG segment length that runs past the end', concatBytes([
      new Uint8Array([0xff, 0xd8]),
      new Uint8Array([0xff, 0xe1, 0x7f, 0xff]),
      latin1('short'),
    ])],
    ['a JPEG with no scan data', concatBytes([
      new Uint8Array([0xff, 0xd8]),
      jpegSegment(0xe1, exifBlock()),
      new Uint8Array([0xff, 0xd9]),
    ])],
    ['a JPEG segment claiming a length below the minimum', new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01])],
    ['a PNG chunk length past the end', concatBytes([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      new Uint8Array([0x7f, 0xff, 0xff, 0xff]),
      latin1('IHDR'),
    ])],
    ['a PNG with no IEND', concatBytes([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', new Uint8Array(13)),
    ])],
    ['a WebP chunk size past the end', concatBytes([
      latin1('RIFF'),
      new Uint8Array([0, 0, 0, 0]),
      latin1('WEBP'),
      latin1('VP8 '),
      new Uint8Array([0xff, 0xff, 0xff, 0x7f]),
    ])],
    ['a GIF whose sub-blocks never terminate', concatBytes([
      latin1('GIF89a'),
      new Uint8Array([1, 0, 1, 0, 0, 0, 0]),
      new Uint8Array([0x21, 0xfe, 0x05]),
      latin1('abcde'),
    ])],
    ['a GIF with an unexpected block introducer', concatBytes([
      latin1('GIF89a'),
      new Uint8Array([1, 0, 1, 0, 0, 0, 0]),
      new Uint8Array([0x99]),
    ])],
  ];

  for (const [name, bytes] of cases) {
    it(`H: ${name} is refused with a typed error`, () => {
      let thrown: unknown;
      try {
        stripImageMetadata(bytes);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, 'nothing was thrown — the bytes were accepted').toBeInstanceOf(ImageMetadataError);
      expect(['corrupt', 'unsupported']).toContain((thrown as ImageMetadataError).reason);
    });
  }

  it('H: an EXIF block claiming 65535 entries terminates instead of walking off the end', () => {
    const tiff = new Uint8Array(20);
    tiff[0] = 0x4d; tiff[1] = 0x4d;
    new DataView(tiff.buffer).setUint16(2, 42);
    new DataView(tiff.buffer).setUint32(4, 8);
    new DataView(tiff.buffer).setUint16(8, 0xffff); // 65535 entries in 20 bytes
    expect(readOrientationFromTiff(tiff)).toBeNull();
  });

  it('H: an APP1 that says "Exif" and then stops does not throw out of the parser', () => {
    const input = concatBytes([
      new Uint8Array([0xff, 0xd8]),
      jpegSegment(0xe1, latin1('Exif\0\0')),
      jpegSegment(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0])),
      new Uint8Array([0x11, 0x22]),
      new Uint8Array([0xff, 0xd9]),
    ]);
    const { bytes: out } = stripImageMetadata(input);
    expect(jpegMarkers(out).filter((m) => m === 0xe1)).toEqual([]);
  });

  it('H: a non-Uint8Array is refused rather than coerced', () => {
    expect(() => stripImageMetadata(null as unknown as Uint8Array)).toThrow(ImageMetadataError);
    expect(() => stripImageMetadata('x' as unknown as Uint8Array)).toThrow(ImageMetadataError);
  });

  it('L: a multi-megabyte image is cleaned without blowing the stack', () => {
    // The largest input this ever sees is an attachment at the cap. `concat`
    // must not spread it into an argument list.
    const big = concatBytes([
      pureJpeg(),
      new Uint8Array(0), // marker for readability; the scan is extended below
    ]);
    const inflated = concatBytes([
      big.subarray(0, big.length - 2),
      new Uint8Array(8 * 1024 * 1024).fill(0x33),
      new Uint8Array([0xff, 0xd9]),
    ]);
    const { bytes: out } = stripImageMetadata(inflated);
    expect(out.length).toBeGreaterThan(8 * 1024 * 1024);
    assertNoSecrets(out, ALL_SECRETS);
  });
});

/* ------------------------------------------------------- the send contract -- */

describe('CONTRACT: the E2EE send path strips before it seals', () => {
  const TOPIC = '11111111-2222-3333-4444-555555555555';
  const USER = '0xabc123';

  function harness() {
    const sealedPlaintext: Uint8Array[] = [];
    const seal = vi.fn(async (mediaId: string, bytes: Uint8Array) => {
      sealedPlaintext.push(bytes);
      const out = new Uint8Array(bytes.length + 1);
      out.set(bytes, 1);
      out[0] = 0xff;
      return { ciphertext: out, takVersion: 7 };
    });
    const upload = vi.fn(async (_ciphertext: Uint8Array, mediaId: string) =>
      chatMediaObjectKey(TOPIC, USER, mediaId),
    );
    const send = vi.fn(async (_body: string) => {});
    const discard = vi.fn(async () => {});
    return { seal, upload, send, discard, sealedPlaintext };
  }

  it('C1: the bytes handed to `seal` carry none of the camera metadata', async () => {
    /*
     * THE row that catches a future refactor quietly dropping the strip. It
     * asserts on the plaintext at the encryption boundary — the last place the
     * data is legible — so removing the call from `sendEncryptedChatMedia`
     * fails here no matter how the bytes get there.
     */
    const h = harness();
    const input = pureJpeg();
    assertFixtureCarries(input, JPEG_SECRETS);

    await sendEncryptedChatMedia({ bytes: input, mime: 'image/jpeg' }, h);

    expect(h.seal).toHaveBeenCalledTimes(1);
    assertNoSecrets(h.sealedPlaintext[0], ALL_SECRETS);
    // ...and the plaintext is not simply the input passed through.
    expect(h.sealedPlaintext[0].length).toBeLessThan(input.length);
  });

  it('C2: the ciphertext that goes UP contains none of it either', async () => {
    const h = harness();
    await sendEncryptedChatMedia({ bytes: pureJpeg(), mime: 'image/jpeg' }, h);
    const [ciphertext] = h.upload.mock.calls[0];
    assertNoSecrets(ciphertext as Uint8Array, ALL_SECRETS);
  });

  it('C3: the envelope describes the STRIPPED size, not the picked file', async () => {
    const h = harness();
    const input = pureJpeg();
    await sendEncryptedChatMedia({ bytes: input, mime: 'image/jpeg' }, h);
    const parsed = parseChatMediaBody(h.send.mock.calls[0][0]);
    expect(parsed!.size).toBe(h.sealedPlaintext[0].length);
    expect(parsed!.size).toBeLessThan(input.length);
  });

  it('C4: every allowlisted type goes through the strip, not just JPEG', async () => {
    const inputs: Array<[string, Uint8Array]> = [
      ['image/jpeg', pureJpeg()],
      ['image/png', purePng()],
      ['image/webp', pureWebp()],
      ['image/gif', pureGif()],
      ['image/bmp', bmpWithTrailingData()],
    ];
    for (const [mime, bytes] of inputs) {
      const h = harness();
      await sendEncryptedChatMedia({ bytes, mime }, h);
      assertNoSecrets(h.sealedPlaintext[0], ALL_SECRETS);
    }
  });

  it('C5: a corrupt image FAILS the send — it is never sent unstripped', async () => {
    /*
     * Fail closed, following Signal-iOS, which treats a failed strip as a
     * send-blocking error. The alternative — send the original because the
     * cleaner did not understand it — is the pre-2018 Signal-Android bug that
     * shipped GPS for two years.
     */
    const h = harness();
    const corrupt = concatBytes([new Uint8Array([0xff, 0xd8]), new Uint8Array([0xff, 0xe1, 0x7f, 0xff])]);
    await expect(sendEncryptedChatMedia({ bytes: corrupt, mime: 'image/jpeg' }, h)).rejects.toMatchObject({
      reason: 'strip-failed',
    });
    expect(h.seal).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('C6: the failure is a typed ChatMediaError, so the send path does not crash', async () => {
    const h = harness();
    const err = await sendEncryptedChatMedia({ bytes: latin1('nope'), mime: 'image/png' }, h).catch((e) => e);
    expect(err).toBeInstanceOf(ChatMediaError);
    expect(err.reason).toBe('strip-failed');
  });
});

/* ------------------------------------------------- client / server parity -- */

describe('the client and the server agree on what "stripped" means', () => {
  /*
   * Two implementations exist because two environments do: the upload route
   * has sharp, the chat clients have nothing. They must not drift into two
   * definitions of the word. This runs both over the same fixture and holds
   * them to the same outcome.
   */
  it('both remove every field on the strip list, from the same JPEG', async () => {
    const input = await jpegWithMetadata();
    const secrets = Object.values(SHARP_SECRETS);

    const client = stripImageMetadata(input).bytes;
    const server = (await stripOnServer(Buffer.from(input))).buffer;

    assertNoSecrets(client, secrets);
    assertNoSecrets(server, secrets);
  });

  it('both keep the orientation in effect and the ICC profile', async () => {
    const input = await jpegWithMetadata({ width: 60, height: 40, orientation: 6, icc: true });
    const client = stripImageMetadata(input).bytes;
    const server = (await stripOnServer(Buffer.from(input))).buffer;

    expect(await displayedSize(client)).toEqual({ width: 40, height: 60 });
    expect(await displayedSize(server)).toEqual({ width: 40, height: 60 });
    expect((await sharp(Buffer.from(client)).metadata()).icc).toBeDefined();
    expect((await sharp(server).metadata()).icc).toBeDefined();
  });

  it('DIVERGENCE, stated: PNG orientation is re-tagged here and re-encoded there', async () => {
    /*
     * Not a disagreement about policy — both end up displaying the same
     * picture with no GPS in it. The server can decode, so it bakes the
     * rotation into the pixels; the client cannot, so it re-tags. If this test
     * starts failing because the client grew a decoder, delete the divergence
     * rather than the assertion.
     */
    const input = await pngWithMetadata({ orientation: 6 });
    const client = stripImageMetadata(input);
    const server = await stripOnServer(Buffer.from(input));

    expect(client.strategy).toBe('surgical');
    expect(server.strategy).toBe('re-encode');
    expect(await displayedSize(client.bytes)).toEqual(await displayedSize(server.buffer));
    assertNoSecrets(client.bytes, Object.values(SHARP_SECRETS));
  });
});
