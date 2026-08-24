// @vitest-environment jsdom
/**
 * One in-flight GET per URL — and never a stale one.
 *
 * WHAT IT REMOVES. Opening a topic mounts components that each fetch the same
 * thing: `/api/topics/{id}` twice (`TopicPageClient`, `ChatPanel`),
 * `/api/topics/{id}/members` twice (`ChatPanel`, `ChatRail`), `/api/tags` twice
 * and `/api/topics` twice. The first of those costs 441ms on staging, so the
 * page paid it twice for one answer.
 *
 * WHAT IT MUST NOT BECOME. A cache with a lifetime is a cache with an
 * invalidation bug waiting in it — a member list that no longer matches the
 * room, a topic whose name changed. The window here is sized for ONE MOUNT, so
 * "share" and "stale" cannot overlap, and the tests below pin both ends of that:
 * callers within the window join, callers after it do not.
 *
 * EDGE-CASE MATRIX → coverage
 *   contract   → concurrent callers issue one request and all get the body
 *   contract   → a caller after the window issues a fresh request
 *   integrity  → different URLs never share a response
 *   hostile    → a differing query string is a different request
 *   boundary   → exactly at the window edge; an empty URL
 *   race       → a rejection is not retained; the next caller retries
 *   external   → the rejection reaches every caller already waiting
 *   contract   → each caller can read the body independently (clone)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));

/*
 * Imported FRESH per test, not once at the top.
 *
 * The global setup file (`setup/resetClientCaches.ts`) imports this module to
 * reset it between tests, which instantiates it against the REAL `apiFetch`
 * before this file's `vi.mock` is applied — so a top-level import here shares
 * that instance and the mock never takes effect. The symptom is not a missing
 * mock but an `AbortSignal` type error from the real timeout wrapper meeting
 * jsdom.
 */
type CacheModule = typeof import('@/lib/requestCache');
let sharedGet: CacheModule['sharedGet'];

/** A Response whose body can only be read once, like the real thing. */
function res(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(async () => {
  fetchMock.mockReset();
  vi.useRealTimers();
  vi.resetModules();
  const mod = await import('@/lib/requestCache');
  sharedGet = mod.sharedGet;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CONTRACT: one request, every caller answered', () => {
  it('concurrent callers issue ONE request and all read the body', async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((r) => { release = r; }));

    const all = Promise.all([
      sharedGet('/api/topics/t1'),
      sharedGet('/api/topics/t1'),
      sharedGet('/api/topics/t1'),
    ]);
    release(res({ topic: { id: 't1' } }));
    const responses = await all;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Each caller reads its OWN body: a shared Response would let the first
    // reader consume it and leave the others with a locked stream.
    for (const r of responses) {
      await expect(r.json()).resolves.toEqual({ topic: { id: 't1' } });
    }
  });

  it('a settled response is NEVER reused', async () => {
    /*
     * The guarantee that keeps this from being a cache. An earlier version held
     * settled entries for two seconds and immediately started answering a
     * second mount with the first mount's data — a member list that no longer
     * matched the room. Nothing is retained past the moment it resolves.
     */
    fetchMock.mockResolvedValue(res({ n: 1 }));
    await sharedGet('/api/tags');
    await sharedGet('/api/tags');

    expect(fetchMock, 'a settled response was served to a later caller').toHaveBeenCalledTimes(2);
  });

  it('BOUNDARY: a caller arriving as the first settles gets its own request', async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));
    fetchMock.mockResolvedValue(res({ n: 2 }));

    const first = sharedGet('/api/tags');
    release(res({ n: 1 }));
    await first;

    const second = await sharedGet('/api/tags');
    await expect(second.json()).resolves.toEqual({ n: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('INTEGRITY: URLs do not bleed into each other', () => {
  it('two URLs resolve to their own responses', async () => {
    fetchMock.mockImplementation(async (url: string) => res({ url }));
    const [a, b] = await Promise.all([
      sharedGet('/api/topics/t1'),
      sharedGet('/api/topics/t2'),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(a.json()).resolves.toEqual({ url: '/api/topics/t1' });
    await expect(b.json()).resolves.toEqual({ url: '/api/topics/t2' });
  });

  it('HOSTILE: a differing query string is a different request', async () => {
    fetchMock.mockImplementation(async (url: string) => res({ url }));
    await Promise.all([
      sharedGet('/api/topics/t1/chat?limit=50'),
      sharedGet('/api/topics/t1/chat?limit=10'),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('EMPTY: an empty URL is passed straight through', async () => {
    fetchMock.mockResolvedValue(res({}));
    await sharedGet('');
    await sharedGet('');
    // Nothing to key on, so nothing is shared — and nothing is swallowed.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('FAILURE: a rejection is never retained', () => {
  it('reaches every caller already waiting', async () => {
    let reject: (e: Error) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((_, r) => { reject = r; }));

    const a = sharedGet('/api/topics/t1');
    const b = sharedGet('/api/topics/t1');
    reject(new Error('offline'));

    await expect(a).rejects.toThrow('offline');
    await expect(b).rejects.toThrow('offline');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('RACE: the next caller retries rather than inheriting it', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(sharedGet('/api/topics/t1')).rejects.toThrow('offline');

    fetchMock.mockResolvedValue(res({ ok: true }));
    await expect((await sharedGet('/api/topics/t1')).json()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
