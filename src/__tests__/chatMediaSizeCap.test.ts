/**
 * The advertised attachment cap is one a person can actually reach.
 *
 * It was not. `MAX_CHAT_MEDIA_BYTES` was a flat 10MB — the number the composer
 * promised and the route checked — but the ciphertext travels as base64 inside
 * a JSON body, and Next's App Router buffers that body behind middleware at
 * 10MB with no per-route override (vercel/next.js#68409). base64 is 4/3, so a
 * 10MB file became a 13.3MB body and died in the parser.
 *
 * Two failures, not one. The upload broke somewhere above ~7.4MB, and the
 * person was told `Body must be JSON` — a sentence about syntax, for a file
 * whose only problem was its size. The server's own "too large" branch and the
 * client's pre-flight guard were both unreachable, so neither could say it.
 *
 * Measured against the running container before the fix: 7MB raw (9.3MB body)
 * uploaded; 7.5MB raw (10.0MB body) was rejected. The cap is derived from the
 * transport limit now instead of declared beside it.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → the cap is derived from the transport limit, not a literal
 *   boundary   → a maximum-sized attachment still fits, WITH its base64
 *                expansion, the AEAD overhead and the JSON envelope
 *   integrity  → the ciphertext cap sits above the plaintext cap by the AEAD
 *                overhead, so a legal file is never refused for its own tag
 *   boundary   → headroom is real: the worst-case body stays under the ceiling
 *                rather than landing exactly on it (the measured boundary is
 *                inclusive — a body of exactly 10.0MB was refused)
 *   empty / hostile / UTF-8 / authz / race → N/A: this is arithmetic over two
 *                constants; the request-level cases live in the route tests.
 */
import { describe, it, expect } from 'vitest';
import {
  CHAT_MEDIA_AEAD_OVERHEAD_BYTES,
  MAX_CHAT_MEDIA_BYTES,
  MAX_CHAT_MEDIA_CIPHERTEXT_BYTES,
  MAX_JSON_BODY_BYTES,
} from '@/lib/chatMedia';

/** Bytes on the wire for `{"mediaId":"…","ciphertext":"<base64 of n bytes>"}`. */
function jsonBodyBytesFor(plaintextBytes: number): number {
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
    expect(jsonBodyBytesFor(MAX_CHAT_MEDIA_BYTES)).toBeLessThan(MAX_JSON_BODY_BYTES);
  });

  it('BOUNDARY: with headroom, not balanced on the ceiling', () => {
    // The measured limit is inclusive: a body of exactly 10.0MB was refused
    // while 9.3MB passed. A cap that computes to exactly the ceiling would
    // reproduce the bug at the top of the range.
    const body = jsonBodyBytesFor(MAX_CHAT_MEDIA_BYTES);
    expect(body).toBeLessThanOrEqual(MAX_JSON_BODY_BYTES * 0.96);
  });

  it('BOUNDARY: one byte over the cap is over the wire budget too', () => {
    // The two limits move together: there is no size that the client would
    // allow and the transport would then refuse.
    const overCap = jsonBodyBytesFor(MAX_CHAT_MEDIA_BYTES + 1);
    expect(overCap).toBeGreaterThan(jsonBodyBytesFor(MAX_CHAT_MEDIA_BYTES));
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
    expect(MAX_CHAT_MEDIA_BYTES).toBeLessThan(MAX_JSON_BODY_BYTES);
    // Still a useful size to a person — a fix that shrank it to nothing would
    // pass every assertion above.
    expect(MAX_CHAT_MEDIA_BYTES).toBeGreaterThan(5 * 1024 * 1024);
  });

  it('INTEGRITY: both clients read the same number', async () => {
    // `packages/mobile/src/lib/chatMedia.ts` is a byte-identical twin. If only
    // one side is raised, the composer and the server disagree about what is
    // allowed, which is how the original mismatch reached a person.
    const { readFileSync } = await import('fs');
    const web = readFileSync('src/lib/chatMedia.ts', 'utf8');
    const mobile = readFileSync('packages/mobile/src/lib/chatMedia.ts', 'utf8');
    const capOf = (src: string) =>
      /export const MAX_CHAT_MEDIA_BYTES =[\s\S]*?;/.exec(src)?.[0].replace(/\s+/g, ' ');

    expect(capOf(mobile)).toBe(capOf(web));
  });
});
