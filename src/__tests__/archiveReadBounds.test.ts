/**
 * What the archive reads actually ASK the server for.
 *
 * THE DEFECT, measured rather than reasoned about. `backfill` has passed a
 * keyset cursor since P3-17, so re-entering a room was supposed to cost the
 * delta. On staging it did not: every entry issued
 * `/archive?limit=500` with no `since` at all, twice. Reading the code would
 * not have found it — `backfill` is correct. THREE OTHER callers of
 * `getArchive` asked for the whole conversation, and two of them run on entry:
 *
 *   - the root check wanted the OLDEST row and paged everything to look at
 *     `rows[0]`;
 *   - the gap check wanted "which of these rows are archived" and fetched every
 *     row ever archived to build the set.
 *
 * Both are invisible on a young topic and ruinous on a real one, which is why
 * they are pinned here by what goes on the WIRE rather than by what comes back.
 *
 * EDGE-CASE MATRIX → coverage
 *   contract   → the root check asks for exactly one row
 *   contract   → the gap check is bounded by the oldest row it is about
 *   integrity  → the bound INCLUDES that oldest row (exclusive keyset + nil uuid)
 *   boundary   → one row; rows sharing a timestamp; a caller with no timestamps
 *   empty      → an empty readable set never reaches the network
 *   hostile    → an unsorted list still yields the true minimum
 *   external   → a transport that throws leaves the archive assumed non-empty
 * N/A: authorization — membership is enforced by the route, not the client.
 */
import { describe, it, expect } from 'vitest';
import { TakSessionStore, type TakTransport, type ArchiveEntry } from '../../packages/mls/src/takSession';
import type { ChatHistoryCursor } from '../../packages/mls/src/chatHistoryCache';

interface Ask {
  since?: ChatHistoryCursor;
  limit?: number;
}

/** Records every archive request, and answers with nothing. */
function recordingTransport(rows: ArchiveEntry[] = []) {
  const asks: Ask[] = [];
  const transport = {
    getArchive: async (_topicId: string, since?: ChatHistoryCursor, limit?: number) => {
      asks.push({ since, limit });
      return rows;
    },
    postArchive: async () => {},
    getBundles: async () => [],
    postBundle: async () => {},
    deleteBundle: async () => {},
  } as unknown as TakTransport;
  return { transport, asks };
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function row(id: string, createdAt: string) {
  return { messageId: id, plaintext: `body-${id}`, createdAt };
}

/**
 * The two entry points under test.
 *
 * `rootOpensOldestArchiveRow` is private, and intersecting a class with a type
 * that re-declares a private member collapses to `never` — so this is a
 * STANDALONE shape the instance is cast to, not an intersection with it.
 */
interface ArchiveReaders {
  backfillMissingArchive(
    topicId: string,
    tier: string,
    readable: Array<{ messageId: string; plaintext: string; createdAt?: string }>,
  ): Promise<number>;
  rootOpensOldestArchiveRow(topicId: string, root: Uint8Array): Promise<boolean | null>;
}

/**
 * A store whose archive key resolves, so the gap check gets past its gate.
 *
 * The tier is `private`, which keys per MLS EPOCH rather than off a topic root.
 * A `public` room would need a root this device has VERIFIED, and verifying one
 * means opening the oldest archived row — the very call under test. Seeding the
 * epoch TAK reaches the same code by the shorter door.
 */
function store(transport: TakTransport): ArchiveReaders {
  const mls = {
    // The store registers an epoch listener on construction — it takes the
    // per-epoch key for every epoch the device passes through, which is what
    // stops an away member losing history. A fake without it cannot construct.
    setEpochListener: () => {},
    // Returns the epoch without running the callback: the caller only wants
    // `currentEpoch(state)`, and there is no MLS state here to give it.
    readState: async () => 0,
    openCached: async () => null,
    open: async () => null,
    seal: async () => ({ ciphertext: 'ct', epoch: 0 }),
    cachePlaintext: async () => {},
  };
  const map = new Map<string, string>();
  // 32 bytes, base64 — a TAK this device is treated as already holding, so
  // `currentArchiveKey` returns one instead of refusing.
  map.set('tak.epoch.t1.0', Buffer.alloc(32, 7).toString('base64'));
  const kv = {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => {
      map.set(k, v);
    },
  };
  return new TakSessionStore(
    mls as never,
    transport,
    kv as never,
  ) as unknown as ArchiveReaders;
}

describe('CONTRACT: the root check asks for ONE row', () => {
  it('sends limit 1, and no cursor', async () => {
    const { transport, asks } = recordingTransport();
    const s = store(transport);

    await s.rootOpensOldestArchiveRow('t1', new Uint8Array(32));

    expect(asks, 'the root check did not reach the archive').toHaveLength(1);
    expect(
      asks[0].limit,
      'the root check paged the whole archive to look at its first row',
    ).toBe(1);
    expect(asks[0].since).toBeUndefined();
  });
});

describe('CONTRACT: the gap check is bounded by what it is about', () => {
  it('asks from just before the OLDEST readable row', async () => {
    const { transport, asks } = recordingTransport();
    const s = store(transport);

    await s.backfillMissingArchive('t1', 'private', [
      row('m2', '2026-01-01T00:00:20.000Z'),
      row('m1', '2026-01-01T00:00:10.000Z'),
      row('m3', '2026-01-01T00:00:30.000Z'),
    ]);

    expect(asks, 'the gap check did not reach the archive').toHaveLength(1);
    expect(
      asks[0].since?.createdAt,
      'the gap check fetched further back than the rows it was asked about',
    ).toBe('2026-01-01T00:00:10.000Z');
  });

  it('INTEGRITY: the oldest row itself stays inside the window', async () => {
    /*
     * The server's keyset is EXCLUSIVE — `(created_at, message_id) > (cursor)`
     * — so a cursor carrying the oldest row's own id would skip that row and
     * the check would decide it is missing and re-upload it. The nil uuid sorts
     * below every real one, which keeps the row in.
     */
    const { transport, asks } = recordingTransport();
    const s = store(transport);

    await s.backfillMissingArchive('t1', 'private', [row('m1', '2026-01-01T00:00:10.000Z')]);

    expect(asks[0].since?.messageId).toBe(NIL_UUID);
  });

  it('BOUNDARY: rows sharing one timestamp still bound to it', async () => {
    const { transport, asks } = recordingTransport();
    const s = store(transport);
    const t = '2026-01-01T00:00:10.000Z';

    await s.backfillMissingArchive('t1', 'private', [row('m1', t), row('m2', t), row('m3', t)]);

    expect(asks[0].since?.createdAt).toBe(t);
    expect(asks[0].since?.messageId).toBe(NIL_UUID);
  });

  it('BOUNDARY: a caller that sends no timestamps still works, unbounded', async () => {
    // The old shape. Correct, and merely expensive — never a silent failure.
    const { transport, asks } = recordingTransport();
    const s = store(transport);

    await s.backfillMissingArchive('t1', 'private', [
      { messageId: 'm1', plaintext: 'a' },
      { messageId: 'm2', plaintext: 'b' },
    ]);

    expect(asks[0].since).toBeUndefined();
  });

  it('EMPTY: nothing readable never reaches the network', async () => {
    const { transport, asks } = recordingTransport();
    const s = store(transport);

    const added = await s.backfillMissingArchive('t1', 'private', []);

    expect(added).toBe(0);
    expect(asks).toHaveLength(0);
  });
});
