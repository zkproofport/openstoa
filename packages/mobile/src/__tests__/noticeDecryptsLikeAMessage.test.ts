/*
 * A notice is sealed like a message, so it must decrypt like one.
 *
 * SEEN ON A PHONE, 2026-08-27. The recovery-code notice arrived in the person's
 * own room, on the correct (received) side — and the bubble was EMPTY. Not
 * "Waiting for the key…", not an error: nothing. `toDisplayMessageMls` gated its
 * whole decrypt-and-cache path on `type === 'message'`, so a notice skipped the
 * cache lookup entirely and fell through with an empty body.
 *
 * The two halves of a notice pull in opposite directions and both have to be
 * right: it is NOT from the person (so: received side, no author name) but it IS
 * sealed the same way (so: same decryption, same cache). Fixing only the first
 * is what produced an empty bubble with nobody's name on it.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → a notice's cached plaintext is returned
 *   contract  → a message still decrypts (the fix must not narrow the gate)
 *   integrity → an unopenable notice says so, rather than rendering empty
 *   boundary  → join/leave rows are NOT sent down the decrypt path
 *   race      → N notices in a row each resolve independently
 */
import { describe, it, expect, vi } from 'vitest';

import { toDisplayMessageMls, UNREADABLE_BODY } from '../crypto/mobileTransport';
import type { ChatMessage } from '@openstoa/api-types';

const TOPIC = 'topic-1';

/** An MLS store that answers from a fixed table, recording what it was asked. */
function store(table: Record<string, string | null>) {
  const asked: string[] = [];
  return {
    asked,
    store: {
      openCached: vi.fn(async (_t: string, msgId: string) => {
        asked.push(msgId);
        return table[msgId] ?? null;
      }),
      open: vi.fn(async () => null),
    } as never,
  };
}

const row = (over: Partial<ChatMessage>): ChatMessage =>
  ({
    id: 'm1',
    topicId: TOPIC,
    userId: 'user-me',
    nickname: 'me',
    type: 'message',
    createdAt: new Date().toISOString(),
    sealed: { ciphertext: 'sealed', epoch: 1 },
    ...over,
  }) as ChatMessage;

describe('a notice decrypts by the same path as a message', () => {
  it('CONTRACT: a cached notice renders its text', async () => {
    // The defect exactly: this used to come back empty because the gate named
    // `message` alone.
    const s = store({ m1: '🔑 Your recovery key\n\nBIXR-UGUZ' });
    const out = await toDisplayMessageMls(s.store, TOPIC, row({ type: 'notice' }));

    expect(out.message).toContain('BIXR-UGUZ');
    expect(s.asked).toEqual(['m1']);
  });

  it('CONTROL: a message still decrypts', async () => {
    // Widening the gate must not have narrowed it. A fix that swapped one type
    // for the other would pass the case above and break every room.
    const s = store({ m1: 'hello' });
    const out = await toDisplayMessageMls(s.store, TOPIC, row({ type: 'message' }));
    expect(out.message).toBe('hello');
  });

  it('INTEGRITY: an unopenable notice SAYS so rather than rendering empty', async () => {
    /*
     * An empty bubble and a locked bubble look different to a person and mean
     * different things. Empty says "there is nothing here"; locked says "there
     * is something and this device cannot read it" — which is the truth, and the
     * only one of the two that leads anywhere.
     */
    const s = store({ m1: null });
    const out = await toDisplayMessageMls(s.store, TOPIC, row({ type: 'notice' }));
    expect(out.message).toBe(UNREADABLE_BODY);
    expect(out.message).not.toBe('');
    // The store WAS consulted — otherwise this passes for the wrong reason: a
    // row that never reached the decrypt path also fails to equal ''.
    expect(s.asked).toEqual(['m1']);
  });

  it('INTEGRITY: an unopenable MESSAGE says so too', async () => {
    /*
     * Added after a mutation survived: replacing `opened ?? UNREADABLE_BODY`
     * with `opened ?? ''` killed nothing, because the only unopenable case here
     * was a notice and the assertion did not pin which branch produced the
     * placeholder. Both types travel the same line; both are checked.
     */
    const s = store({ m1: null });
    const out = await toDisplayMessageMls(s.store, TOPIC, row({ type: 'message' }));
    expect(out.message).toBe(UNREADABLE_BODY);
    expect(s.asked).toEqual(['m1']);
  });

  it.each(['join', 'leave'])('BOUNDARY: a %s row is not sent down the decrypt path', async (type) => {
    // Those carry public text in `message` and have no sealed body; asking the
    // MLS store about them would burn a lookup and could churn state.
    const s = store({ m1: 'should not be used' });
    await toDisplayMessageMls(s.store, TOPIC, row({ type: type as never, sealed: null }));
    expect(s.asked).toEqual([]);
  });

  it('RACE: five notices in a row each resolve to their own text', async () => {
    /*
     * The accumulating axis. One notice passing proves the branch runs; it does
     * not prove each row is looked up by its OWN id — a shared-key mistake would
     * give five bubbles the same body, which reads as "my messages are all the
     * same" rather than as a bug.
     */
    const table: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) table[`m${i}`] = `notice ${i}`;
    const s = store(table);

    const out = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        toDisplayMessageMls(s.store, TOPIC, row({ id: `m${i}`, type: 'notice' })),
      ),
    );

    expect(out.map((o) => o.message)).toEqual([
      'notice 1',
      'notice 2',
      'notice 3',
      'notice 4',
      'notice 5',
    ]);
  });
});
