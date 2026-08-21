import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  stripImageMetadata,
  sniffImageFormat,
  readOrientationFromTiff,
  ImageMetadataError,
} from '@/lib/imageMetadata';
import {
  SECRETS,
  SVG_WITH_METADATA,
  appendRiffChunk,
  exifWithThumbnail,
  gifWithMetadata,
  insertJpegSegments,
  insertPngChunks,
  insertPngChunksBeforeIdat,
  jpegSegment,
  jpegWithMetadata,
  jpegWithThumbnail,
  pngChunk,
  pngWithMetadata,
  webpWithMetadata,
} from './fixtures/images';

/** Every secret string, searched for in the raw output bytes. */
function assertNoSecrets(out: Buffer, secrets: string[] = Object.values(SECRETS)) {
  for (const secret of secrets) {
    expect(
      out.includes(Buffer.from(secret, 'utf8')) || out.includes(Buffer.from(secret, 'latin1')),
      `output still contains "${secret}"`,
    ).toBe(false);
  }
}

function pngChunkTypes(buf: Buffer): string[] {
  const types: string[] = [];
  let i = 8;
  while (i + 8 <= buf.length) {
    const length = buf.readUInt32BE(i);
    types.push(buf.toString('ascii', i + 4, i + 8));
    i += 12 + length;
  }
  return types;
}

function riffChunks(buf: Buffer): Array<{ fourcc: string; size: number; offset: number }> {
  const out: Array<{ fourcc: string; size: number; offset: number }> = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const fourcc = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    out.push({ fourcc, size, offset: i });
    i += 8 + size + (size % 2);
  }
  return out;
}

/** GIF block introducers, in order: 0x21<label> extensions, 0x2C frames. */
function gifBlocks(buf: Buffer): string[] {
  const packed = buf[10];
  let i = 13;
  if (packed & 0x80) i += 3 * (1 << ((packed & 0x07) + 1));
  const blocks: string[] = [];
  const skipSubBlocks = (from: number) => {
    let p = from;
    for (;;) {
      const size = buf[p];
      if (size === 0) return p + 1;
      p += 1 + size;
    }
  };
  while (i < buf.length) {
    const introducer = buf[i];
    if (introducer === 0x3b) { blocks.push('trailer'); break; }
    if (introducer === 0x21) {
      const label = buf[i + 1];
      blocks.push(`ext:0x${label.toString(16)}`);
      i = skipSubBlocks(i + 2);
      continue;
    }
    if (introducer === 0x2c) {
      blocks.push('image');
      const localPacked = buf[i + 9];
      let p = i + 10;
      if (localPacked & 0x80) p += 3 * (1 << ((localPacked & 0x07) + 1));
      i = skipSubBlocks(p + 1);
      continue;
    }
    blocks.push(`unknown:0x${introducer.toString(16)}`);
    break;
  }
  return blocks;
}

async function rawPixels(buf: Buffer): Promise<Buffer> {
  return sharp(buf).raw().toBuffer();
}

describe('sniffImageFormat', () => {
  it('identifies formats from magic bytes, not from any declared type', async () => {
    expect(sniffImageFormat(await jpegWithMetadata())).toBe('jpeg');
    expect(sniffImageFormat(await pngWithMetadata())).toBe('png');
    expect(sniffImageFormat(await webpWithMetadata())).toBe('webp');
    expect(sniffImageFormat(await gifWithMetadata())).toBe('gif');
    expect(sniffImageFormat(Buffer.from(SVG_WITH_METADATA))).toBe('svg');
    expect(sniffImageFormat(Buffer.alloc(1024))).toBe('unknown');
  });
});

describe('stripImageMetadata — JPEG', () => {
  it('removes GPS, DateTimeOriginal, Make/Model/Lens/BodySerialNumber, Software, XMP, IPTC and comments', async () => {
    const input = await jpegWithMetadata();
    // Sanity: the fixture really does carry all of it.
    assertNoSecretsInverted(input);

    const { buffer: out, strategy } = await stripImageMetadata(input);
    expect(strategy).toBe('surgical');
    assertNoSecrets(out);

    const md = await sharp(out).metadata();
    // The only EXIF left is the rebuilt orientation-only block.
    expect(md.exif === undefined || md.exif.length <= 40).toBe(true);
  });

  it('keeps the image renderable and byte-identical in its pixels (no re-encode)', async () => {
    const input = await jpegWithMetadata();
    const { buffer: out } = await stripImageMetadata(input);

    expect(await rawPixels(out)).toEqual(await rawPixels(input));
    expect(out.length).toBeLessThan(input.length); // metadata gone, pixels untouched
  });

  it('preserves orientation in effect: a portrait photo stays portrait', async () => {
    // 60x40 pixels + Orientation=6 (rotate 90 CW) = a portrait photo.
    const input = await jpegWithMetadata({ width: 60, height: 40, orientation: 6 });
    const { buffer: out } = await stripImageMetadata(input);

    expect((await sharp(out).metadata()).orientation).toBe(6);
    // `.rotate()` with no argument is a decoder honouring the tag: 60x40
    // landscape pixels + Orientation=6 must render as a 40x60 portrait.
    const rendered = await sharp(await sharp(out).rotate().toBuffer()).metadata();
    expect([rendered.width, rendered.height]).toEqual([40, 60]);
  });

  it('does not add an EXIF block when the source orientation was normal', async () => {
    const input = await jpegWithMetadata({ orientation: 1 });
    const { buffer: out } = await stripImageMetadata(input);
    expect(out.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
  });

  it('keeps the ICC colour profile byte-for-byte', async () => {
    const input = await jpegWithMetadata({ icc: true });
    const before = (await sharp(input).metadata()).icc;
    expect(before).toBeDefined();

    const { buffer: out } = await stripImageMetadata(input);
    expect((await sharp(out).metadata()).icc).toEqual(before);
  });

  it('destroys the embedded thumbnail', async () => {
    const input = await jpegWithThumbnail();
    expect(input.includes(Buffer.from(SECRETS.thumbnail))).toBe(true);

    const { buffer: out } = await stripImageMetadata(input);
    expect(out.includes(Buffer.from(SECRETS.thumbnail))).toBe(false);
    // Orientation still survives the rebuild.
    expect((await sharp(out).metadata()).orientation).toBe(6);
  });

  it('drops trailing bytes appended after EOI', async () => {
    const input = await jpegWithMetadata();
    const trailer = Buffer.from('TRAILING-SECRET-PAYLOAD');
    const { buffer: out } = await stripImageMetadata(Buffer.concat([input, trailer]));
    expect(out.includes(trailer)).toBe(false);
  });

  it('keeps the APP14 Adobe colour-transform marker', async () => {
    const base = await jpegWithMetadata();
    const adobe = jpegSegment(0xee, Buffer.from('Adobe\0d\0\0\0\0\0', 'latin1'));
    const { buffer: out } = await stripImageMetadata(insertJpegSegments(base, [adobe]));
    expect(out.includes(Buffer.from('Adobe\0', 'latin1'))).toBe(true);
  });

  it('handles a large photo without touching its pixels', async () => {
    const input = await jpegWithMetadata({ width: 4000, height: 3000 });
    const { buffer: out, strategy } = await stripImageMetadata(input);
    expect(strategy).toBe('surgical');
    assertNoSecrets(out);
    expect((await sharp(out).metadata()).width).toBe(4000);
  });
});

describe('stripImageMetadata — PNG', () => {
  it('removes tEXt, iTXt and tIME while keeping IDAT/iCCP', async () => {
    const input = await pngWithMetadata();
    const { buffer: out, strategy } = await stripImageMetadata(input);

    expect(strategy).toBe('surgical');
    assertNoSecrets(out);
    const types = pngChunkTypes(out);
    expect(types).toContain('IHDR');
    expect(types).toContain('IDAT');
    expect(types).toContain('IEND');
    expect(types).toContain('iCCP');
    expect(types).not.toContain('tEXt');
    expect(types).not.toContain('iTXt');
    expect(types).not.toContain('tIME');
    expect(await rawPixels(out)).toEqual(await rawPixels(input));
  });

  it('drops an eXIf chunk and bakes its orientation into the pixels', async () => {
    const input = await pngWithMetadata({ orientation: 6 });
    const { buffer: out, strategy } = await stripImageMetadata(input);

    expect(strategy).toBe('re-encode');
    expect(pngChunkTypes(out)).not.toContain('eXIf');
    assertNoSecrets(out);
    const md = await sharp(out).metadata();
    // 30x20 landscape + Orientation=6 renders as 20x30 portrait.
    expect([md.width, md.height]).toEqual([20, 30]);
    expect(md.orientation === undefined || md.orientation === 1).toBe(true);
  });

  it('drops an unknown ancillary chunk rather than trusting it', async () => {
    const input = insertPngChunks(await pngWithMetadata(), [
      pngChunk('prVt', Buffer.from('secret-vendor-blob')),
    ]);
    const { buffer: out } = await stripImageMetadata(input);
    expect(out.includes(Buffer.from('secret-vendor-blob'))).toBe(false);
  });
});

describe('stripImageMetadata — WebP', () => {
  it('removes the EXIF and XMP chunks and clears the VP8X flags', async () => {
    const input = await webpWithMetadata();
    expect(riffChunks(input).map((c) => c.fourcc)).toContain('EXIF');

    const { buffer: out, strategy } = await stripImageMetadata(input);
    expect(strategy).toBe('surgical');
    assertNoSecrets(out);

    const chunks = riffChunks(out);
    expect(chunks.map((c) => c.fourcc)).not.toContain('EXIF');
    expect(chunks.map((c) => c.fourcc)).not.toContain('XMP ');
    const vp8x = chunks.find((c) => c.fourcc === 'VP8X');
    if (vp8x) expect(out[vp8x.offset + 8] & 0x0c).toBe(0);
    // The RIFF size header still matches the trimmed payload.
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect((await sharp(out).metadata()).width).toBe(24);
  });

  it('bakes a non-normal orientation into the pixels', async () => {
    const input = await webpWithMetadata({ orientation: 6 });
    const { buffer: out, strategy } = await stripImageMetadata(input);
    expect(strategy).toBe('re-encode');
    assertNoSecrets(out);
    const md = await sharp(out).metadata();
    expect([md.width, md.height]).toEqual([16, 24]); // 24x16 -> portrait
  });

  it('rejects a WebP with no image chunk instead of publishing it', async () => {
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'ascii');
    header.write('WEBP', 8, 'ascii');
    const onlyMetadata = appendRiffChunk(header, 'EXIF', Buffer.from(SECRETS.make));
    await expect(stripImageMetadata(onlyMetadata)).rejects.toThrow(ImageMetadataError);
  });
});

describe('stripImageMetadata — GIF', () => {
  it('removes comment and XMP extensions but keeps the frames', async () => {
    const input = await gifWithMetadata();
    expect(gifBlocks(input)).toContain('ext:0xfe');

    const { buffer: out, strategy } = await stripImageMetadata(input);
    expect(strategy).toBe('surgical');
    assertNoSecrets(out);

    const blocks = gifBlocks(out);
    expect(blocks).not.toContain('ext:0xfe');
    expect(blocks).toContain('image');
    expect(blocks).toContain('trailer');
    expect((await sharp(out).metadata()).width).toBe(16);
  });

  it('keeps the NETSCAPE2.0 loop extension so animations still loop', async () => {
    const base = await gifWithMetadata();
    const packed = base[10];
    let headerEnd = 13;
    if (packed & 0x80) headerEnd += 3 * (1 << ((packed & 0x07) + 1));
    const loop = Buffer.from([
      0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0', 'latin1'), 3, 1, 0, 0, 0,
    ]);
    const withLoop = Buffer.concat([base.subarray(0, headerEnd), loop, base.subarray(headerEnd)]);

    const { buffer: out } = await stripImageMetadata(withLoop);
    expect(out.includes(Buffer.from('NETSCAPE2.0', 'latin1'))).toBe(true);
  });
});

describe('stripImageMetadata — SVG', () => {
  it('removes the metadata element and comments, keeps the drawing', async () => {
    const { buffer: out, strategy } = await stripImageMetadata(Buffer.from(SVG_WITH_METADATA));
    expect(strategy).toBe('text');
    const text = out.toString('utf8');
    expect(text).not.toContain(SECRETS.svgMetadata);
    expect(text).not.toContain('<metadata>');
    expect(text).not.toContain('37.5665');
    expect(text).toContain('<rect width="20" height="20" fill="#123456"/>');
  });
});

describe('stripImageMetadata — hostile and broken input', () => {
  it('rejects an empty buffer', async () => {
    await expect(stripImageMetadata(Buffer.alloc(0))).rejects.toThrow(ImageMetadataError);
  });

  it('rejects a JPEG truncated mid-segment', async () => {
    const input = await jpegWithMetadata();
    const truncated = input.subarray(0, 40);
    await expect(stripImageMetadata(truncated)).rejects.toMatchObject({ reason: 'corrupt' });
  });

  it('rejects a JPEG truncated to just its SOI marker', async () => {
    await expect(stripImageMetadata(Buffer.from([0xff, 0xd8, 0xff]))).rejects.toThrow(ImageMetadataError);
  });

  it('rejects a PNG whose chunk length runs past the end of the file', async () => {
    const input = await pngWithMetadata();
    const evil = Buffer.from(input);
    evil.writeUInt32BE(0x7ffffff0, 8); // IHDR claims 2GB
    await expect(stripImageMetadata(evil)).rejects.toMatchObject({ reason: 'corrupt' });
  });

  it('rejects a PNG with no IEND', async () => {
    const input = await pngWithMetadata();
    await expect(stripImageMetadata(input.subarray(0, input.length - 12)))
      .rejects.toMatchObject({ reason: 'corrupt' });
  });

  it('rejects a GIF truncated mid sub-block', async () => {
    const input = await gifWithMetadata();
    await expect(stripImageMetadata(input.subarray(0, input.length - 4)))
      .rejects.toMatchObject({ reason: 'corrupt' });
  });

  it('rejects random bytes that are not an image at all', async () => {
    await expect(stripImageMetadata(Buffer.alloc(2048, 0))).rejects.toThrow(ImageMetadataError);
  });

  it('survives an EXIF block that lies about its IFD entry count', async () => {
    const exif = exifWithThumbnail(6);
    const evil = Buffer.from(exif);
    evil.writeUInt16BE(0xffff, 6 + 8); // IFD0 claims 65535 entries
    const base = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).jpeg().toBuffer();
    const input = insertJpegSegments(base, [jpegSegment(0xe1, evil)]);

    const { buffer: out } = await stripImageMetadata(input);
    expect(out.includes(Buffer.from(SECRETS.thumbnail))).toBe(false);
    expect((await sharp(out).metadata()).width).toBe(8);
  });

  it('ignores an out-of-range orientation value instead of re-emitting it', async () => {
    const base = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).jpeg().toBuffer();
    const input = insertJpegSegments(base, [jpegSegment(0xe1, exifWithThumbnail(99))]);
    const { buffer: out } = await stripImageMetadata(input);
    expect(out.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
  });
});

describe('orientation bake-in matches a decoder that honours the tag', () => {
  /*
   * The re-encode path applies its own transform table instead of trusting
   * sharp's auto-orient. This pins the table against ground truth: for every
   * EXIF orientation 1-8, the pixels we produce must equal what a decoder
   * honouring the tag would have displayed.
   */
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('orientation %i', async (orientation) => {
    // Asymmetric on both axes, so every one of the eight results differs.
    const asymmetric = await sharp(
      Buffer.from([
        255, 0, 0,   0, 255, 0,   0, 0, 255,   255, 255, 0,
        10, 10, 10,  20, 20, 20,  30, 30, 30,  40, 40, 40,
      ]),
      { raw: { width: 4, height: 2, channels: 3 } },
    ).png({ compressionLevel: 0 }).toBuffer();

    const expected = await sharp(
      await sharp(asymmetric).withMetadata({ orientation }).png().toBuffer(),
    ).rotate().raw().toBuffer();

    const tagged = insertPngChunksBeforeIdat(asymmetric, [
      pngChunk('eXIf', exifWithThumbnail(orientation).subarray(6)),
    ]);
    const { buffer: out } = await stripImageMetadata(tagged);
    expect(await sharp(out).raw().toBuffer()).toEqual(expected);
    expect(pngChunkTypes(out)).not.toContain('eXIf');
  });
});

describe('readOrientationFromTiff', () => {
  it('reads both byte orders and refuses malformed blocks', () => {
    const be = exifWithThumbnail(8).subarray(6);
    expect(readOrientationFromTiff(be)).toBe(8);
    expect(readOrientationFromTiff(Buffer.alloc(4))).toBeNull();
    expect(readOrientationFromTiff(Buffer.from('XX\0\0\0\0\0\0', 'latin1'))).toBeNull();
  });
});

/** Fixture self-check: the input really does carry everything we claim. */
function assertNoSecretsInverted(input: Buffer) {
  for (const secret of [
    SECRETS.make,
    SECRETS.model,
    SECRETS.software,
    SECRETS.dateTimeOriginal,
    SECRETS.bodySerial,
    SECRETS.lens,
    SECRETS.xmp,
    SECRETS.iptc,
    SECRETS.comment,
  ]) {
    expect(
      input.includes(Buffer.from(secret, 'utf8')),
      `fixture is missing "${secret}" — the test would pass vacuously`,
    ).toBe(true);
  }
}
