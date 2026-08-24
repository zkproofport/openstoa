/**
 * Open a message once. Not once per screen — once.
 *
 * THE COMPLAINT: "왜 방 진입할 때마다 복호화를 하냐고? 한번하고 캐싱해서
 * 재사용하면 되지." It was right, and the reason was not the obvious one.
 *
 * The plaintext WAS cached, and MLS was never asked to decrypt the same message
 * twice. But the cache is sealed at rest — chat plaintext must not sit on the
 * filesystem readable — so every hit went through `EncryptingKVStore.get`,
 * which opens each value it returns. A cache hit therefore cost one storage
 * read and one AES open, PER MESSAGE. Re-entering a fifty-message room paid
 * that fifty times before drawing a single bubble.
 *
 * So the cost was real and the diagnosis "we re-decrypt every time" was
 * accurate — just one layer down from where anyone was looking. These cases
 * count STORAGE READS, because the plaintext was never wrong and content
 * assertions could not have seen this.
 *
 * Matrix rows: contract (a repeat open touches nothing), boundary (first open
 * still reads; a miss still decrypts), integrity (the memo never crosses topics
 * or messages), external failure (an unreadable store is a decrypt, not a
 * crash), race (two concurrent opens of the same id). N/A: UTF-8 and
 * very-large, which are the store's business and are covered where it is
 * tested; authz, because this layer has no caller identity.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MlsSessionStore } from '../../packages/mls/src/mlsSession';

/** Counts what the durable cache is asked to do. */
class CountingStore {
  map = new Map<string, string>();
  reads: string[] = [];
  writes: string[] = [];
  failReads = false;
  async get(k: string) {
    this.reads.push(k);
    if (this.failReads) throw new Error('store unreadable');
    return this.map.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.writes.push(k);
    this.map.set(k, v);
  }
}

const TOPIC = 'topic-1';
const OTHER_TOPIC = 'topic-2';
const sealed = (n: number) => ({ ciphertext: `ct${n}`, epoch: 0 }) as never;

let cache: CountingStore;
let store: MlsSessionStore;
let mlsOpens: string[];

beforeEach(() => {
  cache = new CountingStore();
  mlsOpens = [];
  store = new MlsSessionStore(
    {} as never,
    { userId: 'u', deviceId: 'd' } as never,
    new CountingStore() as never,
    cache as never,
    () => 'u',
  );
  // The MLS open itself — the expensive half, and the one that can only ever
  // run once per message because forward secrecy eats the key.
  vi.spyOn(store, 'open').mockImplementation(async (_t: string, s: { ciphertext: string }) => {
    mlsOpens.push(s.ciphertext);
    return `plain:${s.ciphertext}`;
  });
});

describe('CONTRACT: the second open costs nothing', () => {
  it('reads the store once for a message, however many times it is opened', async () => {
    await store.openCached(TOPIC, 'm1', sealed(1));
    const afterFirst = cache.reads.length;

    // Re-entering the room: the same rows, opened again.
    await store.openCached(TOPIC, 'm1', sealed(1));
    await store.openCached(TOPIC, 'm1', sealed(1));

    // Delete the memo and this becomes 3.
    expect(cache.reads.length).toBe(afterFirst);
    expect(mlsOpens).toEqual(['ct1']);
  });

  it('a whole room re-opens without touching the store', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `m${i}`);
    for (const [i, id] of ids.entries()) await store.openCached(TOPIC, id, sealed(i));
    const afterFirstVisit = cache.reads.length;

    // Second visit. This is the one that used to cost fifty reads and fifty
    // AES opens before the room drew anything.
    for (const [i, id] of ids.entries()) await store.openCached(TOPIC, id, sealed(i));

    expect(cache.reads.length).toBe(afterFirstVisit);
  });

  it('BOUNDARY: the FIRST open still reads, and still decrypts on a miss', async () => {
    // Guards the fix from over-correcting into "never ask the store anything".
    const text = await store.openCached(TOPIC, 'm9', sealed(9));
    expect(text).toBe('plain:ct9');
    expect(cache.reads.length).toBeGreaterThan(0);
    expect(mlsOpens).toEqual(['ct9']);
  });

  it('BOUNDARY: a value already in the store is served without an MLS open', async () => {
    // A restart: the durable cache has it, this process has not seen it.
    const fresh = new MlsSessionStore(
      {} as never,
      { userId: 'u', deviceId: 'd' } as never,
      new CountingStore() as never,
      cache as never,
      () => 'u',
    );
    const opens: string[] = [];
    vi.spyOn(fresh, 'open').mockImplementation(async (_t: string, s: { ciphertext: string }) => {
      opens.push(s.ciphertext);
      return `plain:${s.ciphertext}`;
    });
    await store.openCached(TOPIC, 'm1', sealed(1));

    expect(await fresh.openCached(TOPIC, 'm1', sealed(1))).toBe('plain:ct1');
    expect(opens, 'a restart must read the store, not re-run MLS').toEqual([]);
  });
});

describe('INTEGRITY: the memo is keyed by what it is about', () => {
  it('does not serve one message under another id', async () => {
    await store.openCached(TOPIC, 'm1', sealed(1));
    expect(await store.openCached(TOPIC, 'm2', sealed(2))).toBe('plain:ct2');
  });

  it('does not serve one topic under another', async () => {
    // The same message id in two rooms is not the same message.
    await store.openCached(TOPIC, 'm1', sealed(1));
    expect(await store.openCached(OTHER_TOPIC, 'm1', sealed(7))).toBe('plain:ct7');
    expect(mlsOpens).toEqual(['ct1', 'ct7']);
  });

  it('a message that will not open is not memoised as readable', async () => {
    // Otherwise a key that arrives later could never be used: the row would
    // stay locked forever behind a memoised failure.
    vi.spyOn(store, 'open').mockResolvedValueOnce(null as never);
    expect(await store.openCached(TOPIC, 'later', sealed(1))).toBeNull();

    vi.spyOn(store, 'open').mockResolvedValueOnce('plain:arrived' as never);
    expect(await store.openCached(TOPIC, 'later', sealed(1))).toBe('plain:arrived');
  });
});

describe('the sender path', () => {
  it('a message this device SENT is readable without a storage read', async () => {
    // MLS cannot open its own application message, so this is the one plaintext
    // that only exists because the sender put it there.
    await store.cachePlaintext(TOPIC, 'mine', 'what I said');
    const before = cache.reads.length;

    expect(await store.openCached(TOPIC, 'mine', sealed(1))).toBe('what I said');
    expect(cache.reads.length, 'a sent message must not cost a lookup').toBe(before);
    expect(mlsOpens).toEqual([]);
  });
});

describe('EXTERNAL FAILURE and RACE', () => {
  it('an unreadable store falls through to a decrypt rather than throwing', async () => {
    cache.failReads = true;
    await expect(store.openCached(TOPIC, 'm1', sealed(1))).resolves.toBe('plain:ct1');
  });

  it('two concurrent opens of the same message both resolve', async () => {
    const [a, b] = await Promise.all([
      store.openCached(TOPIC, 'm1', sealed(1)),
      store.openCached(TOPIC, 'm1', sealed(1)),
    ]);
    expect(a).toBe('plain:ct1');
    expect(b).toBe('plain:ct1');
  });
});
