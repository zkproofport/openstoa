/**
 * Image fixtures for the CLIENT metadata-strip tests — hand-built, no encoder.
 *
 * The server-side suite builds its fixtures with sharp
 * (`src/__tests__/fixtures/images.ts`) and that is the better fixture: real
 * encoder output, decodable, so the test can assert what a decoder SEES.
 * The client suite cannot use it everywhere, for two reasons:
 *
 *   1. the mini-app suite has to prove this code runs where sharp, `Buffer`
 *      and every other Node facility do not exist — that is the whole point of
 *      the shared strip being dependency-free — so its fixtures cannot import
 *      one, and
 *   2. the hostile cases (a segment length that overruns the file, a chunk
 *      claiming 2GB, an unterminated GIF sub-block) are byte patterns no
 *      encoder will produce on request.
 *
 * So: `Uint8Array` and arithmetic only, matching what these fixtures stand for.
 * The strings below are what the tests search the OUTPUT for; they are the same
 * secrets the server fixtures use, so a reader comparing the two suites sees
 * one policy rather than two.
 */

/** Distinct strings the tests search for in the OUTPUT bytes. */
export const SECRETS = {
  make: 'ACME-CAM',
  model: 'SecretCam 9000',
  software: 'iOS 17.4 build 21E219',
  dateTimeOriginal: '2024:01:02 03:04:05',
  bodySerial: 'BODY-SN-123456',
  lens: 'ACME 24mm f/1.4',
  gps: 'GPS-37.5665-126.9780',
  xmp: 'photoshop:City="Seoul"',
  iptc: 'Jane Photographer',
  comment: 'shot at home 서울 🏠',
  pngText: 'Author\0Jane Photographer 서울 🏠',
  thumbnail: 'THUMBNAILDATA-do-not-publish',
  gifComment: 'GIFCOMMENT-do-not-publish',
} as const;

/* --------------------------------------------------------------- helpers -- */

export function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** UTF-8 without `Buffer` or `TextEncoder` — Hermes has the latter, but the */
/** point of these fixtures is to depend on nothing at all. */
export function utf8(s: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of s) {
    let cp = ch.codePointAt(0) as number;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
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

/** Does the haystack contain this literal string, as bytes? */
export function containsText(haystack: Uint8Array, needle: string): boolean {
  const utf = utf8(needle);
  const lat = latin1(needle);
  return contains(haystack, utf) || contains(haystack, lat);
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ JPEG -- */

/** Wraps a payload in a JPEG marker segment (`FF <marker> <len> <payload>`). */
export function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const head = new Uint8Array(4);
  head[0] = 0xff;
  head[1] = marker;
  head[2] = ((payload.length + 2) >> 8) & 0xff;
  head[3] = (payload.length + 2) & 0xff;
  return concatBytes([head, payload]);
}

/**
 * An EXIF block shaped like a phone's: IFD0 with orientation, make, model and
 * software, IFD1 with an embedded thumbnail, and a GPS-flavoured string in the
 * middle so a test can look for it by name.
 *
 * The thumbnail is the field worth building by hand: it is not regenerated
 * when the main image is cropped or redacted, so a "redacted" photo can leak
 * the redacted region through its own thumbnail.
 */
export function exifBlock(orientation = 6): Uint8Array {
  const strings = concatBytes([
    latin1(SECRETS.make + '\0'),
    latin1(SECRETS.model + '\0'),
    latin1(SECRETS.software + '\0'),
    latin1(SECRETS.dateTimeOriginal + '\0'),
    latin1(SECRETS.bodySerial + '\0'),
    latin1(SECRETS.lens + '\0'),
    latin1(SECRETS.gps + '\0'),
  ]);
  const thumbnail = latin1(SECRETS.thumbnail);

  const IFD0 = 8;
  const IFD0_ENTRIES = 4;
  const IFD0_SIZE = 2 + 12 * IFD0_ENTRIES + 4;
  const IFD1 = IFD0 + IFD0_SIZE;
  const IFD1_SIZE = 2 + 12 * 3 + 4;
  const STRINGS = IFD1 + IFD1_SIZE;
  const THUMB = STRINGS + strings.length;

  const tiff = new Uint8Array(THUMB + thumbnail.length);
  const view = new DataView(tiff.buffer);
  tiff[0] = 0x4d; tiff[1] = 0x4d;            // 'MM'
  view.setUint16(2, 42);
  view.setUint32(4, IFD0);

  let stringAt = STRINGS;
  const put = (base: number, index: number, tag: number, type: number, count: number, value: number) => {
    const off = base + 2 + index * 12;
    view.setUint16(off, tag);
    view.setUint16(off + 2, type);
    view.setUint32(off + 4, count);
    if (type === 3 && count === 1) view.setUint16(off + 8, value);
    else view.setUint32(off + 8, value);
  };
  const putString = (base: number, index: number, tag: number, text: string) => {
    put(base, index, tag, 2, text.length + 1, stringAt);
    stringAt += text.length + 1;
  };

  view.setUint16(IFD0, IFD0_ENTRIES);
  put(IFD0, 0, 0x0112, 3, 1, orientation);   // Orientation
  putString(IFD0, 1, 0x010f, SECRETS.make);  // Make
  putString(IFD0, 2, 0x0110, SECRETS.model); // Model
  putString(IFD0, 3, 0x0131, SECRETS.software);
  view.setUint32(IFD0 + 2 + 12 * IFD0_ENTRIES, IFD1); // link to IFD1

  view.setUint16(IFD1, 3);
  put(IFD1, 0, 0x0103, 3, 1, 6);             // Compression = JPEG thumbnail
  put(IFD1, 1, 0x0201, 4, 1, THUMB);         // JPEGInterchangeFormat
  put(IFD1, 2, 0x0202, 4, 1, thumbnail.length);
  view.setUint32(IFD1 + 2 + 36, 0);

  tiff.set(strings, STRINGS);
  tiff.set(thumbnail, THUMB);
  return concatBytes([latin1('Exif\0\0'), tiff]);
}

/** The bytes of a JPEG scan, including a stuffed `FF 00` and a restart marker. */
const SCAN = new Uint8Array([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78]);

/**
 * A JPEG shaped like a phone photo: EXIF (GPS/time/camera/serial + embedded
 * thumbnail), an XMP packet, an IPTC block, a COM comment, a JFIF block and an
 * ICC profile, wrapped around a minimal but structurally valid scan.
 */
export function jpegWithMetadata(opts: { orientation?: number; icc?: boolean } = {}): Uint8Array {
  const { orientation = 6, icc = true } = opts;
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  parts.push(jpegSegment(0xe0, latin1('JFIF\0\x01\x02\x00\x00\x01\x00\x01\x00\x00')));
  parts.push(jpegSegment(0xe1, exifBlock(orientation)));
  parts.push(
    jpegSegment(
      0xe1,
      concatBytes([
        latin1('http://ns.adobe.com/xap/1.0/\0'),
        utf8(`<?xpacket begin=""?><x:xmpmeta><rdf:Description ${SECRETS.xmp}/></x:xmpmeta><?xpacket end="w"?>`),
      ]),
    ),
  );
  parts.push(
    jpegSegment(0xed, concatBytes([latin1('Photoshop 3.0\0'), latin1(`8BIM\x04\x04${SECRETS.iptc}`)])),
  );
  parts.push(jpegSegment(0xfe, utf8(SECRETS.comment)));
  if (icc) {
    parts.push(jpegSegment(0xe2, concatBytes([latin1('ICC_PROFILE\0\x01\x01'), latin1('FAKE-ICC-PAYLOAD')])));
  }
  // SOF0: 8-bit, 16x16, one component.
  parts.push(jpegSegment(0xc0, new Uint8Array([0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00])));
  parts.push(jpegSegment(0xda, new Uint8Array([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])));
  parts.push(SCAN);
  parts.push(new Uint8Array([0xff, 0xd9]));
  return concatBytes(parts);
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

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG carrying tEXt / iTXt / tIME / eXIf, plus an ICC profile chunk. */
export function pngWithMetadata(opts: { orientation?: number } = {}): Uint8Array {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 4);
  new DataView(ihdr.buffer).setUint32(4, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const tIME = new Uint8Array([0x07, 0xe8, 1, 2, 3, 4, 5]); // 2024-01-02 03:04:05
  const chunks: Uint8Array[] = [PNG_SIGNATURE, pngChunk('IHDR', ihdr)];
  if (opts.orientation && opts.orientation !== 1) {
    chunks.push(pngChunk('eXIf', exifBlock(opts.orientation).subarray(6)));
  }
  chunks.push(
    pngChunk('iCCP', latin1('sRGB\0\0FAKE-ICC-PAYLOAD')),
    pngChunk('tEXt', utf8(SECRETS.pngText)),
    pngChunk('iTXt', concatBytes([latin1('XML:com.adobe.xmp\0\0\0\0\0'), utf8(SECRETS.xmp)])),
    pngChunk('tIME', tIME),
    pngChunk('IDAT', latin1('PIXELS-NOT-REALLY-DEFLATE')),
    pngChunk('IEND', new Uint8Array(0)),
  );
  return concatBytes(chunks);
}

/* ------------------------------------------------------------------ WebP -- */

export function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  for (let i = 0; i < 4; i++) head[i] = fourcc.charCodeAt(i);
  new DataView(head.buffer).setUint32(4, data.length, true);
  const pad = data.length % 2 === 1 ? new Uint8Array(1) : new Uint8Array(0);
  return concatBytes([head, data, pad]);
}

/** An extended-format WebP with VP8X, ICCP, EXIF and XMP chunks. */
export function webpWithMetadata(opts: { orientation?: number } = {}): Uint8Array {
  const vp8xData = new Uint8Array(10);
  vp8xData[0] = 0x08 | 0x04 | 0x20; // EXIF | XMP | ICC advertised
  const body = concatBytes([
    riffChunk('VP8X', vp8xData),
    riffChunk('ICCP', latin1('FAKE-ICC-PAYLOAD')),
    riffChunk('VP8 ', latin1('VP8-PIXEL-DATA')),
    riffChunk('EXIF', exifBlock(opts.orientation ?? 6).subarray(6)),
    riffChunk('XMP ', utf8(SECRETS.xmp)),
  ]);
  const header = new Uint8Array(12);
  header.set(latin1('RIFF'), 0);
  new DataView(header.buffer).setUint32(4, 4 + body.length, true);
  header.set(latin1('WEBP'), 8);
  return concatBytes([header, body]);
}

/* ------------------------------------------------------------------- GIF -- */

/** A GIF with a comment extension and an XMP application extension. */
export function gifWithMetadata(): Uint8Array {
  const header = concatBytes([
    latin1('GIF89a'),
    new Uint8Array([0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00]), // 16x16, no GCT
  ]);
  const comment = concatBytes([
    new Uint8Array([0x21, 0xfe, SECRETS.gifComment.length]),
    latin1(SECRETS.gifComment),
    new Uint8Array([0x00]),
  ]);
  const xmpPayload = latin1(SECRETS.xmp);
  const xmp = concatBytes([
    new Uint8Array([0x21, 0xff, 11]),
    latin1('XMP DataXMP'),
    new Uint8Array([xmpPayload.length]),
    xmpPayload,
    new Uint8Array([0x00]),
  ]);
  const loop = concatBytes([
    new Uint8Array([0x21, 0xff, 11]),
    latin1('NETSCAPE2.0'),
    new Uint8Array([3, 1, 0, 0, 0x00]),
  ]);
  const gce = new Uint8Array([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]);
  const frame = concatBytes([
    new Uint8Array([0x2c, 0, 0, 0, 0, 0x10, 0x00, 0x10, 0x00, 0x00]), // descriptor
    new Uint8Array([0x02]),                                           // LZW min code size
    new Uint8Array([0x03, 0x11, 0x22, 0x33, 0x00]),                   // one sub-block
  ]);
  return concatBytes([header, loop, comment, xmp, gce, frame, new Uint8Array([0x3b])]);
}

/* ------------------------------------------------------------------- BMP -- */

/** A BMP with a metadata blob appended past the size its header declares. */
export function bmpWithTrailingData(trailer: string = SECRETS.gps): Uint8Array {
  const pixels = new Uint8Array(16).fill(0x40);
  const size = 14 + 40 + pixels.length;
  const head = new Uint8Array(14 + 40);
  const view = new DataView(head.buffer);
  head[0] = 0x42; head[1] = 0x4d; // 'BM'
  view.setUint32(2, size, true);
  view.setUint32(10, 54, true);   // pixel data offset
  view.setUint32(14, 40, true);   // DIB header size
  view.setInt32(18, 2, true);     // width
  view.setInt32(22, 2, true);     // height
  view.setUint16(26, 1, true);    // planes
  view.setUint16(28, 32, true);   // bpp
  return concatBytes([head, pixels, latin1(trailer)]);
}

/* --------------------------------------------------- clean minimal images -- */

/**
 * A real PNG with nothing on the strip list in it: signature, IHDR, IDAT, IEND.
 *
 * Every test that sends an attachment needs one of these now. Before the strip
 * existed, the send path never looked at the bytes, so suites passed
 * `new Uint8Array([1, 2, 3])` and it worked; the day the path started walking
 * the container, three arbitrary bytes stopped being an image it could clean.
 * Cleaning this one is the IDENTITY — the output is byte-for-byte the input —
 * which is what lets a test assert an exact size after a send.
 *
 * `totalBytes` pads the IDAT, for the tests that need a file of an exact size.
 */
export function minimalPng(totalBytes = 65): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 4);  // width
  view.setUint32(4, 4);  // height
  ihdr[8] = 8;           // bit depth
  ihdr[9] = 6;           // RGBA
  // 8 (signature) + 25 (IHDR) + 12 + n (IDAT) + 12 (IEND) = 57 + n
  const idat = new Uint8Array(Math.max(0, totalBytes - 57)).fill(0x5a);
  return concatBytes([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

/**
 * A real JPEG with nothing on the strip list in it: SOI, JFIF, SOF0, SOS, EOI.
 * Cleaning it is likewise the identity — JFIF carries pixel density, which is
 * kept.
 */
export function minimalJpeg(): Uint8Array {
  return concatBytes([
    new Uint8Array([0xff, 0xd8]),
    jpegSegment(0xe0, latin1('JFIF\0\x01\x02\x00\x00\x01\x00\x01\x00\x00')),
    jpegSegment(0xc0, new Uint8Array([0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00])),
    jpegSegment(0xda, new Uint8Array([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
    SCAN,
    new Uint8Array([0xff, 0xd9]),
  ]);
}
