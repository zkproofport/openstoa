/**
 * `backfill` must ask the device before it asks the server.
 *
 * The cache module has its own tests; this file covers the thing that actually
 * regressed, which no test of the module could see: whether anything CALLS it.
 * Before this, every room entry paged the whole archive out of the server and
 * re-decrypted every row, and because the rendered result was correct there was
 * nothing for a test or an error to catch. So these cases count round trips and
 * decryptions rather than checking the messages — the messages were never wrong.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TakSessionStore } from '../../packages/mls/src/takSession';
import type { ChatHistoryStore } from '../../packages/mls/src/chatHistoryCache';
import * as tak from '../../packages/mls/src/takClient';

class MemStore implements ChatHistoryStore {
  map = new Map<string, string>();
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.map.set(k, v);
  }
}

const TOPIC = 'topic-1';
const ROOT = new Uint8Array(32).fill(7);

interface Row {
  messageId: string;
  takVersion: number;
  ciphertext: string;
  createdAt: string;
}

function row(n: number, openable = true): Row {
  return {
    messageId: `m${String(n).padStart(4, '0')}`,
    takVersion: 0,
    ciphertext: openable ? `sealed-${n}` : `locked-${n}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  };
}

/** Counts what the room costs: server pages, and opens. */
function harness(rows: Row[]) {
  const calls: Array<{ since?: { createdAt: string; messageId: string } }> = [];
  let opens = 0;

  const transport = {
    async getArchive(_topicId: string, since?: { createdAt: string; messageId: string }) {
      calls.push({ since });
      if (!since) return rows;
      return rows.filter(
        (r) =>
          r.createdAt > since.createdAt ||
          (r.createdAt === since.createdAt && r.messageId > since.messageId),
      );
    },
    async postArchive() {},
    async postBundle() {},
    async getBundles() {
      return [];
    },
    async ackBundles() {},
    async getArchiveRoot() {
      return null;
    },
    async putArchiveRoot() {
      return { ok: true as const };
    },
    async getArchiveRootFingerprint() {
      return { fingerprint: null, archiveCount: 0 };
    },
    async claimArchiveRootFingerprint() {
      return { ok: true as const, fingerprint: '' };
    },
    async getMembers() {
      return [];
    },
  };

  // A room that already holds its root: this file is about the READ path, and a
  // root negotiation in the middle of it would count opens nobody asked for.
  const takStore = { get: async () => null, set: async () => {} };
  const mls = {} as never;

  vi.spyOn(tak, 'openArchive').mockImplementation(async (_k, _id, ct: string) => {
    opens += 1;
    return ct.startsWith('sealed-') ? `plain-${ct.slice('sealed-'.length)}` : null;
  });

  return { transport, takStore, mls, calls, opens: () => opens };
}

let history: MemStore;
beforeEach(() => {
  vi.restoreAllMocks();
  history = new MemStore();
});

/** Drives `backfill` with the root already resolved, so only the read path runs. */
async function runBackfill(h: ReturnType<typeof harness>, store: MemStore) {
  const s = new TakSessionStore(
    h.mls,
    h.transport as never,
    h.takStore as never,
    undefined,
    store,
  );
  // `public` resolves its root through the server, which this transport answers
  // with "none deposited" — so stub the resolution itself and keep the test on
  // the archive read.
  vi.spyOn(s as never as { resolveRoot: unknown }, 'resolveRoot' as never).mockResolvedValue({
    key: ROOT,
    state: 'verified',
  } as never);
  vi.spyOn(s as never as { getOrphanRoot: unknown }, 'getOrphanRoot' as never).mockResolvedValue(
    null as never,
  );
  vi.spyOn(s as never as { ingestBundles: unknown }, 'ingestBundles' as never).mockResolvedValue(
    undefined as never,
  );
  return s.backfill(TOPIC, 'public');
}

describe('CONTRACT: the second visit does not re-read the conversation', () => {
  it('asks the server for everything once, then only for the delta', async () => {
    const rows = [row(1), row(2), row(3)];
    const h = harness(rows);

    const first = await runBackfill(h, history);
    expect(first.map((m) => m.messageId)).toEqual(['m0001', 'm0002', 'm0003']);
    expect(h.calls[0].since).toBeUndefined();
    expect(h.opens()).toBe(3);

    // Re-entering the room. Nothing new has arrived.
    const second = await runBackfill(h, history);
    // The cursor went out, so the server returned nothing...
    expect(h.calls[1].since).toEqual({ createdAt: rows[2].createdAt, messageId: 'm0003' });
    // ...and this is the assertion the whole file exists for: no message was
    // opened a second time. Remove the cache read from `backfill` and it is 6.
    expect(h.opens()).toBe(3);
    // The room still renders everything.
    expect(second.map((m) => m.messageId)).toEqual(['m0001', 'm0002', 'm0003']);
  });

  it('opens only what arrived since, and returns it alongside the cached rows', async () => {
    const rows = [row(1), row(2)];
    const h = harness(rows);
    await runBackfill(h, history);
    expect(h.opens()).toBe(2);

    rows.push(row(3), row(4));
    const second = await runBackfill(h, history);

    expect(h.opens()).toBe(4); // two more, not four more
    expect(second.map((m) => m.messageId)).toEqual(['m0001', 'm0002', 'm0003', 'm0004']);
  });

  it('EMPTY: an empty archive caches nothing and stays a full read', async () => {
    const h = harness([]);
    await expect(runBackfill(h, history)).resolves.toEqual([]);
    await runBackfill(h, history);
    expect(h.calls[1].since).toBeUndefined();
  });

  it('EXTERNAL FAILURE: no history store means the old behaviour, not a crash', async () => {
    const h = harness([row(1), row(2)]);
    const s = new TakSessionStore(h.mls, h.transport as never, h.takStore as never);
    vi.spyOn(s as never as { resolveRoot: unknown }, 'resolveRoot' as never).mockResolvedValue({
      key: ROOT,
      state: 'verified',
    } as never);
    vi.spyOn(s as never as { getOrphanRoot: unknown }, 'getOrphanRoot' as never).mockResolvedValue(
      null as never,
    );
    vi.spyOn(s as never as { ingestBundles: unknown }, 'ingestBundles' as never).mockResolvedValue(
      undefined as never,
    );

    await expect(s.backfill(TOPIC, 'public')).resolves.toHaveLength(2);
    await expect(s.backfill(TOPIC, 'public')).resolves.toHaveLength(2);
    expect(h.calls.every((c) => c.since === undefined)).toBe(true);
  });
});

describe('INTEGRITY: the cursor never steps over a row that stayed locked', () => {
  it('stops the cursor at the first row this device could not open', async () => {
    // Row 2 is sealed under an epoch this device was not present for. Advancing
    // past it would skip it on every future visit, and the message would sit
    // locked forever while the key it was waiting for arrived and went unused.
    const rows = [row(1), row(2, false), row(3)];
    const h = harness(rows);

    const first = await runBackfill(h, history);
    expect(first.map((m) => m.messageId)).toEqual(['m0001', 'm0003']);

    await runBackfill(h, history);
    // The cursor sits at row 1, NOT row 3.
    expect(h.calls[1].since).toEqual({ createdAt: rows[0].createdAt, messageId: 'm0001' });
  });

  it('the locked row is opened as soon as its key arrives', async () => {
    const rows = [row(1), row(2, false), row(3)];
    const h = harness(rows);
    await runBackfill(h, history);

    // The key turns up: the same row is now openable.
    rows[1] = row(2);
    const after = await runBackfill(h, history);

    expect(after.map((m) => m.messageId)).toEqual(['m0001', 'm0002', 'm0003']);
    // And now the cursor may run to the end.
    await runBackfill(h, history);
    expect(h.calls[2].since).toEqual({ createdAt: rows[2].createdAt, messageId: 'm0003' });
  });

  it('a run of rows that never open leaves the cursor where it was', async () => {
    const rows = [row(1), row(2, false), row(3, false)];
    const h = harness(rows);
    await runBackfill(h, history);
    await runBackfill(h, history);
    expect(h.calls[1].since).toEqual({ createdAt: rows[0].createdAt, messageId: 'm0001' });
  });
});
