/**
 * `heic-convert/browser` ships no types.
 *
 * Declared narrowly — only the call this repo makes — so the shape stays a
 * statement of what we rely on rather than a re-export of somebody else's API.
 */
declare module 'heic-convert/browser' {
  const convert: (opts: {
    buffer: Uint8Array;
    format: 'JPEG' | 'PNG';
    quality?: number;
  }) => Promise<ArrayBuffer>;
  export default convert;
}
