/**
 * The sender's own picture is not downloaded back from the server.
 *
 * WHAT THIS IS FOR. `ChatMediaAttachment` is written from the reader's point of
 * view: it has an envelope naming an object, so it fetches the object and opens
 * it. That is right for every bubble except one — the sender's, which renders
 * moments after this same app encrypted those exact bytes and uploaded them,
 * then threw the plaintext away. Measured on the web, the redundant round trip
 * was 2441ms of a 8661ms wait for a 7.7MB image; a phone on mobile data pays
 * more, not less.
 *
 * The web has had this since the attachment work; the mini-app did not, so the
 * cache moved into `@openstoa/mls` and both consumers now read one copy. Only
 * the BYTES are shared: the web builds a blob URL, the mini-app writes a file,
 * and that split is why the cache knows nothing about how it is displayed.
 *
 * EDGE-CASE MATRIX → coverage
 *   contract   → what was sealed is what comes back
 *   integrity  → a size or mime that disagrees with the envelope is a MISS
 *   boundary   → the byte budget evicts the oldest, never the newest
 *   empty      → an unknown id, and a zero-length entry
 *   hostile    → an id that was never sealed cannot borrow another's bytes
 *   race       → remembering the same id twice keeps the first, not a duplicate
 * N/A: authorization — this is per-process memory holding only what THIS app
 * just encrypted; nothing arrives here that the caller did not already have.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  rememberSentChatMedia,
  readSentChatMedia,
  __resetSentChatMediaCache,
} from '../lib/chatMediaPlaintextCache';

const JPEG = 'image/jpeg';

function bytes(n: number, fill = 1): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

beforeEach(() => {
  __resetSentChatMediaCache();
});

describe('CONTRACT: what was sealed is what comes back', () => {
  it('returns the exact bytes and mime', () => {
    const b = bytes(1024, 9);
    rememberSentChatMedia('m1', b, JPEG);

    const hit = readSentChatMedia('m1', 1024, JPEG);
    expect(hit).not.toBeNull();
    expect(hit!.mime).toBe(JPEG);
    expect(hit!.bytes.length).toBe(1024);
    expect(hit!.bytes[0]).toBe(9);
  });

  it('EMPTY: an id that was never sealed is a miss', () => {
    expect(readSentChatMedia('never', 10, JPEG)).toBeNull();
  });
});

describe('INTEGRITY: the envelope decides whether a hit counts', () => {
  it('a size that disagrees is a miss, not a wrong picture', () => {
    // The envelope describes what the reader must get back. Anything that
    // disagrees is not the thing being asked for, and falling through to the
    // network is always a correct answer.
    rememberSentChatMedia('m1', bytes(1024), JPEG);
    expect(readSentChatMedia('m1', 2048, JPEG)).toBeNull();
  });

  it('a mime that disagrees is a miss', () => {
    rememberSentChatMedia('m1', bytes(1024), JPEG);
    expect(readSentChatMedia('m1', 1024, 'image/png')).toBeNull();
  });

  it('HOSTILE: one id cannot borrow another id"s bytes', () => {
    rememberSentChatMedia('m1', bytes(1024, 1), JPEG);
    rememberSentChatMedia('m2', bytes(1024, 2), JPEG);
    expect(readSentChatMedia('m2', 1024, JPEG)!.bytes[0]).toBe(2);
  });
});

describe('BOUNDARY and RACE', () => {
  it('RACE: remembering the same id twice keeps the first', () => {
    // Two renders of one send must not double the bytes held.
    rememberSentChatMedia('m1', bytes(1024, 1), JPEG);
    rememberSentChatMedia('m1', bytes(1024, 5), JPEG);
    expect(readSentChatMedia('m1', 1024, JPEG)!.bytes[0]).toBe(1);
  });

  it('the budget drops the OLDEST, and what was just sent survives', () => {
    /*
     * Bounded in BYTES, not entries — an entry is up to the attachment cap, so
     * counting entries bounds nothing useful. The newest must survive: it is
     * the one on screen.
     */
    // Ten each, so the third genuinely crosses the 24MB budget rather than
    // landing exactly on it — an earlier version of this test used 8MB×3 and
    // proved nothing, because nothing was ever over.
    const ten = 10 * 1024 * 1024;
    rememberSentChatMedia('old', bytes(ten, 1), JPEG);
    rememberSentChatMedia('mid', bytes(ten, 2), JPEG);
    rememberSentChatMedia('new', bytes(ten, 3), JPEG);

    expect(readSentChatMedia('new', ten, JPEG), 'the newest send was evicted').not.toBeNull();
    expect(readSentChatMedia('old', ten, JPEG), 'the oldest was kept over the newest').toBeNull();
  });

  it('EMPTY: a zero-length entry round-trips rather than being treated as absent', () => {
    rememberSentChatMedia('m0', bytes(0), JPEG);
    expect(readSentChatMedia('m0', 0, JPEG)).not.toBeNull();
  });
});
