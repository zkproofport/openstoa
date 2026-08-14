/**
 * Turning an iPhone photo into something every browser can show — IN THE TAB,
 * before it is encrypted.
 *
 * The server used to do this. It cannot any more, and that is the point: an
 * encrypted attachment is opaque bytes by the time it leaves the device, so
 * nothing downstream can decode a HEIC that a browser refuses to render. Until
 * now the sender simply got a refusal ("HEIC photos cannot be sent to an
 * encrypted chat"), which is honest but useless to somebody holding a photo
 * their phone took.
 *
 * So the conversion moves to the one place that still has the plaintext: here,
 * before `sealMedia`. The ciphertext then carries a JPEG, and the server sees
 * exactly what it saw before — bytes it cannot read.
 *
 * WHAT DOES THE DECODING — two attempts, in this order:
 *
 *   1. THE BROWSER'S OWN pipeline, via `createImageBitmap` + a canvas. Free,
 *      fast, hardware-backed, and already present on Safari. Nothing is
 *      downloaded and nothing is bundled for it.
 *   2. A REAL DECODER, imported only if (1) could not do it. Chrome and Firefox
 *      cannot decode HEIC, and a person who AirDropped a photo to a laptop
 *      should not be told no because of their browser. `heic-convert/browser`
 *      is an existing dependency of this repo (the server used it before
 *      encryption made server-side transcoding impossible), so this adds no new
 *      supply-chain surface — and `await import()` means it is a separate chunk
 *      that only downloads for someone who actually sends a HEIC.
 *
 * Nobody who never sends one pays a byte. Order matters: the platform first,
 * the megabyte second, never the other way round.
 *
 * WHAT IT NEVER DOES: send the original when conversion fails. A failure is a
 * refusal, never an unencrypted or unviewable upload.
 */

/** JPEG quality for the converted photo. Visually indistinguishable, ~1/4 the bytes. */
const JPEG_QUALITY = 0.92;

/**
 * Refuse to even attempt a decode above this.
 *
 * Decoding is the expensive step, not the encoding: a 12-megapixel photo is
 * ~48MB of RGBA in the canvas whatever its compressed size, and a tab that is
 * asked to do that on a huge input can be killed outright — which looks to the
 * user like the app crashing, not like a file being too big. The cap is on the
 * INPUT here; the output is capped separately by the caller, against the
 * converted bytes.
 */
export const MAX_HEIC_INPUT_BYTES = 40 * 1024 * 1024;

/**
 * The bundled decoder's shape — `heic-convert/browser`, dynamically imported.
 *
 * Typed here rather than pulled from the package because it ships no types, and
 * a `any` at the boundary would hide the one thing that matters: what comes
 * back is raw bytes that still have to be checked.
 */
export type HeicDecoder = (opts: {
  buffer: Uint8Array;
  format: 'JPEG';
  quality: number;
}) => Promise<ArrayBuffer>;

/** Injectable so the second attempt can be tested without downloading anything. */
export type HeicDecoderLoader = () => Promise<HeicDecoder | null>;

/**
 * Pull the decoder down, once, only when it is actually needed.
 *
 * A separate chunk by construction (`await import`), so the cost lands on the
 * person sending a HEIC in a browser that cannot decode one — and on nobody
 * else. A failed import is null, not a throw: the caller's refusal is a fine
 * outcome and a network hiccup is not worth a different message.
 */
let decoderPromise: Promise<HeicDecoder | null> | null = null;
export const loadBundledHeicDecoder: HeicDecoderLoader = () => {
  if (!decoderPromise) {
    decoderPromise = import('heic-convert/browser')
      .then((mod) => ((mod as { default?: HeicDecoder }).default ?? (mod as unknown as HeicDecoder)) || null)
      .catch(() => null);
  }
  return decoderPromise;
};

/** Injectable so the conversion can be tested without a browser. */
export interface HeicConvertDeps {
  /** Decode compressed bytes into something drawable. */
  decode(blob: Blob): Promise<{ width: number; height: number; close?: () => void }>;
  /** Draw the decoded image and re-encode it as JPEG. */
  encode(image: unknown, width: number, height: number, quality: number): Promise<Uint8Array<ArrayBuffer> | null>;
}

/** The browser pipeline: `createImageBitmap` → canvas → `toBlob('image/jpeg')`. */
function browserDeps(): HeicConvertDeps | null {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  return {
    decode: (blob) => createImageBitmap(blob),
    async encode(image, width, height, quality) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(image as CanvasImageSource, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', quality),
      );
      // Free the backing store rather than waiting for GC: this is the largest
      // allocation on the page and the user may send several photos in a row.
      canvas.width = 0;
      canvas.height = 0;
      if (!blob) return null;
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}

/**
 * Convert HEIC bytes to JPEG, or null if this browser cannot.
 *
 * Null is not an error state to report — it means "fall back to the refusal the
 * caller already has". Every failure path returns null: no decoder, a decoder
 * that cannot read this container, a canvas that will not allocate, an encode
 * that produces nothing.
 *
 * A multi-image container (a burst, a Live Photo, a depth-map pair) yields its
 * PRIMARY image, which is the one Photos shows and the one the sender means.
 */
export async function convertHeicToJpeg(
  bytes: Uint8Array,
  deps: HeicConvertDeps | null = browserDeps(),
  loadDecoder: HeicDecoderLoader = loadBundledHeicDecoder,
): Promise<Uint8Array<ArrayBuffer> | null> {
  /*
   * The size check comes FIRST, before either attempt — and specifically before
   * the import. Pulling down a megabyte of decoder to then refuse the file is
   * the one ordering that wastes somebody's bandwidth for nothing.
   */
  if (bytes.length === 0 || bytes.length > MAX_HEIC_INPUT_BYTES) return null;

  const native = deps ? await convertWithPlatform(bytes, deps) : null;
  if (native) return native;

  // Only now, and only for someone whose browser could not do it.
  const decode = await loadDecoder();
  if (!decode) return null;
  try {
    const out = await decode({ buffer: bytes, format: 'JPEG', quality: JPEG_QUALITY });
    const jpeg = new Uint8Array(out);
    return jpeg.length > 0 ? jpeg : null;
  } catch {
    return null;
  }
}

/** Attempt 1: the platform's own decoder. Null when it cannot or will not. */
async function convertWithPlatform(
  bytes: Uint8Array,
  deps: HeicConvertDeps,
): Promise<Uint8Array<ArrayBuffer> | null> {
  let image: { width: number; height: number; close?: () => void } | null = null;
  try {
    image = await deps.decode(new Blob([bytes as BlobPart], { type: 'image/heic' }));
    if (!image || !image.width || !image.height) return null;
    const jpeg = await deps.encode(image, image.width, image.height, JPEG_QUALITY);
    // An encode that returns nothing, or returns nothing USEFUL, is a failure —
    // sending a zero-byte "photo" would be worse than refusing.
    return jpeg && jpeg.length > 0 ? jpeg : null;
  } catch {
    return null;
  } finally {
    // ImageBitmap holds decoded pixels until it is closed. Several photos in a
    // row without this is how a tab runs out of memory.
    try {
      image?.close?.();
    } catch {
      /* nothing to do */
    }
  }
}
