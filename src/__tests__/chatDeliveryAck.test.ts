/**
 * The client half of the delivery cursor: what a device may claim, and what a
 * failed claim is allowed to do.
 *
 * Both matter for the same reason. The mark releases the server's only live
 * copy of a message, so claiming too much loses messages — and this runs after
 * the rows are already on screen, so throwing loses a history the user can see.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   boundary          → 0 / 1 / many rows; rows out of order; equal timestamps
 *   integrity         → the mark is the NEWEST row, never `now`, never the last
 *                       element of an unsorted array
 *   empty             → an empty batch claims nothing (asserted separately from
 *                       a batch whose timestamps are all unparsable)
 *   hostile input     → unparsable, empty and far-future timestamps; one bad row
 *                       cannot drag the mark backwards
 *   ext-failure       → a rejected POST, a rejected device-id lookup and an
 *                       empty device id each resolve null rather than throw
 *   contract          → the request carries the topic, the device and the mark;
 *                       nothing is sent when there is nothing to claim
 *   UTF-8 / large     → N/A: the payload is a device id and a timestamp, both
 *                       validated at the route (see chatDelivered-route.test.ts)
 *   authorization     → N/A at this layer: the cookie carries identity and the
 *                       route binds the device to the account
 *   race              → N/A here; two concurrent acks converge on the server,
 *                       asserted in chatDelivered-route.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { nextPendingId } from '@/lib/chatStatus';
import { ackDelivery, claimable, deliveryMarkOf } from '@/lib/chatDeliveryAck';

const at = (iso: string) => ({ createdAt: iso });

describe('deliveryMarkOf', () => {
  it('BOUNDARY: one row is its own mark', () => {
    expect(deliveryMarkOf([at('2026-08-14T00:00:00.000Z')])).toBe('2026-08-14T00:00:00.000Z');
  });

  it('INTEGRITY: the NEWEST row wins, whatever order they arrive in', () => {
    // History pages arrive newest-first and catch-up pages oldest-first, so
    // "the last element" is not the same thing as "the newest".
    const rows = [at('2026-08-10T00:00:00.000Z'), at('2026-08-14T00:00:00.000Z'), at('2026-08-12T00:00:00.000Z')];
    expect(deliveryMarkOf(rows)).toBe('2026-08-14T00:00:00.000Z');
    expect(deliveryMarkOf([...rows].reverse())).toBe('2026-08-14T00:00:00.000Z');
  });

  it('EMPTY: no rows claims nothing — NOT the current instant', () => {
    /*
     * Claiming `now` for an empty room would release a message that lands in
     * the same millisecond, which is the one case where the client could lose a
     * message it never saw.
     */
    expect(deliveryMarkOf([])).toBeNull();
  });

  it('HOSTILE: an unparsable timestamp cannot drag the mark backwards', () => {
    const rows = [at('2026-08-14T00:00:00.000Z'), at('not a date'), at('')];
    expect(deliveryMarkOf(rows)).toBe('2026-08-14T00:00:00.000Z');
  });

  it('EMPTY: a batch of only-unparsable rows claims nothing', () => {
    // Distinct from the empty batch above: there ARE rows, and still nothing
    // that can honestly be claimed.
    expect(deliveryMarkOf([at('nope'), at('')])).toBeNull();
  });

  it('BOUNDARY: equal timestamps resolve to that instant, not to a later one', () => {
    const same = '2026-08-14T00:00:00.000Z';
    expect(deliveryMarkOf([at(same), at(same)])).toBe(same);
  });

  it('a far-future row is claimed verbatim — the SERVER clamps it, not the client', () => {
    // One authority for the clock. A client that clamped locally would disagree
    // with the server's clamp and re-ack forever.
    expect(deliveryMarkOf([at('9999-01-01T00:00:00.000Z')])).toBe('9999-01-01T00:00:00.000Z');
  });
});

describe('which rows may be claimed at all', () => {
  /*
   * Both of these arrive in the same array as good rows, and acking either is a
   * data-loss bug rather than a cosmetic one — the mark is what releases the
   * server's only live copy.
   */
  it('INTEGRITY: an UNDECRYPTABLE row is never claimed', () => {
    // Telling the server "delivered" for ciphertext this device could not read
    // is how the purge deletes the copy the device is still waiting for.
    expect(claimable({ createdAt: '2026-08-14T00:00:00.000Z', undecryptable: true })).toBe(false);
    expect(
      deliveryMarkOf([
        { createdAt: '2026-08-14T00:00:00.000Z', undecryptable: true },
        { createdAt: '2026-08-10T00:00:00.000Z' },
      ]),
    ).toBe('2026-08-10T00:00:00.000Z');
  });

  it('INTEGRITY: a PROVISIONAL row is never claimed', () => {
    // An optimistic send and a restored failed attachment both carry a
    // locally-minted id for a row the server has never seen.
    const local = nextPendingId();
    expect(claimable({ createdAt: '2026-08-14T00:00:00.000Z', id: local })).toBe(false);
    expect(
      deliveryMarkOf([
        { createdAt: '2026-08-14T00:00:00.000Z', id: local },
        { createdAt: '2026-08-09T00:00:00.000Z', id: 'server-uuid' },
      ]),
    ).toBe('2026-08-09T00:00:00.000Z');
  });

  it('a restored failed attachment cannot advance the mark with its OLD timestamp', () => {
    /*
     * The specific shape raised in review: a restored attachment's `createdAt`
     * is the time of the FAILED SEND — client-supplied and possibly hours old.
     * It is excluded because it is provisional, not because of its timestamp.
     */
    expect(deliveryMarkOf([{ createdAt: '2026-01-01T00:00:00.000Z', id: nextPendingId() }])).toBeNull();
  });

  it('BOUNDARY: a batch of ONLY unclaimable rows claims nothing', () => {
    expect(
      deliveryMarkOf([
        { createdAt: '2026-08-14T00:00:00.000Z', undecryptable: true },
        { createdAt: '2026-08-13T00:00:00.000Z', id: nextPendingId() },
      ]),
    ).toBeNull();
  });

  it('an ordinary server row with neither flag is claimable', () => {
    expect(claimable({ createdAt: '2026-08-14T00:00:00.000Z', id: 'server-uuid' })).toBe(true);
  });
});

describe('ackDelivery', () => {
  const deviceId = () => Promise.resolve('leaf-abc');

  it('CONTRACT: posts the topic, the device and the newest instant', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const sent = await ackDelivery('t1', [at('2026-08-10T00:00:00.000Z'), at('2026-08-14T00:00:00.000Z')], {
      deviceId,
      post,
    });
    expect(sent).toBe('2026-08-14T00:00:00.000Z');
    expect(post).toHaveBeenCalledWith('t1', 'leaf-abc', '2026-08-14T00:00:00.000Z');
  });

  it('CONTRACT: nothing to claim → nothing is sent', async () => {
    const post = vi.fn();
    expect(await ackDelivery('t1', [], { deviceId, post })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('EXT-FAILURE: a refused POST resolves null rather than throwing', async () => {
    /*
     * By the time this runs the messages are on screen. A failed ack costs some
     * server storage until the next pass; a thrown one would break a read that
     * already succeeded.
     */
    const post = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(ackDelivery('t1', [at('2026-08-14T00:00:00.000Z')], { deviceId, post })).resolves.toBeNull();
  });

  it('EXT-FAILURE: an unavailable device id resolves null rather than throwing', async () => {
    // No MLS state yet (a room opened before the group is bootstrapped).
    const post = vi.fn();
    const failing = () => Promise.reject(new Error('no group state'));
    await expect(
      ackDelivery('t1', [at('2026-08-14T00:00:00.000Z')], { deviceId: failing, post }),
    ).resolves.toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('EXT-FAILURE: an EMPTY device id claims nothing', async () => {
    // An empty leaf id would be stored as a device the server can never match
    // to a real one, and would then block purges forever.
    const post = vi.fn();
    expect(await ackDelivery('t1', [at('2026-08-14T00:00:00.000Z')], { deviceId: async () => '', post })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('shared rule', () => {
  it('is BYTE-IDENTICAL to the mini-app copy, so both clients claim the same instant', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const web = readFileSync(join(process.cwd(), 'src/lib/chatDeliveryAck.ts'), 'utf8');
    const mobile = readFileSync(join(process.cwd(), 'packages/mobile/src/lib/chatDeliveryAck.ts'), 'utf8');
    expect(mobile).toBe(web);
  });

  it('carries no transport, so neither client can import the other\'s', () => {
    // The rule is shared; the POST is not. A `fetch` in here would make the
    // file unusable in the mini-app and the twin would drift on the next edit.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const src = readFileSync('src/lib/chatDeliveryAck.ts', 'utf8');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('credentials');
  });
});
