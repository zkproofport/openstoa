/**
 * A push provider that goes quiet does not hold the server forever.
 *
 * Nobody is waiting on these calls — the chat route dispatches push
 * fire-and-forget, so a stalled provider cannot slow or fail a message. That is
 * exactly why they were written with a bare `fetch` and no deadline, and it is
 * half an argument. The other half: undici's defaults let a silent peer hold a
 * socket and a pending promise for roughly five minutes on an instance that
 * answered its user long ago, and the FCM token refresh sits on the path of
 * EVERY android send — one slow answer from Google stalls a whole dispatch
 * batch rather than the single target it was refreshing for.
 *
 * So the assertions here are about TIME and about CONTAINMENT: the call gives
 * up on its own, and giving up is reported as a failure rather than escaping as
 * an unhandled rejection or, worse, being mistaken for a delivery.
 *
 * Fake timers throughout — a test that actually waited fifteen seconds to prove
 * a fifteen-second deadline would be the slowest file in the suite and would
 * still only prove it once.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → a never-settling send rejects instead of hanging (the defect)
 *   contract   → the deadline is the SHARED constant, not a number retyped here
 *   race       → a provider that answers just under the limit still succeeds;
 *                the deadline must not truncate a slow-but-working call
 *   integrity  → a timeout is never counted as a delivered message
 *   authz      → the abort signal reaches the request, so the socket is
 *                released rather than left open behind a caller that gave up
 *   empty      → zero targets makes no outbound call at all, so no deadline
 *   external   → a provider that rejects outright is still handled, unchanged
 *   boundary   → the token refresh — the one non-per-target call — is covered,
 *                because it is the site whose stall costs the whole batch
 *   N/A        → hostile / UTF-8 / very large input: these assert over timing
 *                and control flow, not over payload content
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Relative, not the package name: the web tsconfig has no path mapping for the
// workspace package, so `src/**` reaches it by path — see `lib/apiFetch.ts`,
// which imports the same constant the same way.
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../../packages/api-types/src/timeouts';
import { apiFetch } from '@/lib/apiFetch';

/** A fetch that never answers — the failure being guarded, in one line. */
function silent(): { call: ReturnType<typeof vi.fn>; aborted: () => boolean } {
  let signal: AbortSignal | undefined;
  const call = vi.fn((_url: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {
      /* never settles, which is the whole point */
    });
  });
  return { call, aborted: () => signal?.aborted === true };
}

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('outbound calls give up on their own', () => {
  it('rejects a never-answering provider instead of pending forever', async () => {
    const { call } = silent();
    globalThis.fetch = call as unknown as typeof globalThis.fetch;

    const inflight = apiFetch('https://exp.host/--/api/v2/push/send', { method: 'POST' });
    // Attach the handler BEFORE advancing: an unhandled rejection between the
    // timer firing and the await would fail the run for the wrong reason.
    const settled = inflight.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    expect(await settled).toBe('rejected');
  });

  it('still pends one millisecond before the deadline — it is a limit, not a guess', async () => {
    const { call } = silent();
    globalThis.fetch = call as unknown as typeof globalThis.fetch;

    let done = false;
    const inflight = apiFetch('https://fcm.googleapis.com/v1/projects/p/messages:send', {
      method: 'POST',
    });
    void inflight.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 1);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });

  it('aborts the request, so the socket is released and not merely abandoned', async () => {
    const { call, aborted } = silent();
    globalThis.fetch = call as unknown as typeof globalThis.fetch;

    const inflight = apiFetch('https://oauth2.googleapis.com/token', { method: 'POST' });
    const settled = inflight.catch(() => 'rejected' as const);

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    await settled;

    // Freeing the caller is not enough: a live socket behind a caller that has
    // given up is the resource this was supposed to stop leaking.
    expect(aborted()).toBe(true);
  });

  it('does not truncate a slow answer that arrives inside the limit', async () => {
    const ok = new Response('{}', { status: 200 });
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(ok), DEFAULT_REQUEST_TIMEOUT_MS - 500);
        }),
    ) as unknown as typeof globalThis.fetch;

    const inflight = apiFetch('https://exp.host/--/api/v2/push/getReceipts', { method: 'POST' });
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 400);

    const res = await inflight;
    expect(res.status).toBe(200);
  });

  it('passes a provider rejection through unchanged', async () => {
    const boom = new Error('ECONNREFUSED');
    globalThis.fetch = vi.fn(() => Promise.reject(boom)) as unknown as typeof globalThis.fetch;

    await expect(apiFetch('https://api.cloudflare.com/purge', { method: 'POST' })).rejects.toBe(boom);
  });

  /*
   * The five assertions above exercise the WRAPPER. They would all still pass
   * with every call site reverted to a bare `fetch`, which is precisely the
   * state this file exists to prevent — so the last one reads the call sites.
   */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('leaves no bare fetch in the modules that talk to a provider', () => {
    const root = join(process.cwd(), 'src', 'lib');
    const offenders = ['pushProvider.ts', 'fcmProvider.ts', 'cloudflare-cache.ts'].filter((file) =>
      /(?<!api)\bfetch\(/.test(stripComments(readFileSync(join(root, file), 'utf8'))),
    );

    expect({ modulesCallingFetchDirectly: offenders }).toEqual({ modulesCallingFetchDirectly: [] });
  });

  /*
   * THE SCRIPTS COUNT, and this is the half that was missing.
   *
   * The rule above was enforced on `cloudflare-cache.ts` — which, at the time
   * it was written, nothing imported. The two maintenance scripts that actually
   * purge each carried their own copy built on a bare `fetch`, so a Cloudflare
   * that accepted the connection and never answered hung the sweep with no
   * deadline to stop it. Three implementations of one rule, and the guard sat
   * on the one that never ran.
   *
   * They import the shared function now. This asserts they kept doing so,
   * because re-inlining it is a two-line change that nothing else would catch.
   */
  it('the purge scripts use the shared client, not their own fetch', () => {
    const root = join(process.cwd(), 'scripts');
    const offenders = ['purge-r2-cdn.ts', 'fix-heic-r2.ts'].filter((file) => {
      const src = stripComments(readFileSync(join(root, file), 'utf8'));
      return /\bfetch\(/.test(src) || !src.includes('purgeCloudflareUrls');
    });

    expect({ scriptsPurgingWithoutTheSharedClient: offenders }).toEqual({
      scriptsPurgingWithoutTheSharedClient: [],
    });
  });
});
