/**
 * Every request the mini-app waits on has a deadline, and running out of one
 * says something the other failures do not.
 *
 * Before this, `AbortController` appeared nowhere in `packages/mobile/src` and
 * `fetch` has no timeout of its own — so a server that accepted a connection
 * and then said nothing left its caller waiting for the life of the process.
 * That is what stranded a real device on "Preparing your anonymous identity…",
 * and no `try/catch` anywhere could have caught it, because nothing was thrown.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   boundary   → a request answered one tick INSIDE the deadline succeeds; one
 *                that never answers aborts exactly AT it and not before; a
 *                `timeoutMs` of 0 aborts immediately (the override is read as
 *                "was it given", not "is it truthy")
 *   integrity  → a timeout, a 500 and a dropped connection are three different
 *                classes and three different host error codes — the caller can
 *                say "the server did not answer" instead of one flat failure
 *   contract   → the deadline reaches `fetch` as a real `AbortSignal` that is
 *                actually aborted, so the socket is released rather than left
 *                hanging while the promise rejects
 *   race       → a caller's OWN abort is not misreported as a timeout
 *   very large → uploads carry a longer deadline than ordinary requests,
 *                because the clock covers a multi-megabyte body going up and a
 *                transfer making progress must not be cut off
 *   authz      → a guest-safe GET (no token, no login) is deadlined the same
 *                way an authenticated one is
 *   empty      → `timeoutMs: null` opts out entirely, which is the escape hatch
 *                a long-lived connection would need
 *   hostile / UTF-8 → N/A: this layer takes a URL and a `RequestInit`; the
 *                bodies it carries are the callers' business and are covered by
 *                the suites that build them
 *
 * The streaming EXCLUSION has its own test at the bottom, and it is a source
 * check rather than a behavioural one on purpose — see the comment there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchWithTimeout,
  OpenStoaTimeoutError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  UPLOAD_REQUEST_TIMEOUT_MS,
} from '../api/timeout';
import {
  OpenStoaClient,
  OpenStoaApiError,
  OpenStoaNetworkError,
} from '../api/openstoaClient';
import { describeFailure, NETWORK_ERROR_CODE, TIMEOUT_ERROR_CODE } from '../api/failure';
import type { HostApi } from '@openstoa/miniapp-bridge';

const BASE = 'https://test.openstoa.local';

function fakeHost(token: string | null = 'jwt.token'): HostApi {
  return {
    getEnvironment: () => ({
      isEmbedded: true,
      hostName: 'test-host',
      openstoaBaseUrl: BASE,
    }),
    getOpenStoaToken: vi.fn(async () => token),
    loginToOpenStoa: vi.fn(async () => ({
      token: 'jwt.token',
      userId: 'me',
      needsNickname: false,
    })),
    logoutFromOpenStoa: vi.fn(async () => {}),
    setOpenStoaToken: vi.fn(async () => {}),
    getDeveloperMode: () => false,
    onDeveloperModeChange: () => () => {},
    generateProof: vi.fn(),
    exitToHost: vi.fn(),
    showError: vi.fn(),
    getLanguage: () => 'en',
    onLanguageChange: () => () => {},
    getTheme: () => 'light',
    onThemeChange: () => () => {},
  } as unknown as HostApi;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * A fetch that never answers AND ignores the abort — the shape that caused the
 * incident, in its worst form.
 *
 * Deliberately deaf to the signal. A deadline implemented as an abort alone
 * would rest on the platform honouring it, and a deadline that the thing it
 * supervises can defeat is not one. Every case below that uses this stub is
 * therefore also asserting that the caller is freed without any cooperation
 * from `fetch`.
 */
function neverAnswers(): ReturnType<typeof vi.fn> {
  return vi.fn(() => new Promise<Response>(() => {}));
}

/**
 * Assert a promise is STILL pending. Cheap and honest: race it against a
 * resolved marker rather than waiting on wall-clock time.
 */
async function isPending(p: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const settled = await Promise.race([p.then(() => 'done').catch(() => 'done'), Promise.resolve(marker)]);
  return settled === marker;
}

describe('request deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('BOUNDARY: a request that never answers aborts at the deadline, and not before', async () => {
    vi.stubGlobal('fetch', neverAnswers());
    const client = new OpenStoaClient({ host: fakeHost() });
    const p = client.get('/api/me').catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 1);
    expect(await isPending(p)).toBe(true);

    await vi.advanceTimersByTimeAsync(2);
    const err = await p;
    expect(err).toBeInstanceOf(OpenStoaTimeoutError);
    expect((err as OpenStoaTimeoutError).kind).toBe('TIMEOUT');
    expect((err as OpenStoaTimeoutError).path).toBe('/api/me');
    expect((err as OpenStoaTimeoutError).timeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it('BOUNDARY: a request answered just inside the deadline succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(jsonResponse({ ok: true })), DEFAULT_REQUEST_TIMEOUT_MS - 1);
          }),
      ),
    );
    const client = new OpenStoaClient({ host: fakeHost() });
    const p = client.get<{ ok: boolean }>('/api/me');

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('BOUNDARY: a deadline of 0 aborts immediately — the override is read as given, not as truthy', async () => {
    vi.stubGlobal('fetch', neverAnswers());
    const client = new OpenStoaClient({ host: fakeHost() });
    const p = client.get('/api/me', { timeoutMs: 0 }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBeInstanceOf(OpenStoaTimeoutError);
  });

  it('EMPTY: `timeoutMs: null` opts out — the escape hatch a long-lived connection needs', async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))),
    );
    const client = new OpenStoaClient({ host: fakeHost() });
    const p = client.get<{ ok: boolean }>('/api/me', { timeoutMs: null });

    // Twenty times the default, and still waiting — as asked.
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS * 20);
    expect(await isPending(p)).toBe(true);

    answer(jsonResponse({ ok: true }));
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('CONTRACT: the deadline reaches fetch as a signal, and that signal is aborted', async () => {
    // Rejecting the promise is not enough. Without a real abort the socket
    // stays open behind a caller that has already given up, and on a phone that
    // is a connection and a radio kept alive for nothing.
    let seen: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        seen = init.signal;
        return new Promise<Response>(() => {});
      }),
    );
    const client = new OpenStoaClient({ host: fakeHost() });
    const p = client.get('/api/me').catch(() => 'timed out');

    // The token is resolved before the request goes out, so `fetch` has not
    // been reached yet on this tick.
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    expect(await p).toBe('timed out');
    expect(seen!.aborted).toBe(true);
  });

  it('a fetch that DOES honour the abort still reports a timeout, not an AbortError', async () => {
    // The realistic implementation: React Native's `fetch` rejects with an
    // `AbortError` when the signal fires. That is the deadline expiring said in
    // the platform's words, and the caller must not have to recognise it.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const e = new Error('Aborted');
              e.name = 'AbortError';
              reject(e);
            });
          }),
      ),
    );
    const client = new OpenStoaClient({ host: fakeHost() });
    const p = client.get('/api/me').catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    const err = await p;
    expect(err).toBeInstanceOf(OpenStoaTimeoutError);
    expect(err).not.toBeInstanceOf(OpenStoaNetworkError);
  });

  it('RACE: a caller aborting on its own is not reported as a timeout', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const e = new Error('The operation was aborted.');
            e.name = 'AbortError';
            reject(e);
          });
        });
      }),
    );

    const p = fetchWithTimeout(
      `${BASE}/api/me`,
      { signal: controller.signal },
      { path: '/api/me', timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
    ).catch((e: unknown) => e);

    controller.abort();
    const err = await p;
    expect(err).not.toBeInstanceOf(OpenStoaTimeoutError);
    expect((err as Error).name).toBe('AbortError');
  });

  it('AUTHZ: a guest-safe GET is deadlined too — no token does not mean no deadline', async () => {
    vi.stubGlobal('fetch', neverAnswers());
    const client = new OpenStoaClient({ host: fakeHost(null) });
    client.setMode('guest');
    // `/api/feed` is in GUEST_SAFE_PREFIXES, so this leaves without a token.
    const p = client.get('/api/feed?limit=20').catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    expect(await p).toBeInstanceOf(OpenStoaTimeoutError);
  });

  it('VERY LARGE: an upload gets the longer deadline, so a slow transfer is not cut off', async () => {
    vi.stubGlobal('fetch', neverAnswers());
    const client = new OpenStoaClient({ host: fakeHost() });
    const p = client
      .uploadChatMedia('topic-1', 'media-1', new Uint8Array(8))
      .catch((e: unknown) => e);

    // Past the ordinary deadline and still going: an attachment climbing a slow
    // uplink is making progress the whole time.
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1_000);
    expect(await isPending(p)).toBe(true);

    await vi.advanceTimersByTimeAsync(UPLOAD_REQUEST_TIMEOUT_MS);
    const err = await p;
    expect(err).toBeInstanceOf(OpenStoaTimeoutError);
    expect((err as OpenStoaTimeoutError).timeoutMs).toBe(UPLOAD_REQUEST_TIMEOUT_MS);
    expect(UPLOAD_REQUEST_TIMEOUT_MS).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it('DIAGNOSTICS: a timeout leaves a log line naming the path and the limit', async () => {
    // The incident left NO trace: success and rejection were logged, and a
    // request that did neither wrote nothing at all, which is why its trigger
    // is still unknown. Nobody else is going to record this one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', neverAnswers());
    const client = new OpenStoaClient({ host: fakeHost() });
    const p = client.post('/api/posts', { title: 'x' }).catch(() => null);

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    await p;

    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('timed out'));
    expect(line).toBeDefined();
    expect(line).toContain('/api/posts');
    expect(line).toContain('POST');
    expect(line).toContain(String(DEFAULT_REQUEST_TIMEOUT_MS));
  });
});

describe('a timeout is not a 500 and is not a dropped connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('INTEGRITY: the three failures are three classes with three host error codes', async () => {
    const client = () => new OpenStoaClient({ host: fakeHost() });

    // 1. The server answered, badly.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'boom' }, 500)));
    const serverFault = await client()
      .get('/api/me')
      .catch((e: unknown) => e);

    // 2. The request never got out.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Network request failed');
      }),
    );
    const dropped = await client()
      .get('/api/me')
      .catch((e: unknown) => e);

    // 3. The server took it and went quiet.
    vi.stubGlobal('fetch', neverAnswers());
    const silence = client()
      .get('/api/me')
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    const timedOut = await silence;

    expect(serverFault).toBeInstanceOf(OpenStoaApiError);
    expect(dropped).toBeInstanceOf(OpenStoaNetworkError);
    expect(timedOut).toBeInstanceOf(OpenStoaTimeoutError);

    // A timeout must NOT be dressed up as either neighbour: "check your
    // connection" is wrong (the connection worked), and "the server said no" is
    // wrong (it said nothing).
    expect(timedOut).not.toBeInstanceOf(OpenStoaNetworkError);
    expect(timedOut).not.toBeInstanceOf(OpenStoaApiError);

    const codes = [serverFault, dropped, timedOut].map((e) => describeFailure(e, 'E9003').code);
    expect(codes).toEqual(['E9003', NETWORK_ERROR_CODE, TIMEOUT_ERROR_CODE]);
    expect(new Set(codes).size).toBe(3);
  });

  it('INTEGRITY: the timeout sentence does not claim the action failed', async () => {
    // Whether the write landed is genuinely unknown, and telling someone it did
    // not is how they end up posting the same thing twice.
    const err = new OpenStoaTimeoutError('/api/posts', DEFAULT_REQUEST_TIMEOUT_MS);
    expect(err.message).toMatch(/did not answer/i);
    expect(err.message).not.toMatch(/connection/i);
    expect(describeFailure(err, 'E9003').inline).toBeNull();
  });
});

describe('EXCLUSION: long-lived connections do not inherit the deadline', () => {
  /*
   * A SOURCE check, not a behavioural one — deliberately.
   *
   * The thing that must stay true is not "these two hooks currently survive a
   * deadline" (they do, trivially: they never call `fetch` at all). It is that
   * neither of them may be moved onto the deadlined client without somebody
   * noticing. `chatSocket` holds a topic's chat stream open for as long as the
   * room is on screen and `useAccountEvents` holds the account's key-needed
   * stream open for the whole session; a 15-second abort on either would break
   * message delivery and the key handover, quietly, in a way a unit test of the
   * hook itself would not show.
   *
   * So the assertion is on the mechanism: both open `EventSource`, and neither
   * issues a `fetch` that could pick up a default.
   */
  const SRC = join(__dirname, '..', 'api');
  const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

  for (const file of ['chatSocket.ts', 'useAccountEvents.ts']) {
    it(`${file} streams over EventSource and issues no fetch of its own`, () => {
      const src = read(file);
      expect(src).toContain('new EventSource');
      // No `fetch(` anywhere: not a bare one, not `client.request`, nothing
      // that the client's default deadline could reach.
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/\bfetchWithTimeout\s*\(/);
    });
  }

  it('CONTRACT: nothing else in the package calls bare `fetch` — the next call site gets a deadline too', () => {
    /*
     * The behaviour is worth nothing if the next request is written with a
     * bare `fetch`, which is how this package got here in the first place: the
     * deadline was never anybody's job, so it was nobody's. This reads the tree
     * rather than exercising it, because the property has to hold for code no
     * test has called yet.
     */
    const root = join(__dirname, '..');
    const bare = /(?<![\w.$])fetch\s*\(/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === '__tests__' || entry === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        // `api/timeout.ts` is the one place that MAY call it: it is the thing
        // doing the wrapping.
        if (full.endsWith(join('api', 'timeout.ts'))) continue;
        const src = readFileSync(full, 'utf8')
          // Strip comments — prose about `fetch(...)` is not a call.
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (bare.test(src)) offenders.push(full.slice(root.length + 1));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('the opt-out exists and is spelled `timeoutMs: null`, so a future stream can take it', () => {
    // If one of those hooks ever does move onto the client, this is the door it
    // walks through — and the test above is what sends it here.
    const src = readFileSync(join(SRC, 'timeout.ts'), 'utf8');
    expect(src).toContain('timeoutMs: number | null');
    const clientSrc = readFileSync(join(SRC, 'openstoaClient.ts'), 'utf8');
    expect(clientSrc).toContain('timeoutMs?: number | null');
  });
});
