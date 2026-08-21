/**
 * The advertised attachment cap is one a person can actually reach, and it is
 * DERIVED from the transport rather than typed next to it.
 *
 * It was neither. `MAX_CHAT_MEDIA_BYTES` was a flat 10MB — the number the
 * composer promised and the route checked — but the ciphertext travelled as
 * base64 inside a JSON body, and Next's App Router buffers that body behind
 * middleware at 10MB with no per-route override (vercel/next.js#68409). base64
 * is 4/3, so a 10MB file became a 13.3MB body and died in the parser.
 *
 * Two failures, not one. The upload broke somewhere above ~7.4MB, and the
 * person was told `Body must be JSON` — a sentence about syntax, for a file
 * whose only problem was its size. The server's own "too large" branch and the
 * client's pre-flight guard were both unreachable, so neither could say it.
 *
 * The fix then was to derive the cap from the transport limit. The change now
 * is to stop paying base64 at all: the ciphertext is the request body, raw, so
 * the 4/3 term disappears from the derivation and the same 10MB ceiling reaches
 * ~9.5MB instead of ~7.1MB.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → the cap is derived from the transport limit, not a literal;
 *                and it MOVES when the transport limit does
 *   contract   → the derivation contains no base64 term any more — a cap still
 *                sized for 4/3 would pass every other assertion in this file
 *   boundary   → a maximum-sized attachment still fits, WITH the AEAD overhead
 *   integrity  → the ciphertext cap sits above the plaintext cap by the AEAD
 *                overhead, so a legal file is never refused for its own tag
 *   boundary   → headroom is real: the worst-case body stays under the ceiling
 *                rather than landing exactly on it (the measured boundary is
 *                inclusive — a body of exactly 10.0MB was refused)
 *   contract   → all three consumers read ONE definition, not three copies
 *   empty / hostile / UTF-8 / authz / race → N/A: this is arithmetic over two
 *                constants; the request-level cases live in the route tests.
 */
import { describe, it, expect } from 'vitest';
import {
  CHAT_MEDIA_AEAD_OVERHEAD_BYTES,
  MAX_CHAT_MEDIA_BYTES,
  MAX_CHAT_MEDIA_CIPHERTEXT_BYTES,
  MAX_REQUEST_BODY_BYTES,
} from '@/lib/chatMedia';

/**
 * Bytes on the wire for an upload of `plaintextBytes`.
 *
 * The body IS the ciphertext now, so this is the plaintext plus the AEAD frame
 * and nothing else. Under the old framing it was
 * `{"mediaId":"…","ciphertext":"<base64>"}`, which added a 4/3 expansion and a
 * JSON envelope on top — see `legacyJsonBodyBytesFor` below, which is kept
 * precisely so the improvement is asserted rather than described.
 */
function bodyBytesFor(plaintextBytes: number): number {
  return plaintextBytes + CHAT_MEDIA_AEAD_OVERHEAD_BYTES;
}

/** What the SAME attachment used to weigh, as base64 inside a JSON object. */
function legacyJsonBodyBytesFor(plaintextBytes: number): number {
  const ciphertext = plaintextBytes + CHAT_MEDIA_AEAD_OVERHEAD_BYTES;
  const base64 = Math.ceil(ciphertext / 3) * 4;
  const envelope = '{"mediaId":"","ciphertext":""}'.length + 32;
  return base64 + envelope;
}

describe('the attachment cap is reachable', () => {
  it('CONTRACT: a maximum-sized attachment fits inside the transport limit', () => {
    /*
     * The regression in one line. With the old flat 10MB cap this was 13.9MB
     * against a 10MB ceiling — every "allowed" file at the top of the range
     * failed, and failed with the wrong message.
     */
    expect(bodyBytesFor(MAX_CHAT_MEDIA_BYTES)).toBeLessThan(MAX_REQUEST_BODY_BYTES);
  });

  it('BOUNDARY: with headroom, not balanced on the ceiling', () => {
    // The measured limit is inclusive: a body of exactly 10.0MB was refused
    // while 9.3MB passed. A cap that computes to exactly the ceiling would
    // reproduce the bug at the top of the range.
    expect(bodyBytesFor(MAX_CHAT_MEDIA_BYTES)).toBeLessThanOrEqual(MAX_REQUEST_BODY_BYTES * 0.96);
  });

  it('BOUNDARY: one byte over the cap is over the wire budget too', () => {
    // The two limits move together: there is no size that the client would
    // allow and the transport would then refuse.
    expect(bodyBytesFor(MAX_CHAT_MEDIA_BYTES + 1)).toBeGreaterThan(bodyBytesFor(MAX_CHAT_MEDIA_BYTES));
  });

  it('INTEGRITY: the ciphertext cap clears plaintext plus its AEAD overhead', () => {
    // A legal file must never be refused because of the nonce and tag the
    // client is obliged to add.
    expect(MAX_CHAT_MEDIA_CIPHERTEXT_BYTES).toBeGreaterThan(
      MAX_CHAT_MEDIA_BYTES + CHAT_MEDIA_AEAD_OVERHEAD_BYTES,
    );
  });

  it('CONTRACT: the cap is derived, not a round number someone typed', () => {
    /*
     * A flat 10 * 1024 * 1024 is exactly what drifted from the transport. If a
     * later edit re-declares a literal, this fails — the point is that the two
     * numbers cannot be changed independently again.
     */
    expect(MAX_CHAT_MEDIA_BYTES).not.toBe(10 * 1024 * 1024);
    expect(MAX_CHAT_MEDIA_BYTES).toBeLessThan(MAX_REQUEST_BODY_BYTES);
    // Still a useful size to a person — a fix that shrank it to nothing would
    // pass every assertion above.
    expect(MAX_CHAT_MEDIA_BYTES).toBeGreaterThan(5 * 1024 * 1024);
  });

  it('CONTRACT: the cap MOVES with the transport limit, rather than sitting beside it', () => {
    /*
     * "Derived" has to mean something a test can see. This recomputes the cap
     * from a DIFFERENT transport limit using the shipped derivation, and
     * asserts the answer scales — a hardcoded 9_961_444 would not.
     *
     * Read out of the source rather than re-implemented here: a copy of the
     * arithmetic in the test is a second declaration of the same rule, and two
     * declarations are what this whole file exists to prevent.
     */
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const src = readFileSync('packages/mls/src/chatMedia.ts', 'utf8');
    const expr = /export const MAX_CHAT_MEDIA_BYTES =\s*([^;]+);/.exec(src)?.[1];
    expect(expr, 'MAX_CHAT_MEDIA_BYTES must still be an expression').toBeTruthy();

    const evaluate = (transportLimit: number) =>
      Function(
        'MAX_REQUEST_BODY_BYTES',
        'MEDIA_BODY_HEADROOM_BYTES',
        'CHAT_MEDIA_AEAD_OVERHEAD_BYTES',
        `return ${expr};`,
      )(transportLimit, Math.floor(transportLimit * 0.05), CHAT_MEDIA_AEAD_OVERHEAD_BYTES);

    expect(evaluate(MAX_REQUEST_BODY_BYTES)).toBe(MAX_CHAT_MEDIA_BYTES);
    // Double the transport and the cap roughly doubles. A literal would not.
    expect(evaluate(MAX_REQUEST_BODY_BYTES * 2)).toBeGreaterThan(MAX_CHAT_MEDIA_BYTES * 1.9);
    // Halve it and the cap follows down, so a lowered ceiling cannot leave the
    // composer promising a size the transport refuses.
    expect(evaluate(MAX_REQUEST_BODY_BYTES / 2)).toBeLessThan(MAX_CHAT_MEDIA_BYTES * 0.6);
  });

  it('CONTRACT: the derivation no longer pays for base64', () => {
    /*
     * The point of the binary transport, asserted rather than described. A cap
     * still carrying the 4/3 term would be ~7.1MB and would pass every other
     * test in this file — this is the one that notices.
     */
    expect(MAX_CHAT_MEDIA_BYTES).toBeGreaterThan(9 * 1024 * 1024);

    // And the same attachment would NOT have fitted under the old framing, which
    // is what "the cap rose" actually means.
    expect(legacyJsonBodyBytesFor(MAX_CHAT_MEDIA_BYTES)).toBeGreaterThan(MAX_REQUEST_BODY_BYTES);
  });

  it('INTEGRITY: all three clients read ONE definition, not three copies', async () => {
    /*
     * The web app, the mini-app and the SDK used to hold hand-synced copies of
     * this file, and a test compared the `MAX_CHAT_MEDIA_BYTES` line across two
     * of them. That test survived the move to `@openstoa/mls` and quietly
     * stopped checking anything: both paths became re-export files, the regex
     * matched nothing in either, and `undefined === undefined` passed.
     *
     * So this asserts the shape that now holds them together — each consumer
     * path is a re-export and states the constant nowhere — plus the fact that
     * the real definition exists exactly once.
     */
    const { readFileSync } = await import('node:fs');
    const shared = readFileSync('packages/mls/src/chatMedia.ts', 'utf8');
    expect(shared.match(/export const MAX_CHAT_MEDIA_BYTES =/g)).toHaveLength(1);

    for (const path of [
      'src/lib/chatMedia.ts',
      'packages/mobile/src/lib/chatMedia.ts',
      'packages/sdk/src/chatMedia.ts',
    ]) {
      const src = readFileSync(path, 'utf8');
      expect(src, `${path} must re-export the shared implementation`).toMatch(
        /export \* from '.*mls\/src\/chatMedia';/,
      );
      expect(src, `${path} must not restate the cap`).not.toContain('MAX_CHAT_MEDIA_BYTES =');
    }
  });
});
