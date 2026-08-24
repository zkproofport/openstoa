/**
 * How long a client waits for this API, in one place for every client.
 *
 * WHY SHARED. The numbers were already identical — 15s ordinary, 60s for a
 * megabyte body — and defined twice, in `src/lib/apiFetch.ts` and
 * `packages/mobile/src/api/timeout.ts`. Nothing connected them, so raising one
 * would leave the other giving up sooner on the same operation, and the
 * difference would only ever show as "it works on the web".
 *
 * The argument is not new; it is the one the web file already makes about
 * upload versus download: "Written as two independent numbers they would drift,
 * and the drift would be invisible — the direction that broke would be
 * whichever one somebody forgot." That is exactly as true across two clients as
 * it is across two directions, and it went unapplied there.
 *
 * A deadline is part of how you talk to an API, which is why this lives beside
 * the response types and the cache keys rather than in either client.
 */

/**
 * The deadline an ordinary request gets.
 *
 * Long enough for a slow mobile network to answer, short enough that a request
 * which will never answer does not hold a screen. Long-lived connections are
 * NOT covered: both clients hold SSE streams open deliberately, and neither
 * routes them through the wrapper this bounds.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * The deadline for a request whose body is megabytes — an image or a chat
 * attachment going up.
 *
 * Longer because the clock covers the body moving, not idle time: a transfer
 * that is making progress must not be cut off for making progress slowly.
 */
export const UPLOAD_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The deadline for downloading those same megabytes back.
 *
 * Defined AS the upload constant rather than as a second `60_000`: the same
 * file, under the same size cap, moving the other way. One budget seen from two
 * ends.
 */
export const MEDIA_DOWNLOAD_TIMEOUT_MS = UPLOAD_REQUEST_TIMEOUT_MS;
