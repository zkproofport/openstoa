/*
 * A note this device files must be readable BY THIS DEVICE.
 *
 * THE DEFECT, seen on a phone on 2026-08-27 and not by any test before it. The
 * recovery-code note arrived in the person's own room and rendered as:
 *
 *     Waiting for the key…
 *     Only your recovery code can bring this back — nobody else is here to
 *     unlock it.
 *
 * The recovery code was inside that message. A copy that can only be opened with
 * the thing it contains is worth nothing.
 *
 * WHY IT HAPPENED. MLS gives a sender no way to decrypt its own application
 * message — which is precisely why `mlsSession.cachePlaintext` exists, and why
 * `ChatRoomScreen` calls it on every ordinary send. `fileNoteOnce` sealed,
 * posted, and returned `sent`. Nothing kept the text, so the next time the room
 * was opened the author's own line was locked.
 *
 * WHAT THE TESTS MISSED. They asserted the POST happened and that a second call
 * did not duplicate. Both true, both silent about whether the message could ever
 * be read again — the question a note exists to answer.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → a successful file caches the plaintext under the server's id
 *   integrity  → the cached text is the note body, byte for byte
 *   contract   → a send whose cache is impossible reports `sent-uncached`,
 *                never `sent`
 *   boundary   → a response with no message id is `sent-uncached`
 *   failure    → a cache that throws is `sent-uncached`, and does not fail the
 *                send: the message IS on the server for other devices
 *   race       → N notes in a row each cache under their own id
 */
import { describe, it, expect, vi } from 'vitest';

import { fileNoteOnce, type PersonalRoomClient, type PersonalRoomSealer } from '../lib/personalRoomNote';

const TOPIC = 'topic-personal';

function client(over: Partial<PersonalRoomClient> = {}, ids: string[] = ['m1']): PersonalRoomClient {
  let n = 0;
  return {
    get: (async () => ({ topics: [{ id: TOPIC, personal: true }] })) as never,
    post: (async () => ({ message: { id: ids[n++] ?? ids[ids.length - 1] } })) as never,
    ...over,
  };
}

function sealer(over: Partial<PersonalRoomSealer> = {}) {
  const cached: Array<{ topicId: string; msgId: string; plaintext: string }> = [];
  const s: PersonalRoomSealer = {
    seal: async (_t, _p) => ({ ciphertext: 'sealed', epoch: 1 }),
    cachePlaintext: async (topicId, msgId, plaintext) => {
      cached.push({ topicId, msgId, plaintext });
    },
    ...over,
  };
  return { sealer: s, cached };
}

describe('a filed note is readable by the device that filed it', () => {
  it('CONTRACT: a successful file caches the plaintext under the server id', async () => {
    const { sealer: s, cached } = sealer();
    const r = await fileNoteOnce(client(), s, 'the note body');

    expect(r).toEqual({ kind: 'sent', topicId: TOPIC });
    expect(cached).toEqual([{ topicId: TOPIC, msgId: 'm1', plaintext: 'the note body' }]);
  });

  it('INTEGRITY: the cached text is the body, byte for byte', async () => {
    /*
     * A recovery code is compared character by character by a person reading it
     * off a screen. Anything trimmed, normalised or re-wrapped in transit makes
     * the copy wrong in the one way nobody would notice until it is needed.
     */
    /*
     * LEADING AND TRAILING WHITESPACE IS PART OF THE TEST, not decoration. The
     * first version of this case used a body with neither, so a mutation that
     * cached `body.trim()` survived every assertion — the guard looked like it
     * checked fidelity and only checked the middle.
     */
    const body = '\n🔑 Your recovery key\n\nBIXR-UGUZ-USCL-EI6V\n\n안녕하세요 — do not lose this\n ';
    const { sealer: s, cached } = sealer();
    await fileNoteOnce(client(), s, body);

    expect(cached[0].plaintext).toBe(body);
    // Named separately so a failure says WHICH end was eaten.
    expect(cached[0].plaintext.startsWith('\n')).toBe(true);
    expect(cached[0].plaintext.endsWith(' ')).toBe(true);
  });

  it('CONTRACT: a sealer that cannot cache reports sent-uncached, not sent', async () => {
    /*
     * THE DISTINCTION THAT MADE THIS DEFECT INVISIBLE. The message really is on
     * the server, so `sent` is half true — and the half it hides is the half a
     * note is for.
     */
    const { sealer: s } = sealer({ cachePlaintext: undefined });
    const r = await fileNoteOnce(client(), s, 'body');

    expect(r).toEqual({ kind: 'sent-uncached', topicId: TOPIC });
  });

  it('BOUNDARY: a response with no message id is sent-uncached', async () => {
    // Without the server's id there is no handle to cache under: the ciphertext
    // and the text cannot be tied together later.
    const { sealer: s, cached } = sealer();
    const r = await fileNoteOnce(client({ post: (async () => ({})) as never }), s, 'body');

    expect(r).toEqual({ kind: 'sent-uncached', topicId: TOPIC });
    expect(cached).toEqual([]);
  });

  it('FAILURE: a cache that throws is sent-uncached and does NOT fail the send', async () => {
    /*
     * The message is on the server and other devices can read it. Reporting
     * `failed` would invite a retry that files a second copy.
     */
    const { sealer: s } = sealer({
      cachePlaintext: async () => {
        throw new Error('keystore unavailable');
      },
    });
    const r = await fileNoteOnce(client(), s, 'body');

    expect(r).toEqual({ kind: 'sent-uncached', topicId: TOPIC });
  });

  it('RACE: five notes in a row each cache under their OWN id', async () => {
    /*
     * The accumulating axis. One note passing proves the call is wired; it does
     * not prove the id is read fresh each time — a cached-once implementation
     * would file five messages and leave four of them locked, which on a phone
     * looks like "some of my own messages are unreadable".
     */
    const { sealer: s, cached } = sealer();
    const c = client({}, ['m1', 'm2', 'm3', 'm4', 'm5']);

    for (let i = 0; i < 5; i++) {
      const r = await fileNoteOnce(c, s, `note ${i}`);
      expect(r.kind).toBe('sent');
    }

    expect(cached.map((x) => x.msgId)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(cached.map((x) => x.plaintext)).toEqual([
      'note 0',
      'note 1',
      'note 2',
      'note 3',
      'note 4',
    ]);
  });

  it('CONTRACT: nothing is cached when the note was not sent at all', async () => {
    // `already` and `no-room` write no message, so there is nothing to keep —
    // and caching under a stale id would make a DIFFERENT message unreadable.
    const { sealer: s, cached } = sealer();

    const noRoom = await fileNoteOnce(
      client({ get: (async () => ({ topics: [] })) as never }),
      s,
      'body',
    );
    expect(noRoom).toEqual({ kind: 'no-room' });

    const already = await fileNoteOnce(client(), s, 'body', {
      alreadyFiled: async () => true,
    });
    expect(already).toEqual({ kind: 'already' });

    expect(cached).toEqual([]);
  });
});
