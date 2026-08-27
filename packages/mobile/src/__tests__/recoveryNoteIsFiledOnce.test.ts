/*
 * The recovery key gets filed in the person's own room — once, sealed, with the
 * warning attached.
 *
 * WHY THE WARNING IS PART OF THE PAYLOAD AND NOT THE UI. The note is sealed
 * under a key derived from `master_key`, so losing that key makes this message
 * exactly as unreadable as everything it was meant to rescue: the recovery key,
 * filed behind the recovery key. A copy people MISTAKE for a backup is worse
 * than no copy — it is the difference between writing the key down and believing
 * you already did. Building the body in one place is what stops a caller from
 * sending the code without the sentence that says this.
 *
 * WHY SEALED AND NOT A SYSTEM MESSAGE. `systemText` is a plaintext column the
 * server reads (`chat.ts`, SI-1). Putting the key there files the thing that
 * opens `master_key` in the database in the clear — the one value `keyManager`
 * states never reaches the server. That was the first shape tried, and it is
 * checked here so it cannot come back as a simplification.
 *
 * THE AXIS IS REPETITION. Every launch that shows the sheet would otherwise file
 * another copy, and a room with twenty identical notes is one nobody reads.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   repetition (THE guard) → ten sends with a note already there send nothing
 *   contract   → the body carries the code AND the warning
 *   contract   → it goes to the PERSONAL room, not the first room in the list
 *   integrity  → the payload is ciphertext; the code never appears in it
 *   integrity  → a room this device cannot read is not written to
 *   boundary   → an account with no personal room is a no-op, not an error
 *   external   → a failed send is reported to the caller, not thrown
 *   hostile    → a code containing the marker does not fool the duplicate check
 */
import { describe, it, expect, vi } from 'vitest';
import {
  sendRecoveryNote,
  anyIsRecoveryNote,
  type RecoveryNoteClient,
  type RecoveryNoteSealer,
} from '../lib/sendRecoveryNote';
import { recoveryCodeNote, isRecoveryCodeNote } from '../lib/recoveryCodeNote';

const CODE = 'abcd-efgh-ijkl-mnop';
const STRINGS = {
  heading: 'Your recovery key',
  warning: 'Keep a copy OUTSIDE this app. This message is encrypted with the same keys it protects.',
};

/** Records what was posted, and seals by prefixing so plaintext is detectable. */
function harness(topics: Array<{ id: string; personal?: boolean }>) {
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  const sealedPlaintexts: string[] = [];

  const client: RecoveryNoteClient = {
    get: (async () => ({ topics })) as RecoveryNoteClient['get'],
    post: (async (path: string, body: unknown) => {
      posted.push({ path, body: body as Record<string, unknown> });
      /*
       * A server-assigned id, because the real one returns one and the note path
       * needs it to cache the plaintext. Returning `{}` here made every send
       * report `sent-uncached` — a fake that was simpler than reality in exactly
       * the place the reality mattered.
       */
      return { message: { id: `m${posted.length}` } };
    }) as RecoveryNoteClient['post'],
  };
  const sealer: RecoveryNoteSealer = {
    // The real sealer (`MlsSessionStore`) has this; without it a filed note is
    // unreadable to its own author. See `filedNoteIsReadableByItsAuthor`.
    cachePlaintext: async () => {},
    seal: async (_topicId, plaintext) => {
      sealedPlaintexts.push(plaintext);
      return { ciphertext: `SEALED(${plaintext.length})`, epoch: 7 };
    },
  };
  return { client, sealer, posted, sealedPlaintexts };
}

describe('the recovery note is filed once, sealed, with its warning', () => {
  it('REPETITION: ten attempts with a note already there send nothing', async () => {
    /*
     * THE guard. The sheet can open on any launch with no backup on file, and a
     * room holding twenty identical notes is one nobody reads.
     */
    const h = harness([{ id: 'personal-1', personal: true }]);
    const alreadyFiled = async () => true;

    for (let i = 0; i < 10; i++) {
      const r = await sendRecoveryNote(h.client, h.sealer, CODE, STRINGS, { alreadyFiled });
      expect(r.kind).toBe('already');
    }

    expect(h.posted).toEqual([]);
  });

  it('CONTRACT: the body carries the code AND the warning', async () => {
    const h = harness([{ id: 'personal-1', personal: true }]);

    await sendRecoveryNote(h.client, h.sealer, CODE, STRINGS);

    expect(h.sealedPlaintexts).toHaveLength(1);
    expect(h.sealedPlaintexts[0]).toContain(CODE);
    expect(h.sealedPlaintexts[0]).toContain(STRINGS.warning);
  });

  it('CONTRACT: it goes to the PERSONAL room, not the first one listed', async () => {
    // The personal room is not guaranteed to sort first, and a recovery key in
    // a shared room is a recovery key handed to everyone in it.
    const h = harness([
      { id: 'shared-1' },
      { id: 'shared-2' },
      { id: 'personal-1', personal: true },
    ]);

    const r = await sendRecoveryNote(h.client, h.sealer, CODE, STRINGS);

    expect(r).toEqual({ kind: 'sent', topicId: 'personal-1' });
    expect(h.posted[0].path).toBe('/api/topics/personal-1/chat');
  });

  it('INTEGRITY: the payload is ciphertext — the code never appears in it', async () => {
    /*
     * The whole reason this is not a system message. `systemText` is read by the
     * server; the key that opens `master_key` must never be in a column it can
     * read.
     */
    const h = harness([{ id: 'personal-1', personal: true }]);

    await sendRecoveryNote(h.client, h.sealer, CODE, STRINGS);

    const body = h.posted[0].body;
    expect(body).toHaveProperty('ciphertext');
    expect(body).toHaveProperty('epoch');
    expect(body).not.toHaveProperty('systemText');
    expect(body).not.toHaveProperty('message');
    expect(JSON.stringify(body)).not.toContain(CODE);
  });

  it('INTEGRITY: a room this device cannot read is not written to', async () => {
    /*
     * Not being able to tell whether a note is already there means the history
     * will not open — and a second unreadable copy helps nobody. Refusing is the
     * safer direction.
     */
    const h = harness([{ id: 'personal-1', personal: true }]);
    const alreadyFiled = async () => {
      throw new Error('cannot decrypt history');
    };

    const r = await sendRecoveryNote(h.client, h.sealer, CODE, STRINGS, { alreadyFiled });

    expect(r.kind).toBe('failed');
    expect(h.posted).toEqual([]);
  });

  it('BOUNDARY: an account with no personal room is a no-op', async () => {
    const h = harness([{ id: 'shared-1' }]);

    const r = await sendRecoveryNote(h.client, h.sealer, CODE, STRINGS);

    expect(r).toEqual({ kind: 'no-room' });
    expect(h.posted).toEqual([]);
  });

  it('EXTERNAL: a failed send is returned, not thrown', async () => {
    /*
     * The caller decides what to do, and what it does is nothing visible: the
     * sheet has already shown the key. A thrown error here would surface as the
     * KEY having failed, which it did not.
     */
    const h = harness([{ id: 'personal-1', personal: true }]);
    const client: RecoveryNoteClient = {
      ...h.client,
      post: (async () => {
        throw new Error('network down');
      }) as RecoveryNoteClient['post'],
    };

    const r = await sendRecoveryNote(client, h.sealer, CODE, STRINGS);

    expect(r).toEqual({ kind: 'failed', reason: 'network down' });
  });

  it('EXTERNAL: a failed topic lookup is returned, not thrown', async () => {
    const h = harness([]);
    const client: RecoveryNoteClient = {
      ...h.client,
      get: (async () => {
        throw new Error('offline');
      }) as RecoveryNoteClient['get'],
    };

    const r = await sendRecoveryNote(client, h.sealer, CODE, STRINGS);

    expect(r.kind).toBe('failed');
  });
});

describe('recognising a note that is already there', () => {
  it('CONTRACT: a note built here is recognised', () => {
    expect(isRecoveryCodeNote(recoveryCodeNote(CODE, STRINGS))).toBe(true);
  });

  it('CONTRACT: an ordinary message is not', () => {
    expect(isRecoveryCodeNote('here is my recovery key: abcd')).toBe(false);
    expect(anyIsRecoveryNote(['hello', 'a key emoji 🔑 in the middle'])).toBe(false);
  });

  it('HOSTILE: a code containing the marker does not fool the check', () => {
    /*
     * The marker only means anything at the START of a note this app built. A
     * body that merely contains it — someone pasting one back, a code with an
     * emoji in it — must not be mistaken for one, or the real note is never
     * filed.
     */
    expect(isRecoveryCodeNote(`someone pasted 🔑 Your recovery key back`)).toBe(false);
  });

  it('EMPTY: nothing to check is not a match', () => {
    expect(anyIsRecoveryNote([])).toBe(false);
    expect(isRecoveryCodeNote('')).toBe(false);
  });
});
