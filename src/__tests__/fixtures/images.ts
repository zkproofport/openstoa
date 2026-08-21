/**
 * Image fixtures for the metadata-stripping tests.
 *
 * Real encoders produce the containers (sharp), and the metadata that sharp
 * cannot write — XMP, IPTC, an embedded EXIF thumbnail, PNG text/timestamp
 * chunks, GIF comment extensions — is spliced in at the byte level here, so
 * the tests exercise the same shapes a phone or Lightroom would emit.
 */
import sharp from 'sharp';

/** Distinct strings the tests search for in the OUTPUT bytes. */
export const SECRETS = {
  make: 'ACME-CAM',
  model: 'SecretCam 9000',
  software: 'iOS 17.4 build 21E219',
  dateTimeOriginal: '2024:01:02 03:04:05',
  bodySerial: 'BODY-SN-123456',
  lens: 'ACME 24mm f/1.4',
  xmp: 'photoshop:City="Seoul"',
  iptc: 'Jane Photographer',
  comment: 'shot at home 서울 🏠',
  pngText: 'Author\0Jane Photographer 서울 🏠',
  thumbnail: 'THUMBNAILDATA-do-not-publish',
  gifComment: 'GIFCOMMENT-do-not-publish',
  svgMetadata: 'Jane Photographer',
} as const;

/* --------------------------------------------------------------- helpers -- */

/** Wraps a payload in a JPEG marker segment (`FF <marker> <len> <payload>`). */
export function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** Splices segments in right after SOI, where a camera would put them. */
export function insertJpegSegments(jpeg: Buffer, segments: Buffer[]): Buffer {
  return Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Splices chunks in just before the first IDAT, where real encoders put them. */
export function insertPngChunksBeforeIdat(png: Buffer, chunks: Buffer[]): Buffer {
  let i = 8;
  while (i + 8 <= png.length) {
    const length = png.readUInt32BE(i);
    if (png.toString('ascii', i + 4, i + 8) === 'IDAT') break;
    i += 12 + length;
  }
  return Buffer.concat([png.subarray(0, i), ...chunks, png.subarray(i)]);
}

/** Splices chunks in just before IEND, which is where ancillary chunks live. */
export function insertPngChunks(png: Buffer, chunks: Buffer[]): Buffer {
  const iend = png.length - 12; // length + 'IEND' + CRC
  return Buffer.concat([png.subarray(0, iend), ...chunks, png.subarray(iend)]);
}

/* ----------------------------------------------------------------- EXIF -- */

/**
 * Hand-built EXIF block: IFD0 carries the orientation, IFD1 carries an
 * embedded thumbnail. sharp cannot write IFD1, and the thumbnail is the field
 * with the nastiest failure mode (it survives cropping and redaction of the
 * main image), so it is built here byte by byte.
 */
export function exifWithThumbnail(orientation = 6, thumbnail = Buffer.from(SECRETS.thumbnail)): Buffer {
  const IFD0_OFFSET = 8;
  const IFD0_SIZE = 2 + 12 + 4;                 // one entry
  const IFD1_OFFSET = IFD0_OFFSET + IFD0_SIZE;  // 26
  const IFD1_SIZE = 2 + 12 * 3 + 4;             // three entries
  const THUMB_OFFSET = IFD1_OFFSET + IFD1_SIZE; // 68
  const tiff = Buffer.alloc(THUMB_OFFSET + thumbnail.length);
  tiff.write('MM', 0, 'ascii');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(IFD0_OFFSET, 4);

  tiff.writeUInt16BE(1, IFD0_OFFSET);
  tiff.writeUInt16BE(0x0112, IFD0_OFFSET + 2);  // Orientation
  tiff.writeUInt16BE(3, IFD0_OFFSET + 4);       // SHORT
  tiff.writeUInt32BE(1, IFD0_OFFSET + 6);
  tiff.writeUInt16BE(orientation, IFD0_OFFSET + 10);
  tiff.writeUInt32BE(IFD1_OFFSET, IFD0_OFFSET + 14); // link to IFD1

  const entry = (index: number, tag: number, type: number, value: number) => {
    const off = IFD1_OFFSET + 2 + index * 12;
    tiff.writeUInt16BE(tag, off);
    tiff.writeUInt16BE(type, off + 2);
    tiff.writeUInt32BE(1, off + 4);
    if (type === 3) tiff.writeUInt16BE(value, off + 8);
    else tiff.writeUInt32BE(value, off + 8);
  };
  tiff.writeUInt16BE(3, IFD1_OFFSET);
  entry(0, 0x0103, 3, 6);                        // Compression = JPEG thumbnail
  entry(1, 0x0201, 4, THUMB_OFFSET);             // JPEGInterchangeFormat
  entry(2, 0x0202, 4, thumbnail.length);         // JPEGInterchangeFormatLength
  tiff.writeUInt32BE(0, IFD1_OFFSET + 2 + 36);   // no further IFD
  thumbnail.copy(tiff, THUMB_OFFSET);
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
}

/* ------------------------------------------------------------- fixtures -- */

export interface JpegOptions {
  width?: number;
  height?: number;
  orientation?: number;
  icc?: boolean;
}

/**
 * A JPEG shaped like a phone photo: GPS, capture time, camera make/model/lens,
 * body serial, Software, an XMP packet, an IPTC block, a COM comment, a P3 ICC
 * profile and a non-normal orientation.
 */
export async function jpegWithMetadata(opts: JpegOptions = {}): Promise<Buffer> {
  const { width = 60, height = 40, orientation = 6, icc = true } = opts;
  let pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 9, g: 9, b: 200 } },
  }).jpeg({ quality: 80 });
  if (orientation !== 1) pipeline = pipeline.withMetadata({ orientation });
  if (icc) pipeline = pipeline.withIccProfile('p3');
  const base = await pipeline
    .withExif({
      IFD0: { Make: SECRETS.make, Model: SECRETS.model, Software: SECRETS.software },
      IFD2: {
        DateTimeOriginal: SECRETS.dateTimeOriginal,
        BodySerialNumber: SECRETS.bodySerial,
        LensModel: SECRETS.lens,
      },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '37/1 33/1 2200/100',
        GPSLongitudeRef: 'E',
        GPSLongitude: '126/1 58/1 1500/100',
      },
    })
    .toBuffer();

  const xmp = jpegSegment(
    0xe1,
    Buffer.concat([
      Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'),
      Buffer.from(`<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta><rdf:Description ${SECRETS.xmp}/></x:xmpmeta><?xpacket end="w"?>`),
    ]),
  );
  const iptc = jpegSegment(
    0xed,
    Buffer.concat([
      Buffer.from('Photoshop 3.0\0', 'latin1'),
      Buffer.from(`8BIM\x04\x04${SECRETS.iptc}`, 'latin1'),
    ]),
  );
  const com = jpegSegment(0xfe, Buffer.from(SECRETS.comment, 'utf8'));
  return insertJpegSegments(base, [xmp, iptc, com]);
}

/** A JPEG whose EXIF carries an embedded thumbnail (IFD1). */
export async function jpegWithThumbnail(orientation = 6): Promise<Buffer> {
  const base = await sharp({
    create: { width: 60, height: 40, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  return insertJpegSegments(base, [jpegSegment(0xe1, exifWithThumbnail(orientation))]);
}

/** A PNG carrying tEXt / iTXt / zTXt / tIME / eXIf, plus a real ICC profile. */
export async function pngWithMetadata(opts: { orientation?: number } = {}): Promise<Buffer> {
  const base = await sharp({
    create: { width: 30, height: 20, channels: 4, background: { r: 5, g: 90, b: 120, alpha: 1 } },
  })
    .png({ compressionLevel: 6 })
    .withIccProfile('p3')
    .toBuffer();

  const tIME = Buffer.alloc(7);
  tIME.writeUInt16BE(2024, 0);
  tIME[2] = 1; tIME[3] = 2; tIME[4] = 3; tIME[5] = 4; tIME[6] = 5;
  const extra = [
    pngChunk('tEXt', Buffer.from(SECRETS.pngText, 'latin1')),
    pngChunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${SECRETS.xmp}`, 'utf8')),
    pngChunk('tIME', tIME),
  ];
  const withText = insertPngChunks(base, extra);
  if (opts.orientation && opts.orientation !== 1) {
    // PNG stores EXIF raw (no "Exif\0\0" header). Real encoders put `eXIf`
    // before IDAT, and libvips only auto-orients when it sits there.
    return insertPngChunksBeforeIdat(withText, [
      pngChunk('eXIf', exifWithThumbnail(opts.orientation).subarray(6)),
    ]);
  }
  return withText;
}

/** A WebP with an EXIF chunk (sharp writes a real one) and an XMP chunk. */
export async function webpWithMetadata(opts: { orientation?: number } = {}): Promise<Buffer> {
  let pipeline = sharp({
    create: { width: 24, height: 16, channels: 3, background: { r: 3, g: 130, b: 60 } },
  }).webp({ quality: 80 });
  if (opts.orientation && opts.orientation !== 1) {
    pipeline = pipeline.withMetadata({ orientation: opts.orientation });
  }
  const base = await pipeline
    .withExif({
      IFD0: { Make: SECRETS.make, Model: SECRETS.model },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 33/1 2200/100' },
    })
    .toBuffer();
  return appendRiffChunk(base, 'XMP ', Buffer.from(SECRETS.xmp, 'utf8'));
}

/** Appends a RIFF chunk and fixes up the container size + VP8X flags. */
export function appendRiffChunk(webp: Buffer, fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  const padding = data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
  const out = Buffer.concat([webp, head, data, padding]);
  out.writeUInt32LE(out.length - 8, 4);
  if (out.toString('ascii', 12, 16) === 'VP8X' && fourcc === 'XMP ') out[20] |= 0x04;
  return out;
}

/** An animated GIF with a comment extension and an XMP application extension. */
export async function gifWithMetadata(): Promise<Buffer> {
  const base = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 220, g: 220, b: 10 } },
  })
    .gif()
    .toBuffer();
  const comment = Buffer.concat([
    Buffer.from([0x21, 0xfe]),
    Buffer.from([SECRETS.gifComment.length]),
    Buffer.from(SECRETS.gifComment, 'latin1'),
    Buffer.from([0x00]),
  ]);
  const xmpPayload = Buffer.from(SECRETS.xmp, 'latin1');
  const xmp = Buffer.concat([
    Buffer.from([0x21, 0xff, 11]),
    Buffer.from('XMP DataXMP', 'latin1'),
    Buffer.from([xmpPayload.length]),
    xmpPayload,
    Buffer.from([0x00]),
  ]);
  // Both extensions go right after the header block, before the first frame.
  const packed = base[10];
  let headerEnd = 13;
  if (packed & 0x80) headerEnd += 3 * (1 << ((packed & 0x07) + 1));
  return Buffer.concat([base.subarray(0, headerEnd), comment, xmp, base.subarray(headerEnd)]);
}

export const SVG_WITH_METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Created by ${SECRETS.svgMetadata} at 37.5665, 126.9780 -->
<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">
  <metadata><rdf:RDF><dc:creator>${SECRETS.svgMetadata}</dc:creator></rdf:RDF></metadata>
  <rect width="20" height="20" fill="#123456"/>
</svg>`;

/**
 * Tiny valid images for tests that only need the upload route to accept the
 * bytes. Kept as literals so they are available synchronously.
 */
export const TINY_JPEG = Buffer.from(
  '/9j/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAL/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIAHSt//2Q==',
  'base64',
);

export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVR42mM4kWIERAwQCgAorgV5quCIYQAAAABJRU5ErkJggg==',
  'base64',
);
