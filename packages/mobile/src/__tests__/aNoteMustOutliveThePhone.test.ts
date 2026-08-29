/**
 * The recovery-code note has to survive erasing the device. That is its job.
 *
 * WHAT HAPPENED, measured against production on 2026-08-29: the note had a live
 * ciphertext and NO archive row. Erasing the phone destroyed the room's group
 * state, the new leaf could not open the old ciphertext, and the recovery code
 * had nothing to restore — so the one message a person needs after wiping a
 * phone was the one message a wipe destroyed. The room said "Only your recovery
 * code can bring this back" while the code was already entered and working.
 *
 * WHY IT SURVIVED A FIX ONCE ALREADY. The same symptom appeared on 2026-08-27
 * and was closed by caching the plaintext locally. A cache keeps the note
 * readable ON THIS DEVICE; only the archive keeps it readable after the device
 * is gone. Two different problems, one screen message — so the second one hid
 * behind the first.
 *
 * Edge-case matrix rows covered here:
 *   contract   — the note is archived, with the id the SERVER assigned, and the
 *                text that was actually sent
 *   race       — archiving is best-effort: a throwing archive must not turn a
 *                delivered message into a reported failure, and must not stop
 *                the local cache
 *   contract   — the archive runs BEFORE the cache, so when only one gets to
 *                run it is the one that outlives the phone
 *   boundary   — no archive supplied at all still sends (older caller)
 *   empty      — a room that does not exist, and a note already filed, archive
 *                nothing
 *   integrity  — nothing is archived when the post itself failed
 *   UTF-8      — Korean and emoji reach the archive unchanged
 *   authz / hostile / large — N/A: this function takes a body its caller built
 *                and posts it; the server owns authorisation and size limits
 */
import { describe, it, expect } from 'vitest';
import { fileNoteOnce } from '../lib/personalRoomNote';

const ROOM = '11111111-2222-4333-8444-555555555555';
const MSG = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

interface Call {
  topicId: string;
  messageId: string;
  plaintext: string;
}

/** A client whose personal room exists and whose post succeeds. */
function workingClient(msgId: string | null = MSG) {
  return {
    get: async <T,>() => ({ topics: [{ id: ROOM, personal: true }] }) as T,
    post: async <T,>() => ({ message: msgId ? { id: msgId } : undefined }) as T,
  };
}

/** A sealer that seals and caches without complaint, recording what it cached. */
function workingSealer(cached: string[], order?: string[]) {
  return {
    seal: async () => ({ ciphertext: 'c2VhbGVk', epoch: 0 }),
    cachePlaintext: async (_t: string, _m: string, body: string) => {
      order?.push('cache');
      cached.push(body);
    },
  };
}

describe('a note must outlive the phone', () => {
  it('CONTRACT: the note is archived under the id the server assigned', async () => {
    const calls: Call[] = [];
    const r = await fileNoteOnce(workingClient(), workingSealer([]), 'my recovery code', {
      archive: async (topicId, messageId, plaintext) => {
        calls.push({ topicId, messageId, plaintext });
      },
    });
    expect(r).toEqual({ kind: 'sent', topicId: ROOM });
    expect(calls).toEqual([{ topicId: ROOM, messageId: MSG, plaintext: 'my recovery code' }]);
  });

  it('CONTRACT: the archive runs before the local cache', async () => {
    // When only one of the two gets to run, it must be the one that survives
    // the device. Order is the only thing that decides that.
    const order: string[] = [];
    await fileNoteOnce(workingClient(), workingSealer([], order), 'body', {
      archive: async () => {
        order.push('archive');
      },
    });
    expect(order).toEqual(['archive', 'cache']);
  });

  it('RACE: an archive that throws does not fail a message already delivered', async () => {
    const cached: string[] = [];
    const r = await fileNoteOnce(workingClient(), workingSealer(cached), 'body', {
      archive: async () => {
        throw new Error('network gone');
      },
    });
    // The message IS on the server. Reporting failure would make the caller
    // write a second one on the next launch.
    expect(r).toEqual({ kind: 'sent', topicId: ROOM });
    // And the local cache still ran, so this device can read what it wrote.
    expect(cached).toEqual(['body']);
  });

  it('BOUNDARY: a caller that supplies no archive still sends', async () => {
    const r = await fileNoteOnce(workingClient(), workingSealer([]), 'body', {});
    expect(r).toEqual({ kind: 'sent', topicId: ROOM });
  });

  it('UTF-8: Korean and emoji reach the archive unchanged', async () => {
    const body = '복구 코드 NY47-AHD6 🗝️';
    const calls: Call[] = [];
    await fileNoteOnce(workingClient(), workingSealer([]), body, {
      archive: async (t, m, p) => {
        calls.push({ topicId: t, messageId: m, plaintext: p });
      },
    });
    expect(calls[0]?.plaintext).toBe(body);
  });

  it('EMPTY: no personal room means nothing is archived', async () => {
    const calls: Call[] = [];
    const r = await fileNoteOnce(
      { get: async <T,>() => ({ topics: [] }) as T, post: async <T,>() => ({}) as T },
      workingSealer([]),
      'body',
      { archive: async (t, m, p) => void calls.push({ topicId: t, messageId: m, plaintext: p }) },
    );
    expect(r).toEqual({ kind: 'no-room' });
    expect(calls).toEqual([]);
  });

  it('EMPTY: a note already filed archives nothing', async () => {
    const calls: Call[] = [];
    const r = await fileNoteOnce(workingClient(), workingSealer([]), 'body', {
      alreadyFiled: async () => true,
      archive: async (t, m, p) => void calls.push({ topicId: t, messageId: m, plaintext: p }),
    });
    expect(r).toEqual({ kind: 'already' });
    expect(calls).toEqual([]);
  });

  it('INTEGRITY: a post that failed archives nothing', async () => {
    const calls: Call[] = [];
    const r = await fileNoteOnce(
      {
        get: async <T,>() => ({ topics: [{ id: ROOM, personal: true }] }) as T,
        post: async () => {
          throw new Error('server said no');
        },
      },
      workingSealer([]),
      'body',
      { archive: async (t, m, p) => void calls.push({ topicId: t, messageId: m, plaintext: p }) },
    );
    expect(r.kind).toBe('failed');
    expect(calls).toEqual([]);
  });

  it('INTEGRITY: no server-assigned id means nothing to archive against', async () => {
    // Without an id there is no handle tying the ciphertext to the text, so an
    // archive row would be unreachable. Reported as sent-uncached, not sent.
    const calls: Call[] = [];
    const r = await fileNoteOnce(workingClient(null), workingSealer([]), 'body', {
      archive: async (t, m, p) => void calls.push({ topicId: t, messageId: m, plaintext: p }),
    });
    expect(r).toEqual({ kind: 'sent-uncached', topicId: ROOM });
    expect(calls).toEqual([]);
  });
});
