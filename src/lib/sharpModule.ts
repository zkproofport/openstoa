/**
 * Loading sharp, once, with a type that survives the container build.
 *
 * WHY NOT `typeof import('sharp')`. Two files did that and both broke the
 * production image build:
 *
 *   Type 'typeof import("/app/node_modules/sharp/dist/index")'
 *   has no call signatures.
 *
 * sharp IS installed there — the path in the error proves it. What differs is
 * how the module resolves under the build's settings: the namespace has no
 * call signature, so `sharp(buf)` is a type error even though it is exactly
 * what the library is for at runtime.
 *
 * It stayed invisible for as long as the Docker layer cache survived, and
 * appeared the moment the cache was cleared — which is what a CI runner does on
 * every cold run. The build was only ever working because of the cache.
 *
 * WHAT THIS DECLARES: only the pipeline the two callers actually use. A
 * structural type cannot drift out of sync with an install the way a namespace
 * import can, and if a caller later needs another method the compiler asks for
 * it here rather than failing in an image nobody rebuilds until CI does.
 *
 * The runtime already treated sharp as optional — a lazy `require` inside a
 * `try`, and both callers check for null. This makes the TYPE optional too,
 * which is the half that was missing.
 */

/** The chainable object `sharp(...)` returns, narrowed to what is used. */
export interface SharpPipeline {
  rotate(angle?: number): SharpPipeline;
  flip(): SharpPipeline;
  flop(): SharpPipeline;
  jpeg(opts: { quality: number }): SharpPipeline;
  keepIccProfile(): SharpPipeline;
  toBuffer(): Promise<Buffer>;
}

export type SharpModule = (
  input: Buffer,
  opts?: { failOn?: 'none' | 'truncated' | 'error' | 'warning' },
) => SharpPipeline;

/**
 * The module, or null when the native binary is missing on this platform.
 *
 * Callers MUST handle null: an unusual base image can ship without it, and the
 * whole point of loading late is that the route stays importable when it does.
 */
export function loadSharp(): SharpModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('sharp') as SharpModule;
  } catch {
    return null;
  }
}
