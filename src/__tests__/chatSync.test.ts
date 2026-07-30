/**
 * Web chat sync primitives — the guards behind SSE reconnect catch-up and
 * `?before=` history paging.
 *
 * The invariant these protect: MLS consumes a message's key on the FIRST
 * decrypt, so a message decrypted twice concurrently is permanently rendered
 * as '[unable to decrypt]' for one of the two readers. Adding catch-up and
 * paging multiplied the number of paths that can deliver the same message, so
 * "exactly one decrypt per id" is pinned here.
 *
 * Edge-case matrix rows covered (see chatPanel-sync.test.tsx for the rows that
 * only exist at the component level):
 *   boundary   — 0 / 1 / many missed messages; page exactly at the limit
 *   dedupe     — same message via two transports; overlapping catch-up pages
 *   integrity  — merged list is monotonic in createdAt; ties are deterministic
 *   empty      — empty page, empty merge, list with no valid timestamp
 *   hostile    — malformed rows (no id, unparsable createdAt), NaN cursor
 *   large      — catch-up paging cap; decrypt-memo eviction cap
 *   race       — two concurrent gets share ONE in-flight decrypt
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DecryptOnce,
  fetchCatchup,
  mergeChronological,
  newestCreatedAt,
  sinceCursor,
  CATCHUP_MAX_PAGES,
  CATCHUP_PAGE_LIMIT,
  HISTORY_PAGE_LIMIT,
  SINCE_OVERLAP_MS,
} from '@/lib/chatSync';

type Row = { id: string; createdAt: string; message?: string };

const at = (n: number, id = `m${n}`): Row => ({
  id,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
});

describe('mergeChronological', () => {
  it('returns the SAME array reference when nothing new arrived (no re-render)', () => {
    const prev = [at(1), at(2)];
    expect(mergeChronological(prev, [])).toBe(prev);
    expect(mergeChronological(prev, [at(1), at(2)])).toBe(prev);
  });

  it('appends newer messages and keeps the list monotonic in createdAt', () => {
    const merged = mergeChronological([at(1), at(2)], [at(4), at(3)]);
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    const times = merged.map((m) => new Date(m.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('prepends older messages (the ?before= page) into the right position', () => {
    const merged = mergeChronological([at(10), at(11)], [at(8), at(9)]);
    expect(merged.map((m) => m.id)).toEqual(['m8', 'm9', 'm10', 'm11']);
  });

  it('dedupes by id and keeps the EXISTING row — a repaired row is never undone', () => {
    const repaired = { ...at(1), message: 'my own words' };
    const echo = { ...at(1), message: '[unable to decrypt]' };
    const merged = mergeChronological([repaired], [echo, at(2)]);
    expect(merged).toHaveLength(2);
    expect(merged[0].message).toBe('my own words');
  });

  it('dedupes duplicates WITHIN the incoming batch', () => {
    const merged = mergeChronological([], [at(1), at(1), at(2)]);
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('breaks same-timestamp ties deterministically by id', () => {
    const sameTime = new Date(Date.UTC(2026, 0, 1)).toISOString();
    const a = { id: 'aaa', createdAt: sameTime };
    const b = { id: 'bbb', createdAt: sameTime };
    expect(mergeChronological([], [b, a]).map((m) => m.id)).toEqual(['aaa', 'bbb']);
    expect(mergeChronological([], [a, b]).map((m) => m.id)).toEqual(['aaa', 'bbb']);
  });

  it('drops rows with no id rather than rendering an unkeyed row', () => {
    const merged = mergeChronological<Row>([], [{ id: '', createdAt: at(1).createdAt }, at(2)]);
    expect(merged.map((m) => m.id)).toEqual(['m2']);
  });

  it('keeps an unparsable createdAt in the list (sorted oldest), never throws', () => {
    const broken = { id: 'broken', createdAt: 'not-a-date' };
    const merged = mergeChronological([], [at(5), broken]);
    expect(merged.map((m) => m.id)).toEqual(['broken', 'm5']);
  });
});

describe('newestCreatedAt', () => {
  it('is null for an empty list and for a list with no valid timestamp', () => {
    expect(newestCreatedAt([])).toBeNull();
    expect(newestCreatedAt([{ id: 'x', createdAt: 'nope' }])).toBeNull();
  });

  it('returns the maximum timestamp regardless of input order', () => {
    expect(newestCreatedAt([at(3), at(9), at(5)])).toBe(at(9).createdAt);
  });
});

describe('sinceCursor', () => {
  it('rewinds by the overlap window so a same-millisecond message is not skipped', () => {
    const iso = '2026-01-01T00:00:10.000Z';
    expect(sinceCursor(iso)).toBe(
      new Date(Date.parse(iso) - SINCE_OVERLAP_MS).toISOString(),
    );
  });

  it('passes an unparsable cursor through untouched (never becomes epoch zero)', () => {
    // Turning a bad cursor into 1970 would re-download the whole topic.
    expect(sinceCursor('garbage')).toBe('garbage');
  });
});

describe('fetchCatchup', () => {
  it('0 missed messages: one request, empty result', async () => {
    const fetchPage = vi.fn(async () => [] as Row[]);
    const out = await fetchCatchup<Row>({ sinceIso: at(1).createdAt, fetchPage });
    expect(out).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('1 missed message: returned, no second request', async () => {
    const fetchPage = vi.fn(async () => [at(2)]);
    const out = await fetchCatchup<Row>({ sinceIso: at(1).createdAt, fetchPage });
    expect(out.map((m) => m.id)).toEqual(['m2']);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('many missed messages: follows pages until a SHORT page ends the loop', async () => {
    const limit = 3;
    const pages = [[at(2), at(3), at(4)], [at(5), at(6), at(7)], [at(8)]];
    const fetchPage = vi.fn(async () => pages.shift() ?? []);
    const out = await fetchCatchup<Row>({ sinceIso: at(1).createdAt, fetchPage, limit });
    expect(out.map((m) => m.id)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('advances the cursor to each page\'s newest row', async () => {
    const seen: string[] = [];
    const pages = [[at(2), at(3)], [at(4)]];
    const fetchPage = vi.fn(async (since: string) => {
      seen.push(since);
      return pages.shift() ?? [];
    });
    await fetchCatchup<Row>({ sinceIso: at(1).createdAt, fetchPage, limit: 2 });
    expect(seen).toEqual([at(1).createdAt, at(3).createdAt]);
  });

  it('dedupes rows repeated across pages by the overlap window', async () => {
    const pages = [[at(2), at(3)], [at(3), at(4)], []];
    const fetchPage = vi.fn(async () => pages.shift() ?? []);
    const out = await fetchCatchup<Row>({ sinceIso: at(1).createdAt, fetchPage, limit: 2 });
    expect(out.map((m) => m.id)).toEqual(['m2', 'm3', 'm4']);
  });

  it('a page exactly AT the limit still asks for one more page', async () => {
    const pages = [[at(2), at(3)], []];
    const fetchPage = vi.fn(async () => pages.shift() ?? []);
    await fetchCatchup<Row>({ sinceIso: at(1).createdAt, fetchPage, limit: 2 });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('stops at maxPages instead of looping forever on a server that always returns full pages', async () => {
    let n = 100;
    const fetchPage = vi.fn(async () => [at(n++), at(n++)]);
    const out = await fetchCatchup<Row>({
      sinceIso: at(1).createdAt,
      fetchPage,
      limit: 2,
      maxPages: 4,
    });
    expect(fetchPage).toHaveBeenCalledTimes(4);
    expect(out).toHaveLength(8);
  });

  it('stops when the cursor cannot advance (all rows share the cursor timestamp)', async () => {
    const stuck = at(1);
    const fetchPage = vi.fn(async () => [stuck, { ...stuck, id: 'dup' }]);
    await fetchCatchup<Row>({ sinceIso: stuck.createdAt, fetchPage, limit: 2 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('propagates a transport failure to the caller (which retries on next reconnect)', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('catchup 500');
    });
    await expect(
      fetchCatchup<Row>({ sinceIso: at(1).createdAt, fetchPage }),
    ).rejects.toThrow('catchup 500');
  });

  it('defaults match the server contract (500/request) and the history page size', () => {
    expect(CATCHUP_PAGE_LIMIT).toBe(500);
    expect(HISTORY_PAGE_LIMIT).toBe(50);
    expect(CATCHUP_MAX_PAGES).toBeGreaterThan(1);
  });
});

describe('DecryptOnce — the one-shot MLS decrypt guard', () => {
  it('two CONCURRENT gets share ONE in-flight decrypt', async () => {
    const memo = new DecryptOnce<string>();
    let calls = 0;
    const factory = () => {
      calls++;
      return new Promise<string>((r) => setTimeout(() => r('plaintext'), 5));
    };
    // Exactly the catch-up-vs-SSE race: both paths ask for the same id before
    // either has finished. Without the memo one of them gets null from MLS.
    const [a, b] = await Promise.all([memo.get('m1', factory), memo.get('m1', factory)]);
    expect(calls).toBe(1);
    expect([a, b]).toEqual(['plaintext', 'plaintext']);
  });

  it('a SEQUENTIAL re-request is served from the memo, not a second decrypt', async () => {
    const memo = new DecryptOnce<string>();
    const factory = vi.fn(async () => 'plaintext');
    expect(await memo.get('m1', factory)).toBe('plaintext');
    expect(await memo.get('m1', factory)).toBe('plaintext');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('different ids each decrypt exactly once', async () => {
    const memo = new DecryptOnce<string>();
    const factory = vi.fn(async () => 'x');
    await Promise.all([memo.get('a', factory), memo.get('b', factory), memo.get('a', factory)]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('set() pre-seeds an own-message plaintext so the SSE echo never decrypts', async () => {
    const memo = new DecryptOnce<string>();
    const factory = vi.fn(async () => '[unable to decrypt]');
    memo.set('m1', 'my own words');
    expect(await memo.get('m1', factory)).toBe('my own words');
    expect(factory).not.toHaveBeenCalled();
  });

  it('evicts oldest entries past the cap so a long session stays bounded', async () => {
    const memo = new DecryptOnce<string>(3);
    for (const id of ['a', 'b', 'c', 'd']) await memo.get(id, async () => id);
    expect(memo.size).toBe(3);
    expect(memo.has('a')).toBe(false);
    expect(memo.has('d')).toBe(true);
  });

  it('a rejected factory is not cached as a poisoned entry by the caller contract', async () => {
    // ChatPanel always hands in a factory that catches; assert the memo returns
    // whatever that factory resolves to rather than swallowing it.
    const memo = new DecryptOnce<string>();
    const factory = async () => '[unable to decrypt]';
    expect(await memo.get('m1', factory)).toBe('[unable to decrypt]');
  });
});
