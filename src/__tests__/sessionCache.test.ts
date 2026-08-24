// @vitest-environment jsdom
/**
 * One `/api/auth/session` per page, and one place that owns the answer.
 *
 * WHAT THIS REPLACED. Thirteen call sites fetched the same endpoint on their
 * own — `Header`, `ChatPanel` and eleven pages — so opening a topic asked twice
 * before anything else happened and every navigation asked again. `Header`
 * alone cached it, under `os-session`, and nothing else read what it wrote.
 *
 * The cost was not theoretical: the endpoint takes ~270ms on staging, and
 * `ChatPanel` refuses to draw a row until it answers, because a bubble whose
 * side is unknown opens under the wrong name and then moves. A restored room
 * sat blank waiting for a value the tab already had.
 *
 * EDGE-CASE MATRIX → coverage
 *   contract   → concurrent callers share ONE request
 *   contract   → a second call after it resolves makes no request at all
 *   contract   → the answer is written where a later page load can find it
 *   integrity  → a signed-out answer is not cached as a session
 *   empty      → no stored value, empty string, `null`, and `{}`
 *   hostile    → corrupt JSON, and a stored array, read as "nothing"
 *   external   → a rejected fetch, and a non-200, resolve to null
 *   race       → a failure clears the in-flight promise so the next call retries
 *   authz      → `clearSession` leaves nothing behind for the next person
 *   boundary   → `peekSession` never touches the network
 *   REPO GUARD → nothing outside this module fetches the endpoint directly
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const fetchMock = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));

const ME = '0xabc';

function json(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

async function freshModule() {
  vi.resetModules();
  return import('@/lib/sessionCache');
}

beforeEach(() => {
  fetchMock.mockReset();
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('CONTRACT: one request, however many callers', () => {
  it('concurrent callers share a single fetch', async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((res) => { release = res; }));
    const { loadSession } = await freshModule();

    const all = Promise.all([loadSession(), loadSession(), loadSession()]);
    release(json({ userId: ME, nickname: 'me' }));
    const [a, b, c] = await all;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([a?.userId, b?.userId, c?.userId]).toEqual([ME, ME, ME]);
  });

  it('SEQUENTIAL callers do not each pay a request', async () => {
    /*
     * The case that made the first version of this module WORSE than what it
     * replaced. De-duplicating only concurrent callers still sent one request
     * per caller that arrived after the last had settled — two `UserCard`s
     * opened one after the other cost two, where the per-component cache they
     * replaced cost one. `userCard.test.tsx` caught it; this is the assertion
     * that should have.
     */
    fetchMock.mockResolvedValue(json({ userId: ME }));
    const { loadSession } = await freshModule();

    await loadSession();
    await loadSession();
    await loadSession();

    expect(fetchMock, 'each sequential caller went to the network').toHaveBeenCalledTimes(1);
  });

  it('force asks again, for a caller that has reason to', async () => {
    fetchMock.mockResolvedValue(json({ userId: ME }));
    const { loadSession } = await freshModule();
    await loadSession();
    await loadSession({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('AUTHZ: after clearSession the next load ASKS rather than trusting the page', async () => {
    fetchMock.mockResolvedValue(json({ userId: ME }));
    const { loadSession, clearSession } = await freshModule();
    await loadSession();
    clearSession();
    await loadSession();
    expect(fetchMock, 'a signed-out page served the previous session').toHaveBeenCalledTimes(2);
  });

  it('a later peek costs nothing at all', async () => {
    fetchMock.mockResolvedValue(json({ userId: ME }));
    const { loadSession, peekSession } = await freshModule();
    await loadSession();
    fetchMock.mockReset();

    expect(peekSession()?.userId).toBe(ME);
    expect(fetchMock, 'peekSession went to the network').not.toHaveBeenCalled();
  });

  it('the answer survives into a new page load', async () => {
    fetchMock.mockResolvedValue(json({ userId: ME, nickname: 'me' }));
    const first = await freshModule();
    await first.loadSession();

    // A new module instance is a new page: same storage, no memo.
    const second = await freshModule();
    expect(second.peekSession()?.userId).toBe(ME);
    expect(second.peekSession()?.nickname).toBe('me');
  });

  it('INTEGRITY: a signed-out answer is not cached as a session', async () => {
    fetchMock.mockResolvedValue(json({}));
    const { loadSession, peekSession } = await freshModule();
    expect(await loadSession()).toBeNull();
    expect(peekSession()).toBeNull();
    expect(localStorage.getItem('os-session')).toBeNull();
  });

  it('a signed-out answer CLEARS a previously stored one', async () => {
    localStorage.setItem('os-session', JSON.stringify({ userId: 'someone-else' }));
    fetchMock.mockResolvedValue(json({}));
    const { loadSession } = await freshModule();
    await loadSession();
    expect(localStorage.getItem('os-session')).toBeNull();
  });
});

describe('EMPTY and HOSTILE stored values', () => {
  it.each([
    ['absent', null],
    ['empty string', ''],
    ['literal null', 'null'],
    ['corrupt json', '{not json'],
    ['an array', '[1,2,3]'],
    ['a bare string', '"hello"'],
    ['a number', '42'],
  ])('%s reads as nothing rather than throwing', async (_label, raw) => {
    if (raw !== null) localStorage.setItem('os-session', raw);
    const { peekSession } = await freshModule();
    expect(() => peekSession()).not.toThrow();
    const got = peekSession();
    expect(got === null || typeof got === 'object').toBe(true);
    expect(got?.userId).toBeUndefined();
  });

  it('an object without a userId is not mistaken for a session', async () => {
    localStorage.setItem('os-session', JSON.stringify({ nickname: 'ghost' }));
    const { peekSession } = await freshModule();
    expect(peekSession()?.userId).toBeUndefined();
  });
});

describe('EXTERNAL FAILURE and RACE', () => {
  it('a rejected fetch resolves to null rather than throwing', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const { loadSession } = await freshModule();
    await expect(loadSession()).resolves.toBeNull();
  });

  it('a non-200 resolves to null', async () => {
    fetchMock.mockResolvedValue(json(null, false));
    const { loadSession } = await freshModule();
    await expect(loadSession()).resolves.toBeNull();
  });

  it('a failure does not poison the next call', async () => {
    // The in-flight promise has to be cleared, or every later caller inherits
    // the rejection and the page never recovers.
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const { loadSession } = await freshModule();
    expect(await loadSession()).toBeNull();

    fetchMock.mockResolvedValue(json({ userId: ME }));
    expect((await loadSession())?.userId).toBe(ME);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('AUTHZ: clearing leaves nothing for the next person', () => {
  it('clearSession empties the memo and the storage', async () => {
    fetchMock.mockResolvedValue(json({ userId: ME, nickname: 'me' }));
    const { loadSession, peekSession, clearSession } = await freshModule();
    await loadSession();
    expect(peekSession()?.userId).toBe(ME);

    clearSession();

    expect(peekSession(), 'the memo outlived the logout').toBeNull();
    expect(localStorage.getItem('os-session')).toBeNull();
  });
});

describe('REPO GUARD: nothing else fetches the endpoint', () => {
  /*
   * The de-duplication is only real while it is the only path. Thirteen call
   * sites drifted into existence one at a time, each reasonable on its own, and
   * nothing failed when they did — so this is the assertion that would have
   * caught it, and the one that keeps the fourteenth from appearing.
   */
  const ROOT = join(process.cwd(), 'src');
  const ALLOWED = ['lib/sessionCache.ts', 'middleware.ts'];

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue;
        walk(full, out);
      } else if (/\.(ts|tsx)$/.test(name)) {
        out.push(full);
      }
    }
    return out;
  }

  it("client code reaches the session through sessionCache, never apiFetch", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const rel = file.slice(ROOT.length + 1);
      // The route that IMPLEMENTS it, and the middleware allow-list, are not callers.
      if (rel.startsWith('app/api/') || ALLOWED.includes(rel)) continue;
      const src = readFileSync(file, 'utf8');
      if (/apiFetch\(\s*['"`]\/api\/auth\/session/.test(src) || /fetch\(\s*['"`]\/api\/auth\/session/.test(src)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `these fetch /api/auth/session directly; use loadSession() from @/lib/sessionCache:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
