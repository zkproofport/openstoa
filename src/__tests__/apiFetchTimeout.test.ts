/**
 * The browser's requests have a deadline now, and running out of one is its own
 * outcome.
 *
 * `fetch` has no timeout. A server that accepts the connection and then goes
 * quiet leaves the promise pending and every spinner behind it spinning, for as
 * long as the tab is open — and no `try/catch` catches it, because nothing is
 * thrown. The mini-app hit precisely this and stranded a real device on its
 * boot screen; the web client had the same hole, because the `AbortController`
 * uses already in this repo (`lib/proof.ts`, the OG routes) are all server-side
 * where nobody is watching a spinner.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   boundary   → answered one tick INSIDE the deadline succeeds; never answered
 *                rejects exactly AT it and not before; `timeoutMs: 0` is
 *                honoured (the override is read as given, not as truthy)
 *   integrity  → a timeout, a 500 and a dropped connection are three
 *                distinguishable outcomes, so a caller can say "the server did
 *                not answer" rather than one flat failure
 *   contract   → the deadline reaches `fetch` as a real `AbortSignal` and that
 *                signal is aborted, so the socket is released; AND no client
 *                module has been left calling bare `fetch` for an API route,
 *                which is what stops the next call site from being the one
 *                without a deadline
 *   race       → a caller's own abort is not misreported as a timeout
 *   very large → uploads carry the longer deadline at every call site that
 *                sends a file
 *   empty      → `timeoutMs: null` opts out, and the one streaming read on the
 *                client takes that opt-out
 *   authz / hostile / UTF-8 → N/A: this layer takes a URL and a `RequestInit`.
 *                What is in the body, and who may send it, belong to the routes
 *                and are covered by their own suites.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  apiFetch,
  ApiTimeoutError,
  isApiTimeout,
  DEFAULT_REQUEST_TIMEOUT_MS,
  UPLOAD_REQUEST_TIMEOUT_MS,
} from '@/lib/apiFetch';

const SRC = join(__dirname, '..');

/** A fetch that never answers AND ignores the abort — the worst case. */
function neverAnswers() {
  return vi.fn(() => new Promise<Response>(() => {}));
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

async function isPending(p: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const settled = await Promise.race([
    p.then(() => 'done').catch(() => 'done'),
    Promise.resolve(marker),
  ]);
  return settled === marker;
}

describe('apiFetch deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('BOUNDARY: a request that never answers rejects at the deadline, and not before', async () => {
    vi.stubGlobal('fetch', neverAnswers());
    const p = apiFetch('/api/feed').catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 1);
    expect(await isPending(p)).toBe(true);

    await vi.advanceTimersByTimeAsync(2);
    const err = await p;
    expect(err).toBeInstanceOf(ApiTimeoutError);
    expect(isApiTimeout(err)).toBe(true);
    expect((err as ApiTimeoutError).url).toBe('/api/feed');
    expect((err as ApiTimeoutError).timeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
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
    const p = apiFetch('/api/feed');
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
    const res = await p;
    expect(res.ok).toBe(true);
  });

  it('BOUNDARY: `timeoutMs: 0` is honoured — the override is read as given, not as truthy', async () => {
    vi.stubGlobal('fetch', neverAnswers());
    const p = apiFetch('/api/feed', { timeoutMs: 0 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBeInstanceOf(ApiTimeoutError);
  });

  it('EMPTY: `timeoutMs: null` waits as long as it takes — the streaming opt-out', async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))),
    );
    const p = apiFetch('/api/ask/stream', { timeoutMs: null });

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS * 20);
    expect(await isPending(p)).toBe(true);

    answer(jsonResponse({ ok: true }));
    expect((await p).ok).toBe(true);
  });

  it('CONTRACT: the deadline reaches fetch as a signal, and that signal is aborted', async () => {
    let seen: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: RequestInfo | URL, init: RequestInit) => {
        seen = init.signal;
        return new Promise<Response>(() => {});
      }),
    );
    const p = apiFetch('/api/feed').catch(() => 'timed out');

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    expect(await p).toBe('timed out');
    // Rejecting is not enough on its own: without the abort the connection
    // stays open behind a caller that has already given up.
    expect(seen!.aborted).toBe(true);
  });

  it('a fetch that DOES honour the abort still reports a timeout, not an AbortError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: RequestInfo | URL, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const e = new Error('The user aborted a request.');
              e.name = 'AbortError';
              reject(e);
            });
          }),
      ),
    );
    const p = apiFetch('/api/feed').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    expect(await p).toBeInstanceOf(ApiTimeoutError);
  });

  it('RACE: a caller aborting on its own is not reported as a timeout', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: RequestInfo | URL, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const e = new Error('The user aborted a request.');
              e.name = 'AbortError';
              reject(e);
            });
          }),
      ),
    );
    const p = apiFetch('/api/feed', { signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    const err = await p;
    expect(err).not.toBeInstanceOf(ApiTimeoutError);
    expect((err as Error).name).toBe('AbortError');
  });

  it('INTEGRITY: a timeout, a 500 and a dropped connection are three different outcomes', async () => {
    // 1. The server answered, badly — a Response, not a throw.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'boom' }, 500)));
    const serverFault = await apiFetch('/api/feed').catch((e: unknown) => e);

    // 2. The request never got out — fetch's own TypeError, passed through.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const dropped = await apiFetch('/api/feed').catch((e: unknown) => e);

    // 3. The server took it and went quiet.
    vi.stubGlobal('fetch', neverAnswers());
    const silence = apiFetch('/api/feed').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    const timedOut = await silence;

    expect((serverFault as Response).status).toBe(500);
    expect(dropped).toBeInstanceOf(TypeError);
    expect(timedOut).toBeInstanceOf(ApiTimeoutError);
    expect(isApiTimeout(dropped)).toBe(false);
    expect(isApiTimeout(serverFault)).toBe(false);
    // Whether the write landed is unknown, so the sentence must not say it did
    // not — that is how somebody ends up submitting the same thing twice.
    expect((timedOut as Error).message).toMatch(/did not answer/i);
    expect((timedOut as Error).message).not.toMatch(/connection/i);
  });

  it('DIAGNOSTICS: a timeout leaves a log line naming the method, the path and the limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', neverAnswers());
    const p = apiFetch('/api/posts', { method: 'POST' }).catch(() => null);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    await p;

    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('timed out'));
    expect(line).toBeDefined();
    expect(line).toContain('POST /api/posts');
    expect(line).toContain(String(DEFAULT_REQUEST_TIMEOUT_MS));
  });
});

/*
 * ── Adoption, checked at the source ───────────────────────────────────────
 *
 * The behaviour above is worth nothing if the next call site is written with a
 * bare `fetch`. These read the tree instead of exercising it, because what has
 * to hold is a property of the CODEBASE — "no browser request is left without a
 * deadline" — and no runtime test can observe a call site nobody called.
 */
describe('every browser request goes through the deadline', () => {
  /** Files that run in the browser: client components, plus the browser-only libs. */
  function clientFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          // `src/app/api` is the SERVER half of the app, and `__tests__` is us.
          if (entry === '__tests__' || entry === 'node_modules' || entry === 'api') continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        const src = readFileSync(full, 'utf8');
        if (!/^\s*['"]use client['"]/m.test(src.slice(0, 400))) continue;
        out.push(full);
      }
    };
    walk(join(SRC, 'app'));
    walk(join(SRC, 'components'));
    walk(join(SRC, 'hooks'));
    // Browser-only libraries carry no `'use client'` directive (they are not
    // components) but every one of their requests is made from a tab.
    for (const f of [
      'lib/mls/webTransport.ts',
      'lib/keyGrant.ts',
      'lib/dmCandidatesCache.ts',
      'lib/chatDeliveryAckHttp.ts',
      'lib/useConversationList.ts',
    ]) {
      out.push(join(SRC, f));
    }
    return out;
  }

  it('CONTRACT: no client module calls bare `fetch` — a new one must take the deadline too', () => {
    const bare = /(?<![\w.$])fetch\s*\(/;
    /** Prose about `fetch (...)` is not a call; comments are stripped first. */
    const code = (f: string) =>
      readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const offenders = clientFiles().filter((f) => bare.test(code(f)));

    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });

  it('guard the guard: the scan actually looks at a meaningful number of files', () => {
    // A walk that found nothing would make the assertion above vacuous.
    expect(clientFiles().length).toBeGreaterThan(30);
  });

  it('EMPTY: the one streaming read on the client opts OUT of the deadline', () => {
    // `/api/ask/stream` is consumed incrementally with `body.getReader()`, and a
    // long answer legitimately takes minutes. A 15s cap would cut the model off
    // mid-sentence every single time.
    const src = readFileSync(join(SRC, 'app/ask/page.tsx'), 'utf8');
    expect(src).toMatch(/\/api\/ask\/stream/);
    expect(src).toMatch(/timeoutMs:\s*null/);
    expect(src).toMatch(/getReader\(\)/);
  });

  it('EXCLUSION: the SSE consumers stream over EventSource, which no deadline can reach', () => {
    // `fetch` is not involved in an `EventSource`, so the default cannot touch
    // these — but this is the test that fails if one is ever ported onto
    // `apiFetch`, which would sever chat delivery and the key-needed signal
    // every fifteen seconds.
    for (const f of ['components/ChatPanel.tsx', 'lib/useAccountEvents.ts']) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src).toContain('new EventSource(');
    }
    const events = readFileSync(join(SRC, 'lib/useAccountEvents.ts'), 'utf8');
    expect(events).not.toMatch(/(?<![\w.$])(api)?[fF]etch\s*\(/);
  });

  it('VERY LARGE: every call site that sends a file takes the longer deadline', () => {
    const uploaders = [
      'components/SNSEditor.tsx',
      'components/ChatPanel.tsx',
      'app/profile/page.tsx',
      'app/my/page.tsx',
      'app/topics/new/page.tsx',
      'app/topics/[topicId]/edit/page.tsx',
      'app/topics/[topicId]/TopicPageClient.tsx',
    ];
    for (const f of uploaders) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src, `${f} sends a file without the upload deadline`).toContain(
        'UPLOAD_REQUEST_TIMEOUT_MS',
      );
    }
    expect(UPLOAD_REQUEST_TIMEOUT_MS).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS);
  });
});
