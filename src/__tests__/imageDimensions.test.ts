/**
 * An attachment's row is reserved from these numbers, so a misread header is
 * not a cosmetic bug — it is the wrong-sized hole in the conversation.
 *
 * WHY THIS EXISTS AT ALL. `ChatMediaEnvelope` carried `size` (bytes) and
 * nothing about pixels, so a reader could not know how tall a picture would be
 * until it decoded. The placeholder was therefore one line of text, and every
 * image grew its row by hundreds of pixels on arrival. With four of them on
 * screen the view that opened pinned to the newest message ended up stranded in
 * the middle — measured on the web client at 258px from the bottom, and caught
 * on video entering from a push notification on iOS.
 *
 * HEADER-ONLY, ON THE SEND PATH. This runs on the JS thread for a file that may
 * be megabytes, right after the seal. Decoding the image to ask its size would
 * cost more than the encryption did. Every format states its dimensions in the
 * first few dozen bytes; that is all this reads.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → each supported format reports the size actually encoded
 *   hostile    → JPEG markers that are NOT frame headers (DHT 0xc4, 0xc8, 0xcc)
 *                sit inside the SOF range and would otherwise return a Huffman
 *                table's bytes as a width
 *   hostile    → a truncated header returns null rather than a partial read
 *   boundary   → 1x1 is valid; 0 and >20000 are refused as a misread
 *   empty      → empty / too-short buffers, and a non-Uint8Array
 *   integrity  → BMP top-down rows carry a NEGATIVE height; the sign is row
 *                order, not size, so the magnitude is what a row needs
 *   external   → an unknown container returns null and the send still goes
 */
import { describe, it, expect } from 'vitest';
import { readImageDimensions } from '../../packages/mls/src/imageMetadata';

/** Minimal but REAL containers — parsed by the same code paths as a camera file. */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  b.set([(w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255], 16);
  b.set([(h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255], 20);
  return b;
}

/** `segments` are raw [marker, ...payload-with-length] appended after SOI. */
function jpeg(segments: number[][]): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  for (const seg of segments) out.push(0xff, ...seg);
  return new Uint8Array(out);
}

/** A frame header: marker, length, precision, height, width, components. */
function sof(marker: number, w: number, h: number): number[] {
  return [marker, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 0x03,
          1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
}

function gif(w: number, h: number): Uint8Array {
  const b = new Uint8Array(13);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  b.set([w & 255, (w >> 8) & 255, h & 255, (h >> 8) & 255], 6);
  return b;
}

function bmp(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x42, 0x4d], 0);
  b.set([40, 0, 0, 0], 14); // BITMAPINFOHEADER
  const le = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  b.set(le(w), 18);
  b.set(le(h >>> 0), 22);
  return b;
}

function webpVp8x(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  const w1 = w - 1, h1 = h - 1;
  b.set([w1 & 255, (w1 >> 8) & 255, (w1 >> 16) & 255], 24);
  b.set([h1 & 255, (h1 >> 8) & 255, (h1 >> 16) & 255], 27);
  return b;
}

describe('readImageDimensions', () => {
  it('reads PNG', () => {
    expect(readImageDimensions(png(1179, 2556))).toEqual({ width: 1179, height: 2556 });
  });

  it('reads JPEG from the frame header', () => {
    expect(readImageDimensions(jpeg([sof(0xc0, 4032, 3024)]))).toEqual({ width: 4032, height: 3024 });
  });

  it('reads a progressive JPEG (SOF2)', () => {
    expect(readImageDimensions(jpeg([sof(0xc2, 800, 600)]))).toEqual({ width: 800, height: 600 });
  });

  it.each([
    ['DHT 0xc4', 0xc4],
    ['0xc8', 0xc8],
    ['DAC 0xcc', 0xcc],
  ])('does NOT mistake %s for a frame header', (_label, marker) => {
    // The decoy carries plausible-looking bytes where width/height would be.
    const decoy = [marker, 0x00, 0x11, 0x08, 0x13, 0x88, 0x0f, 0xa0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    const bytes = jpeg([decoy, sof(0xc0, 640, 480)]);
    expect(readImageDimensions(bytes)).toEqual({ width: 640, height: 480 });
  });

  it('skips an APP segment before the frame header', () => {
    const app1 = [0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
    expect(readImageDimensions(jpeg([app1, sof(0xc0, 320, 240)]))).toEqual({ width: 320, height: 240 });
  });

  it('gives up rather than guessing when the scan starts with no frame header', () => {
    expect(readImageDimensions(jpeg([[0xda, 0x00, 0x02]]))).toBeNull();
  });

  it('reads GIF', () => {
    expect(readImageDimensions(gif(300, 200))).toEqual({ width: 300, height: 200 });
  });

  it('reads BMP', () => {
    expect(readImageDimensions(bmp(64, 48))).toEqual({ width: 64, height: 48 });
  });

  it('reads a TOP-DOWN BMP, whose height is negative', () => {
    // -48 as a signed 32-bit value. The sign is row order; the row needs 48.
    expect(readImageDimensions(bmp(64, -48 >>> 0))).toEqual({ width: 64, height: 48 });
  });

  it('reads WebP (VP8X)', () => {
    expect(readImageDimensions(webpVp8x(1024, 768))).toEqual({ width: 1024, height: 768 });
  });

  it('accepts 1x1', () => {
    expect(readImageDimensions(png(1, 1))).toEqual({ width: 1, height: 1 });
  });

  it.each([
    ['zero width', 0, 100],
    ['zero height', 100, 0],
    ['absurd width', 20001, 100],
    ['absurd height', 100, 20001],
  ])('refuses %s as a misread header', (_label, w, h) => {
    expect(readImageDimensions(png(w, h))).toBeNull();
  });

  it.each([
    ['empty', new Uint8Array()],
    ['too short', new Uint8Array([0x89, 0x50])],
    ['truncated PNG header', png(100, 100).slice(0, 20)],
    ['unknown container', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])],
  ])('returns null for %s rather than throwing', (_label, bytes) => {
    expect(readImageDimensions(bytes)).toBeNull();
  });

  it('returns null for a non-Uint8Array without throwing', () => {
    expect(readImageDimensions(null as unknown as Uint8Array)).toBeNull();
  });
});
