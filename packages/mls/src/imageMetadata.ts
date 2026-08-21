/**
 * Image metadata scrubbing for E2EE CHAT attachments — ON THE CLIENT.
 *
 * WHY IT CANNOT LIVE ON THE SERVER: a chat attachment is encrypted under the
 * topic's TAK before it leaves the device, and the server stores opaque
 * ciphertext. There is no longer anything on the far end that may look at the
 * pixels, so the strip has to happen at the last point where the plaintext
 * exists — inside `sendEncryptedChatMedia`, immediately before `seal`.
 *
 * POLICY is the same one the plaintext upload route applies in
 * `src/lib/imageMetadata.ts`, and the evidence behind it is in
 * `docs/design/image-metadata-policy.md`. Short form:
 *
 *   STRIP  GPS*, DateTimeOriginal/CreateDate/ModifyDate, Make/Model/LensModel/
 *          BodySerialNumber/SerialNumber, Software, MakerNotes, the embedded
 *          thumbnail, XMP and IPTC.
 *   KEEP   the ICC colour profile (wrong colours otherwise, not identifying)
 *          and the ORIENTATION *in effect* (an iPhone portrait photo renders
 *          sideways without it).
 *
 * ── How this differs from the server copy, and why ──────────────────────────
 *
 * The two agree on WHAT "stripped" means. They differ only in MECHANISM,
 * because the mechanisms available differ:
 *
 *   server (`src/lib/imageMetadata.ts`)     this file
 *   ───────────────────────────────────     ─────────────────────────────────
 *   sharp/libvips is available              nothing is: no sharp in a browser,
 *                                           no canvas in React Native
 *   JPEG/PNG/WebP/GIF: container walk       identical container walk, ported
 *                                           to Uint8Array
 *   PNG/WebP with a non-normal orientation: re-emits a one-tag orientation
 *   decode, bake rotation, re-encode        chunk instead — see below
 *   unknown container: re-encode            refuses (fails closed)
 *   SVG: textual strip                      unreachable; SVG is not in
 *                                           `CHAT_MEDIA_MIME_ALLOWLIST`
 *
 * The PNG/WebP divergence is worth stating plainly. Baking the rotation into
 * the pixels needs a decoder, and this code has none. Re-emitting a rebuilt
 * `eXIf`/`EXIF` chunk carrying ONLY `TIFF:Orientation` reaches the same place
 * by the other road Signal-iOS uses: everything else in the block — GPS,
 * capture time, camera, MakerNotes, and IFD1 with its embedded thumbnail — is
 * discarded, and what the recipient's decoder does with the tag is exactly
 * what the sender's decoder did with it. That is strictly better than dropping
 * it (which rotates portrait photos) and strictly better than a re-encode we
 * cannot perform anyway.
 *
 * ── Why this file has no dependencies ───────────────────────────────────────
 *
 * It is compiled by Next, by Metro and by tsc, exactly like `chatMedia.ts`. So:
 * no `Buffer`, no `require`, no npm package, no native module. Everything is
 * `Uint8Array` and arithmetic, which is also why the mini-app needs no new
 * native dependency for any of this. `chatMediaMetadataStrip.test.ts` runs the
 * suite with `globalThis.Buffer` deleted so a Node-only helper cannot creep in
 * and then explode under Hermes.
 *
 * FAILS CLOSED. A container that cannot be walked throws, and
 * `sendEncryptedChatMedia` turns that into a refusal. Sending the original
 * because the cleaner did not understand it is the one outcome that is never
 * on offer — that is the pre-2018 Signal-Android bug, where an image small
 * enough to skip the scaler kept its GPS for years.
 *
 * NAME CLASH, worth knowing about: the web app also has a
 * `stripImageMetadata`/`ImageMetadataError` pair — the sharp-backed one in
 * `src/lib/imageMetadata.ts`, which is async, takes a `Buffer` and runs only
 * on the server. A file importing both must alias one of them (see
 * `src/__tests__/chatMediaMetadataStrip.test.ts`, which imports the client one
 * by module path and the server one as `stripOnServer`). Anywhere else, take
 * whichever one can run where the code runs: a browser or a phone can only
 * ever use this one.
 */

/** Containers this can clean. Everything else is refused. */
export type StrippedImageFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'bmp' | 'unknown';

/** How the bytes were cleaned. Surfaced for logging and for the tests. */
export type StripStrategy =
  /** Container walk: metadata dropped, pixel data copied byte for byte. */
  | 'surgical'
  /** BMP: no metadata container exists, only a trailing-junk trim. */
  | 'passthrough';

export interface StripResult {
  bytes: Uint8Array;
  format: StrippedImageFormat;
  strategy: StripStrategy;
  /** The orientation carried over, or null when there was none to carry. */
  orientation: number | null;
}

export type ImageMetadataFailure =
  /** The container does not parse — truncated, or not the image it claims. */
  | 'corrupt'
  /** A container we cannot walk, and we have no decoder to fall back on. */
  | 'unsupported';

export class ImageMetadataError extends Error {
  readonly reason: ImageMetadataFailure;
  constructor(reason: ImageMetadataFailure, message: string) {
    super(message);
    this.name = 'ImageMetadataError';
    this.reason = reason;
  }
}

/* --------------------------------------------------------------- helpers -- */

function ascii(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function u16be(b: Uint8Array, off: number): number {
  return (b[off] << 8) | b[off + 1];
}

function u16le(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}

function u32be(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

function u32le(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

/**
 * One allocation and a copy per part.
 *
 * Deliberately not `new Uint8Array([...a, ...b])` or `Array.prototype.concat`:
 * a 9.5MB attachment spread into an argument list is a stack overflow, and it
 * is the largest input this code ever sees rather than an exotic one.
 */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function startsWith(payload: Uint8Array, marker: string): boolean {
  return payload.length >= marker.length && ascii(payload, 0, marker.length) === marker;
}

/* ------------------------------------------------------------------ sniff -- */

/**
 * Format is decided by MAGIC BYTES, never by the declared type or the
 * filename. A phone that hands the picker a HEIC under a `.jpg` name is the
 * ordinary case, not the attack — and an attachment whose declared type and
 * real type disagree must be cleaned as what it IS.
 */
export function sniffImageFormat(b: Uint8Array): StrippedImageFormat {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return 'png';
  }
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 6) {
    const gif = ascii(b, 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return 'unknown';
}

/* ------------------------------------------------------------------ EXIF -- */

const TAG_ORIENTATION = 0x0112;
const EXIF_TYPE_SHORT = 3;

/**
 * Reads ONLY the orientation out of a raw TIFF/EXIF block. Deliberately not a
 * general EXIF parser: everything else in that block is being thrown away, so
 * there is nothing else worth decoding — and less parser to get wrong on
 * hostile input, which matters more here than on the server because these
 * bytes arrive from a picker on the sender's own device and are parsed before
 * anything has authenticated them.
 */
export function readOrientationFromTiff(tiff: Uint8Array): number | null {
  if (tiff.length < 8) return null;
  const byteOrder = ascii(tiff, 0, 2);
  const le = byteOrder === 'II';
  if (!le && byteOrder !== 'MM') return null;
  const r16 = (off: number) => (le ? u16le(tiff, off) : u16be(tiff, off));
  const r32 = (off: number) => (le ? u32le(tiff, off) : u32be(tiff, off));
  if (r16(2) !== 42) return null;
  const ifd0 = r32(4);
  if (ifd0 < 8 || ifd0 + 2 > tiff.length) return null;
  const entries = r16(ifd0);
  // A hostile file can claim 65535 entries; the bounds check below stops the
  // walk at the end of the buffer, and nothing is allocated per entry.
  for (let i = 0; i < entries; i++) {
    const off = ifd0 + 2 + i * 12;
    if (off + 12 > tiff.length) return null;
    if (r16(off) !== TAG_ORIENTATION) continue;
    if (r16(off + 2) !== EXIF_TYPE_SHORT) return null;
    const value = r16(off + 8);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

/**
 * A TIFF block carrying exactly one tag: Orientation. IFD1 is absent, so the
 * rebuilt block CANNOT carry an embedded thumbnail — the field whose failure
 * mode is nastiest, because it is not regenerated when the main image is
 * cropped or redacted and therefore leaks the region that was removed.
 */
export function buildOrientationTiff(orientation: number): Uint8Array {
  const tiff = new Uint8Array(26);
  const view = new DataView(tiff.buffer);
  tiff[0] = 0x4d; tiff[1] = 0x4d;       // 'MM' — big-endian
  view.setUint16(2, 42);                // TIFF magic
  view.setUint32(4, 8);                 // offset of IFD0
  view.setUint16(8, 1);                 // IFD0 entry count
  view.setUint16(10, TAG_ORIENTATION);
  view.setUint16(12, EXIF_TYPE_SHORT);
  view.setUint32(14, 1);                // component count
  view.setUint16(18, orientation);      // SHORT value sits in the first half
  view.setUint32(22, 0);                // no IFD1 -> no thumbnail
  return tiff;
}

/** The same block as a complete JPEG APP1 segment. */
export function buildOrientationExifSegment(orientation: number): Uint8Array {
  const tiff = buildOrientationTiff(orientation);
  const out = new Uint8Array(4 + 6 + tiff.length);
  out[0] = 0xff;
  out[1] = 0xe1;
  out[2] = ((6 + tiff.length + 2) >> 8) & 0xff;
  out[3] = (6 + tiff.length + 2) & 0xff;
  out.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4); // 'Exif\0\0'
  out.set(tiff, 10);
  return out;
}

/* ------------------------------------------------------------------ JPEG -- */

/**
 * Walks the JPEG marker segments and rebuilds the file from an allowlist.
 * Everything the policy strips lives in an APP segment or in COM, so the
 * entropy-coded image data is copied byte for byte: no re-encode, no
 * generation loss, no size increase. That last point is the reason this is not
 * simply "decode and re-encode" — we measured JPEG at 1.8-2x the bytes of HEIF
 * at equal resolution, and an attachment path has a hard size cap.
 */
function stripJpeg(buf: Uint8Array): { bytes: Uint8Array; orientation: number | null } {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new ImageMetadataError('corrupt', 'JPEG does not start with SOI');
  }
  const kept: Uint8Array[] = [];
  let orientation: number | null = null;
  let sawScan = false;
  let i = 2;

  while (i < buf.length) {
    if (buf[i] !== 0xff) {
      throw new ImageMetadataError('corrupt', 'expected a JPEG marker at offset ' + i);
    }
    // 0xFF fill bytes are legal padding before a marker.
    let m = i + 1;
    while (m < buf.length && buf[m] === 0xff) m++;
    if (m >= buf.length) throw new ImageMetadataError('corrupt', 'JPEG ends mid-marker');
    const marker = buf[m];

    if (marker === 0xd9) {            // EOI — anything after it is trailer junk
      kept.push(new Uint8Array([0xff, 0xd9]));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // TEM / RSTn
      kept.push(new Uint8Array([0xff, marker]));
      i = m + 1;
      continue;
    }
    if (m + 3 > buf.length) throw new ImageMetadataError('corrupt', 'JPEG ends mid-segment header');
    const length = u16be(buf, m + 1);
    if (length < 2) throw new ImageMetadataError('corrupt', 'JPEG segment length below minimum');
    const end = m + 1 + length;
    if (end > buf.length) throw new ImageMetadataError('corrupt', 'JPEG segment runs past end of file');
    const segment = buf.subarray(m - 1, end);
    const payload = buf.subarray(m + 3, end);

    if (marker === 0xe1) {
      // APP1: EXIF (GPS, timestamps, camera, MakerNotes, the IFD1 thumbnail)
      // or XMP / extended XMP. Dropped whole; orientation is re-emitted below.
      if (startsWith(payload, 'Exif\0\0')) {
        if (orientation === null) orientation = readOrientationFromTiff(payload.subarray(6));
      }
    } else if (marker === 0xe0) {
      // APP0: keep the JFIF density block, drop anything else squatting on
      // APP0. JFXX can hold a thumbnail, so it goes.
      if (startsWith(payload, 'JFIF\0')) kept.push(segment);
    } else if (marker === 0xe2) {
      // APP2: the ICC profile stays (colour), MPF goes — it indexes embedded
      // secondary images, which is to say more thumbnails.
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
          const next = p + 1 < buf.length ? buf[p + 1] : -1;
          if (next === -1) { p++; break; }
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
  // A missing EOI is a truncated tail. The pixels we have are still renderable
  // and the metadata is still gone, so it is not worth refusing a send over —
  // the server copy logs a warning here and this one has no logger.
  const head: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  if (orientation !== null && orientation !== 1) head.push(buildOrientationExifSegment(orientation));
  return { bytes: concat(head.concat(kept)), orientation };
}

/* ------------------------------------------------------------------- PNG -- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Assembles one PNG chunk, CRC included. Needed to re-emit `eXIf`. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/*
 * Chunk allowlist, mirroring Signal-iOS's `pngChunkTypesToKeep`: the critical
 * chunks, the ones that change how the pixels are rendered, and the APNG
 * animation chunks. Absent on purpose: `eXIf` (full EXIF, GPS included),
 * `tEXt`/`iTXt`/`zTXt` (arbitrary text, where XMP and author names live) and
 * `tIME` (last-modification timestamp — Signal drops that one too).
 */
const PNG_KEEP_CHUNKS = [
  'IHDR', 'PLTE', 'IDAT', 'IEND',
  'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sRGB', 'bKGD', 'pHYs', 'sPLT',
  'acTL', 'fcTL', 'fdAT',
];

function stripPng(buf: Uint8Array): { bytes: Uint8Array; orientation: number | null } {
  const kept: Uint8Array[] = [buf.subarray(0, 8)];
  let orientation: number | null = null;
  let exifSlot = -1;
  let sawIhdr = false;
  let sawIend = false;
  let i = 8;

  while (i + 8 <= buf.length) {
    const length = u32be(buf, i);
    if (length > 0x7fffffff) throw new ImageMetadataError('corrupt', 'PNG chunk length out of range');
    const type = ascii(buf, i + 4, i + 8);
    const end = i + 12 + length; // length + type + data + CRC
    if (end > buf.length) throw new ImageMetadataError('corrupt', 'PNG chunk runs past end of file');
    if (type === 'eXIf') {
      if (orientation === null) orientation = readOrientationFromTiff(buf.subarray(i + 8, i + 8 + length));
    } else if (PNG_KEEP_CHUNKS.indexOf(type) !== -1) {
      kept.push(buf.subarray(i, end));
      if (type === 'IHDR') {
        sawIhdr = true;
        // Placeholder: the rebuilt `eXIf` goes here, right after IHDR, which
        // is where real encoders put it and the only position libvips will
        // auto-orient from. Its index is remembered rather than assumed — a
        // malformed file can put a chunk before IHDR.
        exifSlot = kept.length;
        kept.push(new Uint8Array(0));
      }
    }
    if (type === 'IEND') { sawIend = true; break; }
    i = end;
  }
  if (!sawIhdr) throw new ImageMetadataError('corrupt', 'PNG has no IHDR');
  if (!sawIend) throw new ImageMetadataError('corrupt', 'PNG has no IEND');
  if (orientation !== null && orientation !== 1 && exifSlot !== -1) {
    kept[exifSlot] = pngChunk('eXIf', buildOrientationTiff(orientation));
  }
  return { bytes: concat(kept), orientation };
}

/* ------------------------------------------------------------------ WebP -- */

const WEBP_KEEP_CHUNKS = ['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP'];
const VP8X_FLAG_EXIF = 0x08;
const VP8X_FLAG_XMP = 0x04;

function stripWebp(buf: Uint8Array): { bytes: Uint8Array; orientation: number | null } {
  const kept: Uint8Array[] = [];
  let vp8x: Uint8Array | null = null;
  let orientation: number | null = null;
  let sawImage = false;
  let i = 12;

  while (i + 8 <= buf.length) {
    const fourcc = ascii(buf, i, i + 4);
    const size = u32le(buf, i + 4);
    if (size > 0x7fffffff) throw new ImageMetadataError('corrupt', 'WebP chunk size out of range');
    const dataEnd = i + 8 + size;
    if (dataEnd > buf.length) throw new ImageMetadataError('corrupt', 'WebP chunk runs past end of file');
    const paddedEnd = dataEnd + (size % 2); // RIFF chunks are word-aligned
    if (fourcc === 'EXIF') {
      const data = buf.subarray(i + 8, dataEnd);
      // libwebp writes the raw TIFF block; some writers prefix it like JPEG.
      const tiff = startsWith(data, 'Exif\0\0') ? data.subarray(6) : data;
      if (orientation === null) orientation = readOrientationFromTiff(tiff);
    } else if (WEBP_KEEP_CHUNKS.indexOf(fourcc) !== -1) {
      /*
       * A copy only for VP8X, whose flag byte is rewritten below — everything
       * else is a view, so the image data is copied once (in `concat`) rather
       * than twice.
       *
       * `new Uint8Array(view)` rather than `.slice()`: on a Node `Buffer` —
       * which is a Uint8Array, and which is what the server-side tests hand in
       * — `.slice()` is `.subarray()`, a VIEW, so the flag rewrite would edit
       * the caller's input. This copies under both.
       */
      const view = buf.subarray(i, Math.min(paddedEnd, buf.length));
      const chunk = fourcc === 'VP8X' ? new Uint8Array(view) : view;
      if (fourcc === 'VP8X' && chunk.length > 8) {
        // The VP8X feature flags advertise the EXIF/XMP chunks just removed.
        // XMP is gone for good; the EXIF bit is restored below IF a rebuilt
        // orientation-only chunk is re-emitted, and left clear otherwise —
        // a flag pointing at a chunk that is not there makes the file
        // self-inconsistent, which some decoders treat as a hard error.
        chunk[8] &= ~(VP8X_FLAG_EXIF | VP8X_FLAG_XMP);
        vp8x = chunk;
      }
      if (fourcc !== 'VP8X' && fourcc !== 'ICCP') sawImage = true;
      kept.push(chunk);
    }
    i = paddedEnd;
  }
  if (!sawImage) throw new ImageMetadataError('corrupt', 'WebP has no image data');
  if (orientation !== null && orientation !== 1 && vp8x) {
    /*
     * An EXIF chunk only exists in the extended format, so a file that had one
     * necessarily has a VP8X to re-flag. It goes LAST: the spec puts metadata
     * chunks after the image data.
     */
    vp8x[8] |= VP8X_FLAG_EXIF;
    const tiff = buildOrientationTiff(orientation);
    const header = new Uint8Array(8);
    header.set([0x45, 0x58, 0x49, 0x46], 0); // 'EXIF'
    new DataView(header.buffer).setUint32(4, tiff.length, true);
    kept.push(header, tiff);
  }
  const body = concat(kept);
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  new DataView(header.buffer).setUint32(4, 4 + body.length, true); // 'WEBP' + payload
  header.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
  return { bytes: concat([header, body]), orientation };
}

/* ------------------------------------------------------------------- GIF -- */

/*
 * GIF carries no EXIF: its metadata surfaces are the comment extension and
 * application extensions (XMP ships as one). Kept are the two application
 * extensions that drive looping and the graphic-control extensions that drive
 * animation timing.
 */
const GIF_KEEP_APP_IDS = ['NETSCAPE2.0', 'ANIMEXTS1.0'];

function skipSubBlocks(buf: Uint8Array, from: number): number {
  let p = from;
  for (;;) {
    if (p >= buf.length) throw new ImageMetadataError('corrupt', 'GIF ends mid sub-block');
    const size = buf[p];
    if (size === 0) return p + 1;
    p += 1 + size;
  }
}

function stripGif(buf: Uint8Array): Uint8Array {
  if (buf.length < 13) throw new ImageMetadataError('corrupt', 'GIF too short');
  const packed = buf[10];
  let i = 13;
  if (packed & 0x80) i += 3 * (1 << ((packed & 0x07) + 1)); // global colour table
  if (i > buf.length) throw new ImageMetadataError('corrupt', 'GIF colour table runs past end of file');
  const kept: Uint8Array[] = [buf.subarray(0, i)];
  let sawTrailer = false;

  while (i < buf.length) {
    const introducer = buf[i];
    if (introducer === 0x3b) { // trailer
      kept.push(new Uint8Array([0x3b]));
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
        GIF_KEEP_APP_IDS.indexOf(ascii(buf, dataStart + 1, dataStart + 12)) !== -1;
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
    throw new ImageMetadataError('corrupt', 'unexpected GIF block 0x' + introducer.toString(16));
  }
  if (!sawTrailer) throw new ImageMetadataError('corrupt', 'GIF has no trailer');
  return concat(kept);
}

/* ------------------------------------------------------------------- BMP -- */

/**
 * BMP has no metadata container at all — no EXIF, no XMP, no IPTC, no text
 * chunks. There is exactly one place something can hide: bytes appended AFTER
 * the size the header declares, which some converters use to smuggle a
 * metadata block through a format that has nowhere to put one. Trim to the
 * declared size and there is nothing left to strip.
 *
 * A `bfSize` of 0 (broken writers do this) or one that overruns the file is
 * not trusted; the bytes are passed through rather than truncated to
 * something arbitrary.
 */
function stripBmp(buf: Uint8Array): Uint8Array {
  if (buf.length < 14) throw new ImageMetadataError('corrupt', 'BMP too short');
  const declared = u32le(buf, 2);
  if (declared >= 14 && declared < buf.length) return buf.subarray(0, declared);
  return buf;
}

/* ------------------------------------------------------------------- API -- */

/**
 * Removes every privacy-relevant metadata field from an image, keeping the ICC
 * profile and the orientation *in effect*.
 *
 * Throws `ImageMetadataError` rather than returning the input when the bytes
 * cannot be cleaned. Callers must refuse the send — never fall back to the
 * original.
 */
export function stripImageMetadata(input: Uint8Array): StripResult {
  if (!(input instanceof Uint8Array) || input.length === 0) {
    throw new ImageMetadataError('corrupt', 'empty image buffer');
  }
  const format = sniffImageFormat(input);
  switch (format) {
    case 'jpeg': {
      const { bytes, orientation } = stripJpeg(input);
      return { bytes, format, strategy: 'surgical', orientation };
    }
    case 'png': {
      const { bytes, orientation } = stripPng(input);
      return { bytes, format, strategy: 'surgical', orientation };
    }
    case 'webp': {
      const { bytes, orientation } = stripWebp(input);
      return { bytes, format, strategy: 'surgical', orientation };
    }
    case 'gif':
      return { bytes: stripGif(input), format, strategy: 'surgical', orientation: null };
    case 'bmp':
      return { bytes: stripBmp(input), format, strategy: 'passthrough', orientation: null };
    default:
      /*
       * HEIC, AVIF, TIFF, or something that is not an image at all. The server
       * copy re-encodes here; this one has no decoder, and guessing is not an
       * option when the guess is "publish the GPS". `sendEncryptedChatMedia`
       * rejects HEIC before it ever reaches this line, and every type in
       * `CHAT_MEDIA_MIME_ALLOWLIST` has a case above — so reaching this is
       * already a file no recipient could have rendered.
       */
      throw new ImageMetadataError('unsupported', 'cannot clean this image format on the client');
  }
}
