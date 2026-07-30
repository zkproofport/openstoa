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
 *   contract     — FIX9: isDmCandidate is TRUE for an existing DM partner
 *                  even when the server-side candidates list now excludes
 *                  them (see dm-candidates.test.ts), by also checking
 *                  GET /api/dm — a genuinely separate source, not a JS
 *                  post-filter of the candidates list
 *   race         — FIX9: invalidateDmCandidates() also drops the existing-DM
 *                  cache, so starting a DM is reflected immediately, not
 *                  after the 60s TTL
 *   ext-failure  — FIX9: a failed /api/dm lookup degrades to "not an existing
 *                  partner" (fails closed) rather than crashing or throwing
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

async function freshModule() {
  vi.resetModules();
  return import('@/lib/dmCandidatesCache');
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

/** Routes a fetch mock by URL prefix — needed once a test touches BOTH
 *  `/api/dm/candidates` and `/api/dm`. A handler may return a `Response` (ok)
 *  or a rejected `Promise` (network failure), matching real `fetch()`. */
function routeFetch(routes: Array<[string, () => Response | Promise<never>]>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    for (const [prefix, handler] of routes) {
      if (url.startsWith(prefix)) return Promise.resolve(handler());
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
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
    expect(a).toEqual({ ok: true, data: [{ userId: 'u1', nickname: 'a', profileImage: null, badges: [], sharedTopics: [] }] });
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

    // ok:true with no rows — genuinely nobody to message. The picker must show
    // its explanatory empty state for THIS, and an error for ok:false below.
    expect(await getDmCandidates()).toEqual({ ok: true, data: [] });
  });

  it('EXT-FAILURE: a non-OK response is reported as a failure, NOT as an empty list', async () => {
    const { getDmCandidates } = await freshModule();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ error: 'boom' }, false))));

    const res = await getDmCandidates();
    expect(res.ok).toBe(false);
  });

  it('EXT-FAILURE: a rejected fetch (network error) is a failure, not an empty list', async () => {
    const { getDmCandidates } = await freshModule();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))));

    await expect(getDmCandidates()).resolves.toEqual({ ok: false, status: null });
  });

  it('REGRESSION: a failure is NOT cached, so an immediate retry re-fetches', async () => {
    const { getDmCandidates } = await freshModule();
    const rows = [{ userId: 'u1', nickname: 'a', profileImage: null, badges: [], sharedTopics: [] }];
    let call = 0;
    const fetchMock = vi.fn(() => {
      call += 1;
      return call === 1
        ? Promise.reject(new Error('network down'))
        : Promise.resolve(jsonResponse({ candidates: rows }));
    });
    vi.stubGlobal('fetch', fetchMock);

    // Caching the failure was the actual defect: the picker showed "nobody to
    // message" and kept showing it for the whole TTL even once the network was
    // back, so Retry could not work.
    expect(await getDmCandidates()).toEqual({ ok: false, status: null });
    expect(await getDmCandidates()).toEqual({ ok: true, data: rows });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a malformed body (candidates missing/not an array) yields an empty ok result', async () => {
    const { getDmCandidates } = await freshModule();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ candidates: 'nope' }))));

    expect(await getDmCandidates()).toEqual({ ok: true, data: [] });
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

  it('FIX9 CONTRACT: an existing DM partner is DM-able even though the server-side candidates list now excludes them', async () => {
    const { isDmCandidate } = await freshModule();
    vi.stubGlobal(
      'fetch',
      routeFetch([
        // '/api/dm/candidates' MUST be listed before '/api/dm' — prefix match.
        ['/api/dm/candidates', () => jsonResponse({ candidates: [] })],
        ['/api/dm', () => jsonResponse({ dms: [{ topicId: 'd1', peer: { userId: 'u1', nickname: 'bob', profileImage: null }, lastActivityAt: null }] })],
      ]),
    );

    expect(await isDmCandidate('u1')).toBe(true);
  });

  it('a genuine new-conversation candidate (no existing DM) is still DM-able via the candidates list', async () => {
    const { isDmCandidate } = await freshModule();
    vi.stubGlobal(
      'fetch',
      routeFetch([
        ['/api/dm/candidates', () => jsonResponse({ candidates: [{ userId: 'u2', nickname: 'carol', profileImage: null, badges: [], sharedTopics: [{ id: 't1', title: 'x' }] }] })],
        ['/api/dm', () => jsonResponse({ dms: [] })],
      ]),
    );

    expect(await isDmCandidate('u2')).toBe(true);
  });

  it('someone who is NEITHER a candidate NOR an existing DM partner is not DM-able', async () => {
    const { isDmCandidate } = await freshModule();
    vi.stubGlobal(
      'fetch',
      routeFetch([
        ['/api/dm/candidates', () => jsonResponse({ candidates: [] })],
        ['/api/dm', () => jsonResponse({ dms: [] })],
      ]),
    );

    expect(await isDmCandidate('u-nobody')).toBe(false);
  });

  it('EXT-FAILURE: a failed /api/dm lookup fails closed (falls through to the candidates list) rather than throwing', async () => {
    const { isDmCandidate } = await freshModule();
    vi.stubGlobal(
      'fetch',
      routeFetch([
        ['/api/dm/candidates', () => jsonResponse({ candidates: [{ userId: 'u2', nickname: 'carol', profileImage: null, badges: [], sharedTopics: [{ id: 't1', title: 'x' }] }] })],
        ['/api/dm', () => jsonResponse({ error: 'boom' }, false)],
      ]),
    );

    // The candidates-list branch still works even though the DM-list branch failed.
    expect(await isDmCandidate('u2')).toBe(true);
  });

  it('EXT-FAILURE: someone reachable ONLY via an existing DM is hidden when that lookup fails — fails CLOSED', async () => {
    const { isDmCandidate } = await freshModule();
    vi.stubGlobal(
      'fetch',
      routeFetch([
        ['/api/dm/candidates', () => jsonResponse({ candidates: [] })],
        ['/api/dm', () => Promise.reject(new Error('network down'))],
      ]),
    );

    expect(await isDmCandidate('u1')).toBe(false);
  });

  it('RACE: invalidateDmCandidates() also drops the existing-DM cache, not just the candidates cache', async () => {
    const { isDmCandidate, invalidateDmCandidates } = await freshModule();
    let dmCall = 0;
    vi.stubGlobal(
      'fetch',
      routeFetch([
        ['/api/dm/candidates', () => jsonResponse({ candidates: [] })],
        [
          '/api/dm',
          () => {
            dmCall += 1;
            // Before starting the DM, u1 is a stranger; after, they're a
            // partner — simulating POST /api/dm succeeding in between.
            return jsonResponse({
              dms: dmCall === 1 ? [] : [{ topicId: 'd1', peer: { userId: 'u1', nickname: 'bob', profileImage: null }, lastActivityAt: null }],
            });
          },
        ],
      ]),
    );

    expect(await isDmCandidate('u1')).toBe(false);
    // Without invalidation this would still read the (now stale) cached "no
    // DMs yet" answer for up to 60s.
    invalidateDmCandidates();
    expect(await isDmCandidate('u1')).toBe(true);
    expect(dmCall).toBe(2);
  });
});
