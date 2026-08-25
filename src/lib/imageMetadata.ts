import { logger } from '@/lib/logger';
import { loadSharp } from '@/lib/sharpModule';

const MODULE = 'lib/imageMetadata';

/**
 * Image metadata scrubbing for everything we publish to the CDN.
 *
 * WHY: a camera JPEG carries GPS coordinates, capture time to the second,
 * camera make/model, lens, body serial number, MakerNotes and an embedded
 * thumbnail (which survives cropping/redaction of the main image). Publishing
 * those alongside a pseudonymous post deanonymises the poster. The policy, the
 * evidence behind it and the field-by-field rationale live in
 * `docs/design/image-metadata-policy.md`.
 *
 * POLICY (short form):
 *   STRIP  GPS*, DateTimeOriginal/CreateDate/ModifyDate, Make/Model/LensModel/
 *          BodySerialNumber/SerialNumber, Software, MakerNotes, the embedded
 *          thumbnail, XMP and IPTC.
 *   KEEP   the ICC colour profile (wrong colours otherwise, not identifying)
 *          and the ORIENTATION *in effect* (see below).
 *
 * ORIENTATION is the one field where naive stripping breaks the product:
 * drop it and iPhone portrait photos render sideways. Two strategies, both
 * shipped by Signal:
 *   (A) bake the rotation into the pixels, then strip everything — needs a
 *       re-encode;
 *   (B) strip every other field in place and keep only the orientation tag —
 *       no pixel touch, no generation loss, no size increase.
 * We measured JPEG at 1.8-2x the bytes of HEIF at equal resolution, so a
 * blanket re-encode makes uploads *bigger*. (B) is therefore the default for
 * every container we can walk (JPEG/PNG/WebP/GIF) and (A) is the fallback for
 * containers we cannot walk, mirroring Signal-iOS's split.
 *
 * FAILS CLOSED: if the bytes cannot be cleaned they are not published. The
 * caller turns an ImageMetadataError into a 4xx/5xx rather than uploading the
 * original — "send it anyway with the metadata" is never an option.
 */

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'svg' | 'unknown';

/** How the bytes were cleaned. Surfaced for logging and for tests. */
export type StripStrategy =
  | 'surgical'   // (B) container walk, pixels untouched
  | 're-encode'  // (A) decode -> bake orientation -> encode, metadata gone
  | 'text';      // SVG: XML comment / metadata element removal

export interface StripResult {
  buffer: Buffer;
  format: ImageFormat;
  strategy: StripStrategy;
}

export type ImageMetadataFailure =
  | 'corrupt'      // the container does not parse — truncated or not an image
  | 'unsupported'; // we cannot clean this format on this machine

export class ImageMetadataError extends Error {
  readonly reason: ImageMetadataFailure;
  constructor(reason: ImageMetadataFailure, message: string) {
    super(message);
    this.name = 'ImageMetadataError';
    this.reason = reason;
  }
}

// Lazy-load sharp so this module doesn't blow up at import time if the native
// binary is missing on this platform (same pattern as the upload route).

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Format is decided by MAGIC BYTES, never by the client-declared MIME type or
 * the filename — a phone that mislabels a HEIC as `image/jpeg` is the reason
 * this route exists at all.
 */
export function sniffImageFormat(buf: Buffer): ImageFormat {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  if (buf.length >= 6) {
    const gif = buf.toString('ascii', 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
  }
  if (isSvg(buf)) return 'svg';
  return 'unknown';
}

function isSvg(buf: Buffer): boolean {
  // Look only at the head: an SVG may open with a BOM, an XML declaration,
  // a doctype or comments before the root element.
  const head = buf.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart();
  return head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!DOCTYPE svg');
}

/* ------------------------------------------------------------------ EXIF -- */

const TAG_ORIENTATION = 0x0112;
const EXIF_TYPE_SHORT = 3;

/**
 * Reads ONLY the orientation out of a raw TIFF/EXIF block. Deliberately not a
 * general EXIF parser: everything else in that block is being thrown away, so
 * there is nothing else worth decoding (and less parser to get wrong on
 * hostile input).
 */
export function readOrientationFromTiff(tiff: Buffer): number | null {
  if (tiff.length < 8) return null;
  const byteOrder = tiff.toString('ascii', 0, 2);
  const le = byteOrder === 'II';
  if (!le && byteOrder !== 'MM') return null;
  const u16 = (off: number) => (le ? tiff.readUInt16LE(off) : tiff.readUInt16BE(off));
  const u32 = (off: number) => (le ? tiff.readUInt32LE(off) : tiff.readUInt32BE(off));
  if (u16(2) !== 42) return null;
  const ifd0 = u32(4);
  if (ifd0 < 8 || ifd0 + 2 > tiff.length) return null;
  const entries = u16(ifd0);
  // A hostile file can claim 65535 entries; the bounds check below stops us
  // walking off the end, and there is no allocation per entry.
  for (let i = 0; i < entries; i++) {
    const off = ifd0 + 2 + i * 12;
    if (off + 12 > tiff.length) return null;
    if (u16(off) !== TAG_ORIENTATION) continue;
    if (u16(off + 2) !== EXIF_TYPE_SHORT) return null;
    const value = u16(off + 8);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');

/**
 * A complete APP1/EXIF segment carrying exactly one tag: Orientation. IFD1 is
 * absent, so the rebuilt block cannot carry an embedded thumbnail.
 */
export function buildOrientationExifSegment(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'ascii');       // big-endian
  tiff.writeUInt16BE(42, 2);          // TIFF magic
  tiff.writeUInt32BE(8, 4);           // offset of IFD0
  tiff.writeUInt16BE(1, 8);           // IFD0 entry count
  tiff.writeUInt16BE(TAG_ORIENTATION, 10);
  tiff.writeUInt16BE(EXIF_TYPE_SHORT, 12);
  tiff.writeUInt32BE(1, 14);          // component count
  tiff.writeUInt16BE(orientation, 18); // SHORT value sits in the first half
  tiff.writeUInt32BE(0, 22);          // no IFD1 -> no thumbnail
  const payload = Buffer.concat([EXIF_HEADER, tiff]);
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = 0xe1;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/* ------------------------------------------------------------------ JPEG -- */

function startsWith(payload: Buffer, marker: string): boolean {
  return payload.length >= marker.length && payload.toString('latin1', 0, marker.length) === marker;
}

/**
 * Walks the JPEG marker segments and rebuilds the file from an allowlist.
 * Everything the policy strips lives in APP segments or COM, so the entropy-
 * coded image data is copied byte for byte: no re-encode, no generation loss,
 * no size increase.
 */
function stripJpeg(buf: Buffer): { buffer: Buffer; orientation: number | null } {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new ImageMetadataError('corrupt', 'JPEG does not start with SOI');
  }
  const kept: Buffer[] = [];
  let orientation: number | null = null;
  let sawScan = false;
  let sawEoi = false;
  let i = 2;

  while (i < buf.length) {
    if (buf[i] !== 0xff) {
      throw new ImageMetadataError('corrupt', `expected a JPEG marker at offset ${i}`);
    }
    // 0xFF fill bytes are legal padding before a marker.
    let m = i + 1;
    while (m < buf.length && buf[m] === 0xff) m++;
    if (m >= buf.length) throw new ImageMetadataError('corrupt', 'JPEG ends mid-marker');
    const marker = buf[m];

    if (marker === 0xd9) {            // EOI — anything after it is trailer junk
      kept.push(Buffer.from([0xff, 0xd9]));
      sawEoi = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // TEM / RSTn
      kept.push(Buffer.from([0xff, marker]));
      i = m + 1;
      continue;
    }
    if (m + 3 > buf.length) throw new ImageMetadataError('corrupt', 'JPEG ends mid-segment header');
    const length = buf.readUInt16BE(m + 1);
    if (length < 2) throw new ImageMetadataError('corrupt', 'JPEG segment length below minimum');
    const end = m + 1 + length;
    if (end > buf.length) throw new ImageMetadataError('corrupt', 'JPEG segment runs past end of file');
    const segment = buf.subarray(m - 1, end);
    const payload = buf.subarray(m + 3, end);

    if (marker === 0xe1) {
      // APP1: EXIF (GPS, timestamps, camera, MakerNotes, IFD1 thumbnail) or
      // XMP / extended XMP. Dropped whole; orientation is re-emitted below.
      if (startsWith(payload, 'Exif\0\0')) {
        orientation ??= readOrientationFromTiff(payload.subarray(6));
      }
    } else if (marker === 0xe0) {
      // APP0: keep the JFIF/JFXX density block, drop anything else squatting
      // on APP0. JFXX can hold a thumbnail, so it goes.
      if (startsWith(payload, 'JFIF\0')) kept.push(segment);
    } else if (marker === 0xe2) {
      // APP2: the ICC profile stays (colour), MPF goes (it indexes embedded
      // secondary images, i.e. more thumbnails).
      if (startsWith(payload, 'ICC_PROFILE\0')) kept.push(segment);
    } else if (marker === 0xee) {
      // APP14 "Adobe": carries the colour transform. Dropping it breaks
      // YCCK/CMYK JPEGs, and it says nothing about the photographer.
      if (startsWith(payload, 'Adobe')) kept.push(segment);
    } else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      // Every other APPn (IPTC/Photoshop APP13, MakerNote-bearing APP4-APP11,
      // Ducky, …) and COM comments: dropped.
    } else {
      kept.push(segment);
      if (marker === 0xda) {
        // SOS: copy the entropy-coded data verbatim up to the next real
        // marker (0xFF00 is a stuffed byte, RSTn are in-stream restarts).
        sawScan = true;
        let p = end;
        while (p < buf.length) {
          if (buf[p] !== 0xff) { p++; continue; }
          const next = buf[p + 1];
          if (next === undefined) { p++; break; }
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { p += 2; continue; }
          if (next === 0xff) { p += 1; continue; }
          break;
        }
        kept.push(buf.subarray(end, p));
        i = p;
        continue;
      }
    }
    i = end;
  }

  if (!sawScan) throw new ImageMetadataError('corrupt', 'JPEG has no scan data');
  if (!sawEoi) {
    // Truncated tail. The pixels we have are still renderable and the metadata
    // is still gone, so this is not worth refusing an upload over.
    logger.warn(MODULE, 'JPEG had no EOI marker; keeping the bytes we could parse');
  }
  const head: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (orientation !== null && orientation !== 1) head.push(buildOrientationExifSegment(orientation));
  return { buffer: Buffer.concat([...head, ...kept]), orientation };
}

/* ------------------------------------------------------------------- PNG -- */

/*
 * Chunk allowlist, mirroring Signal-iOS's `pngChunkTypesToKeep`: the critical
 * chunks, the ones that change how the pixels are rendered, and the APNG
 * animation chunks. Absent on purpose: `eXIf` (full EXIF, GPS included),
 * `tEXt`/`iTXt`/`zTXt` (arbitrary text, where XMP and author names live) and
 * `tIME` (last-modification timestamp).
 */
const PNG_KEEP_CHUNKS = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND',
  'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sRGB', 'bKGD', 'pHYs', 'sPLT',
  'acTL', 'fcTL', 'fdAT',
]);

function stripPng(buf: Buffer): { buffer: Buffer; orientation: number | null } {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ImageMetadataError('corrupt', 'not a PNG');
  }
  const kept: Buffer[] = [buf.subarray(0, 8)];
  let orientation: number | null = null;
  let sawIhdr = false;
  let sawIend = false;
  let i = 8;

  while (i + 8 <= buf.length) {
    const length = buf.readUInt32BE(i);
    if (length > 0x7fffffff) throw new ImageMetadataError('corrupt', 'PNG chunk length out of range');
    const type = buf.toString('ascii', i + 4, i + 8);
    const end = i + 12 + length; // length + type + data + CRC
    if (end > buf.length) throw new ImageMetadataError('corrupt', 'PNG chunk runs past end of file');
    if (type === 'eXIf') {
      orientation ??= readOrientationFromTiff(buf.subarray(i + 8, i + 8 + length));
    } else if (PNG_KEEP_CHUNKS.has(type)) {
      kept.push(buf.subarray(i, end));
    }
    if (type === 'IHDR') sawIhdr = true;
    if (type === 'IEND') { sawIend = true; i = end; break; }
    i = end;
  }
  if (!sawIhdr) throw new ImageMetadataError('corrupt', 'PNG has no IHDR');
  if (!sawIend) throw new ImageMetadataError('corrupt', 'PNG has no IEND');
  return { buffer: Buffer.concat(kept), orientation };
}

/* ------------------------------------------------------------------ WebP -- */

const WEBP_KEEP_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
const VP8X_FLAG_EXIF = 0x08;
const VP8X_FLAG_XMP = 0x04;

function stripWebp(buf: Buffer): { buffer: Buffer; orientation: number | null } {
  if (
    buf.length < 12 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new ImageMetadataError('corrupt', 'not a WebP');
  }
  const kept: Buffer[] = [];
  let orientation: number | null = null;
  let sawImage = false;
  let i = 12;

  while (i + 8 <= buf.length) {
    const fourcc = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (size > 0x7fffffff) throw new ImageMetadataError('corrupt', 'WebP chunk size out of range');
    const dataEnd = i + 8 + size;
    if (dataEnd > buf.length) throw new ImageMetadataError('corrupt', 'WebP chunk runs past end of file');
    const paddedEnd = dataEnd + (size % 2); // RIFF chunks are word-aligned
    if (fourcc === 'EXIF') {
      const data = buf.subarray(i + 8, dataEnd);
      const tiff = startsWith(data, 'Exif\0\0') ? data.subarray(6) : data;
      orientation ??= readOrientationFromTiff(tiff);
    } else if (WEBP_KEEP_CHUNKS.has(fourcc)) {
      const chunk = Buffer.from(buf.subarray(i, Math.min(paddedEnd, buf.length)));
      if (fourcc === 'VP8X' && chunk.length > 8) {
        // The VP8X feature flags advertise EXIF/XMP chunks we just removed;
        // leaving the bits set makes the file self-inconsistent.
        chunk[8] &= ~(VP8X_FLAG_EXIF | VP8X_FLAG_XMP);
      }
      if (fourcc !== 'VP8X' && fourcc !== 'ICCP') sawImage = true;
      kept.push(chunk);
    }
    i = paddedEnd;
  }
  if (!sawImage) throw new ImageMetadataError('corrupt', 'WebP has no image data');
  const body = Buffer.concat(kept);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + body.length, 4); // 'WEBP' + payload
  header.write('WEBP', 8, 'ascii');
  return { buffer: Buffer.concat([header, body]), orientation };
}

/* ------------------------------------------------------------------- GIF -- */

/*
 * GIF carries no EXIF: the metadata surfaces are the comment extension and
 * application extensions (XMP ships as one). We keep the two application
 * extensions that drive looping, and the graphic-control extensions that drive
 * animation timing.
 */
const GIF_KEEP_APP_IDS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);

function skipSubBlocks(buf: Buffer, from: number): number {
  let p = from;
  for (;;) {
    if (p >= buf.length) throw new ImageMetadataError('corrupt', 'GIF ends mid sub-block');
    const size = buf[p];
    if (size === 0) return p + 1;
    p += 1 + size;
  }
}

function stripGif(buf: Buffer): Buffer {
  if (buf.length < 13) throw new ImageMetadataError('corrupt', 'GIF too short');
  const packed = buf[10];
  let i = 13;
  if (packed & 0x80) i += 3 * (1 << ((packed & 0x07) + 1)); // global colour table
  if (i > buf.length) throw new ImageMetadataError('corrupt', 'GIF colour table runs past end of file');
  const kept: Buffer[] = [buf.subarray(0, i)];
  let sawTrailer = false;

  while (i < buf.length) {
    const introducer = buf[i];
    if (introducer === 0x3b) { // trailer
      kept.push(Buffer.from([0x3b]));
      sawTrailer = true;
      break;
    }
    if (introducer === 0x21) { // extension
      if (i + 2 > buf.length) throw new ImageMetadataError('corrupt', 'GIF ends mid-extension');
      const label = buf[i + 1];
      const dataStart = i + 2;
      const end = skipSubBlocks(buf, dataStart);
      const isLoopExtension =
        label === 0xff &&
        dataStart < buf.length &&
        buf[dataStart] === 11 &&
        GIF_KEEP_APP_IDS.has(buf.toString('ascii', dataStart + 1, dataStart + 12));
      // 0xF9 graphic control = frame timing/transparency, must stay.
      if (label === 0xf9 || isLoopExtension) kept.push(buf.subarray(i, end));
      i = end;
      continue;
    }
    if (introducer === 0x2c) { // image descriptor
      if (i + 10 > buf.length) throw new ImageMetadataError('corrupt', 'GIF ends mid image descriptor');
      const localPacked = buf[i + 9];
      let p = i + 10;
      if (localPacked & 0x80) p += 3 * (1 << ((localPacked & 0x07) + 1)); // local colour table
      p += 1; // LZW minimum code size
      if (p > buf.length) throw new ImageMetadataError('corrupt', 'GIF image data runs past end of file');
      const end = skipSubBlocks(buf, p);
      kept.push(buf.subarray(i, end));
      i = end;
      continue;
    }
    throw new ImageMetadataError('corrupt', `unexpected GIF block 0x${introducer.toString(16)}`);
  }
  if (!sawTrailer) throw new ImageMetadataError('corrupt', 'GIF has no trailer');
  return Buffer.concat(kept);
}

/* ------------------------------------------------------------------- SVG -- */

/*
 * SVG has no EXIF container; its metadata is XML — `<metadata>` elements
 * (RDF/Inkscape/Adobe authorship), XMP packets and comments. We remove those
 * textually and leave the drawing alone.
 */
function stripSvg(buf: Buffer): Buffer {
  const text = buf.toString('utf8');
  const cleaned = text
    .replace(/<\?xpacket[\s\S]*?\?>/gi, '')
    .replace(/<metadata\b[\s\S]*?<\/metadata\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  return Buffer.from(cleaned, 'utf8');
}

/* -------------------------------------------------------------- re-encode -- */

/**
 * The pixel transform that makes each EXIF orientation render upright.
 * The rotation runs first and the mirror second, which is what makes 5 and 7
 * (the two diagonal reflections) expressible. The table is pinned against
 * sharp's own auto-orient for all eight values in `imageMetadata.test.ts` —
 * do not adjust it by reasoning alone, the axis conventions are unintuitive.
 *
 * We apply this ourselves instead of leaning on sharp's auto-orient, because
 * auto-orient only fires when libvips itself found the tag — and it does not,
 * for instance, read a PNG `eXIf` chunk that sits after `IDAT`. Deriving the
 * transform from the orientation we parsed keeps the two in step.
 */
const ORIENTATION_TRANSFORMS: Record<number, { rotate: number; flip?: boolean; flop?: boolean }> = {
  1: { rotate: 0 },
  2: { rotate: 0, flop: true },
  3: { rotate: 180 },
  4: { rotate: 0, flip: true },
  5: { rotate: 90, flip: true },
  6: { rotate: 90 },
  7: { rotate: 270, flip: true },
  8: { rotate: 270 },
};

/**
 * Strategy (A): decode, bake the EXIF orientation into the pixels, re-encode.
 * sharp drops all metadata on write unless asked to keep it, so this destroys
 * the metadata by construction; we ask for the ICC profile back explicitly.
 */
async function reencode(buf: Buffer, orientation: number | null): Promise<Buffer> {
  const sharp = loadSharp();
  if (!sharp) {
    throw new ImageMetadataError('unsupported', 'sharp is unavailable, cannot clean this image');
  }
  try {
    let pipeline = sharp(buf, { failOn: 'error' });
    const transform = orientation === null ? null : ORIENTATION_TRANSFORMS[orientation];
    if (transform) {
      if (transform.rotate !== 0) pipeline = pipeline.rotate(transform.rotate);
      if (transform.flip) pipeline = pipeline.flip();
      if (transform.flop) pipeline = pipeline.flop();
    } else {
      // Orientation unknown (unparsed container): let libvips auto-orient from
      // whatever tag it can find. `.rotate()` with no argument does exactly that.
      pipeline = pipeline.rotate();
    }
    return Buffer.from(await pipeline.keepIccProfile().toBuffer());
  } catch (err) {
    throw new ImageMetadataError(
      'corrupt',
      `re-encode failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Exported for the test that pins the table against sharp's own auto-orient. */
export const __orientationTransforms = ORIENTATION_TRANSFORMS;

/* ------------------------------------------------------------------- API -- */

/**
 * Removes every privacy-relevant metadata field from an image, keeping the ICC
 * profile and the orientation *in effect*.
 *
 * Throws `ImageMetadataError` rather than returning the input when the bytes
 * cannot be cleaned — callers must fail the upload, never publish the original.
 */
export async function stripImageMetadata(input: Buffer): Promise<StripResult> {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new ImageMetadataError('corrupt', 'empty image buffer');
  }
  const format = sniffImageFormat(input);

  switch (format) {
    case 'jpeg': {
      // Orientation rides along as a rebuilt one-tag EXIF block, so no re-encode.
      const { buffer } = stripJpeg(input);
      return { buffer, format, strategy: 'surgical' };
    }
    case 'png':
    case 'webp': {
      const { buffer, orientation } = format === 'png' ? stripPng(input) : stripWebp(input);
      if (orientation !== null && orientation !== 1) {
        /*
         * PNG's `eXIf` and WebP's `EXIF` chunk are the only place those two
         * formats can store orientation, and both are on the strip list — so
         * here, and only here, we fall back to strategy (A) and bake the
         * rotation into the pixels. Cameras effectively never produce these,
         * so the re-encode cost is not paid on the normal path.
         */
        const baked = await reencode(input, orientation);
        return { buffer: baked, format, strategy: 're-encode' };
      }
      return { buffer, format, strategy: 'surgical' };
    }
    case 'gif':
      return { buffer: stripGif(input), format, strategy: 'surgical' };
    case 'svg':
      return { buffer: stripSvg(input), format, strategy: 'text' };
    case 'unknown':
    default: {
      // AVIF/TIFF/BMP/HEIC-that-slipped-through and anything else: we cannot
      // walk the container, so we re-encode. If that fails the bytes were not
      // a decodable image and the upload is refused.
      const buffer = await reencode(input, null);
      return { buffer, format: 'unknown', strategy: 're-encode' };
    }
  }
}
