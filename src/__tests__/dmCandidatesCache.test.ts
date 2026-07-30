/**
 * `src/lib/dmCandidatesCache.ts` — the session-scoped cache both `UserCard`
 * and the rail's new-conversation picker read from.
 *
 * Edge-case matrix rows covered here:
 *   contract     — exactly one network request for concurrent callers within
 *                  the TTL (the whole reason this module exists)
 *   ext-failure  — a 500 / rejected fetch degrades to an empty list, never a
 *                  thrown error (a UserCard popover must not crash on this)
 *   boundary     — 0 candidates; force=true bypasses the cache
 *   contract     — isDmCandidate is exactly `candidates.some(userId match)`
 *   race         — invalidateDmCandidates() forces the NEXT call to refetch
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

async function freshModule() {
  vi.resetModules();
  return import('@/lib/dmCandidatesCache');
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('getDmCandidates', () => {
  it('CONTRACT: two concurrent callers before the first resolves share ONE fetch', async () => {
    const { getDmCandidates } = await freshModule();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ candidates: [{ userId: 'u1', nickname: 'a', profileImage: null, badges: [], sharedTopics: [] }] })));
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([getDmCandidates(), getDmCandidates()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
  });

  it('a SECOND call within the TTL reuses the cache (still one fetch)', async () => {
    const { getDmCandidates } = await freshModule();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ candidates: [] })));
    vi.stubGlobal('fetch', fetchMock);

    await getDmCandidates();
    await getDmCandidates();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('BOUNDARY: force=true always re-fetches, bypassing the cache', async () => {
    const { getDmCandidates } = await freshModule();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ candidates: [] })));
    vi.stubGlobal('fetch', fetchMock);

    await getDmCandidates();
    await getDmCandidates(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('BOUNDARY 0: an empty candidates array is a normal, non-error result', async () => {
    const { getDmCandidates } = await freshModule();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ candidates: [] }))));

    expect(await getDmCandidates()).toEqual([]);
  });

  it('EXT-FAILURE: a non-OK response degrades to an empty list, not a throw', async () => {
    const { getDmCandidates } = await freshModule();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ error: 'boom' }, false))));

    await expect(getDmCandidates()).resolves.toEqual([]);
  });

  it('EXT-FAILURE: a rejected fetch (network error) degrades to an empty list, not a throw', async () => {
    const { getDmCandidates } = await freshModule();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))));

    await expect(getDmCandidates()).resolves.toEqual([]);
  });

  it('a malformed body (candidates missing/not an array) degrades to an empty list', async () => {
    const { getDmCandidates } = await freshModule();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ candidates: 'nope' }))));

    expect(await getDmCandidates()).toEqual([]);
  });
});

describe('invalidateDmCandidates', () => {
  it('RACE: forces the next call to refetch instead of serving stale data', async () => {
    const { getDmCandidates, invalidateDmCandidates } = await freshModule();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ candidates: [] })));
    vi.stubGlobal('fetch', fetchMock);

    await getDmCandidates();
    invalidateDmCandidates();
    await getDmCandidates();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('isDmCandidate', () => {
  it('CONTRACT: true exactly when the userId is present in the candidate list', async () => {
    const { isDmCandidate } = await freshModule();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ candidates: [{ userId: 'u1', nickname: 'a', profileImage: null, badges: [], sharedTopics: [] }] }))),
    );

    expect(await isDmCandidate('u1')).toBe(true);
    expect(await isDmCandidate('u-not-there')).toBe(false);
  });

  it('a candidate who no longer shares a topic (absent from the server list) is not DM-able', async () => {
    // The server already excludes them (see /api/dm/candidates) — this test
    // pins that the client trusts the server's list verbatim rather than
    // caching a stale "yes" from an earlier fetch.
    const { isDmCandidate, invalidateDmCandidates } = await freshModule();
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call += 1;
        const body = call === 1
          ? { candidates: [{ userId: 'u1', nickname: 'a', profileImage: null, badges: [], sharedTopics: [{ id: 't1', title: 'x' }] }] }
          : { candidates: [] };
        return Promise.resolve(jsonResponse(body));
      }),
    );

    expect(await isDmCandidate('u1')).toBe(true);
    invalidateDmCandidates();
    expect(await isDmCandidate('u1')).toBe(false);
  });
});
