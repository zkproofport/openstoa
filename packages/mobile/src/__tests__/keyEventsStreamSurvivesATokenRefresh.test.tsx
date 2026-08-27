/**
 * The stream that delivers "somebody needs a key" survives a token refresh.
 *
 * THE DEFECT, and it is the quieter twin of the chat stream's. The token was
 * read once, at connect time, and baked into the EventSource headers;
 * `react-native-sse` then reconnected on its own with those same headers. The
 * REST client refreshes the session and stores a NEW token, so after a refresh
 * this stream retried a dead credential forever.
 *
 * WORSE HERE, because there was no `error` listener at all. Nothing set a
 * status, nothing rendered a banner, nothing logged. The stream simply stopped
 * delivering `key-needed`, so keys stopped being granted automatically and a
 * room sat on "Waiting for the key…" with nothing anywhere to explain it. The
 * chat stream at least showed a banner; this one was silent.
 *
 * `host` is the host app's API singleton — one object for the life of the app —
 * so no dependency the effect watched could notice a token change.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → an error rebuilds the stream with the token read at that moment
 *   contract   → `key-needed` still reaches the grant handler after a rebuild —
 *                a reconnect that forgot to re-attach the listener would look
 *                identical from the outside and deliver nothing
 *   累積       → five failures each re-read the token. THE axis: rebuilding once
 *                passes a single-failure test and then stops, which is the
 *                original bug with one extra life
 *   累積       → the wait walks the ladder rather than repeating one interval
 *   integrity  → a stream that opens resets the ladder
 *   integrity  → the failed stream is closed immediately, not left polling for
 *                the whole backoff with the credential that just failed
 *   boundary   → a guest opens no stream at all
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';

const streams: Array<{
  token: string | null;
  closed: boolean;
  fire: (name: string, e?: unknown) => void;
}> = [];

vi.mock('react-native-sse', () => ({
  default: class FakeEventSource {
    listeners: Record<string, (e: unknown) => void> = {};
    entry: (typeof streams)[number];
    constructor(_url: string, opts: { headers?: Record<string, string> }) {
      const auth = opts?.headers?.Authorization ?? null;
      this.entry = {
        token: auth ? auth.replace(/^Bearer /, '') : null,
        closed: false,
        fire: (name, e) => this.listeners[name]?.(e ?? {}),
      };
      streams.push(this.entry);
    }
    addEventListener(name: string, fn: (e: unknown) => void) {
      this.listeners[name] = fn;
    }
    removeAllEventListeners() {
      this.listeners = {};
    }
    close() {
      this.entry.closed = true;
    }
  },
}));

let currentToken: string | null = 'token-1';
let mode: 'authenticated' | 'guest' = 'authenticated';

/* ONE object for the file, exactly as the app has one for the life of the
 * process. A fresh object per render would re-run the effect on its own and
 * hide the bug this file is about. */
const hostSingleton = {
  getOpenStoaToken: async () => currentToken,
  getEnvironment: () => ({ openstoaBaseUrl: 'http://test' }),
  secureStore: undefined,
  localStore: undefined,
};

vi.mock('@openstoa/miniapp-bridge', () => ({ useHost: () => hostSingleton }));

const granted: string[] = [];
vi.mock('../crypto/keyGrant', () => ({
  // Three arguments — (client, host, topicId). Taking the second would record
  // the host object, which is what the first draft of this test did.
  grantRoomKeys: async (_c: unknown, _h: unknown, topicId: string) => {
    granted.push(topicId);
  },
}));
/*
 * A STABLE client, and the stability is the point.
 *
 * The first draft returned a fresh `{}` on every call. The hook's grant
 * callback is memoised on the client, so a new client per render changed the
 * callback's identity, which re-ran the effect on every render — and the whole
 * suite passed even with the fix reverted. Mutation testing caught it: removing
 * `attempt` from the dependency list changed nothing.
 *
 * The real client is a singleton for the session. A fake that is less stable
 * than the real thing does not make a test stricter; it makes it blind.
 */
const clientSingleton = {};
vi.mock('../hooks/useOpenStoaClient', () => ({ useOpenStoaClient: () => clientSingleton }));
/*
 * The mode comes from the session store, not from an argument — the hook takes
 * none. Mocking the selector shape rather than the whole store keeps the test
 * honest about how the hook actually reads it.
 */
vi.mock('../stores/sessionStore', () => ({
  useOpenStoaSession: (sel: (s: { mode: string }) => unknown) => sel({ mode }),
}));
vi.mock('../hooks/pushRegistration', () => ({
  getPushRoutingHandle: () => null,
  subscribePushRoutingHandle: () => () => {},
}));
vi.mock('../hooks/pushReceived', () => ({
  subscribeKeyNeededPushes: () => () => {},
}));

import { useAccountEvents } from '../api/useAccountEvents';
import { RETRY_DELAYS_MS } from '../crypto/backupRetry';

function Harness() {
  useAccountEvents();
  return null;
}

async function mount() {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<Harness />);
  });
  return tree;
}

async function failAndAdvance() {
  await act(async () => {
    streams[streams.length - 1].fire('error', {});
  });
  await act(async () => {
    vi.runOnlyPendingTimers();
  });
}

beforeEach(() => {
  streams.length = 0;
  granted.length = 0;
  currentToken = 'token-1';
  mode = 'authenticated';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the key-events stream re-reads the token when it rebuilds', () => {
  it('CONTRACT: a refreshed token is picked up', async () => {
    await mount();
    expect(streams).toHaveLength(1);
    expect(streams[0].token).toBe('token-1');

    currentToken = 'token-2';
    await failAndAdvance();

    expect(streams).toHaveLength(2);
    expect(streams[1].token).toBe('token-2');
  });

  it('CONTRACT: key-needed still reaches the grant handler after a rebuild', async () => {
    /*
     * The assertion that separates "a new stream exists" from "a new stream
     * WORKS". A rebuild that forgot to re-attach the listener produces exactly
     * the same stream count and delivers nothing — which is the original
     * failure with extra steps.
     */
    await mount();
    await failAndAdvance();

    await act(async () => {
      streams[1].fire('key-needed', { data: JSON.stringify({ topicId: 'topic-abc' }) });
    });

    expect(granted).toEqual(['topic-abc']);
  });

  it('ACCUMULATING: five failures each re-read the token', async () => {
    /*
     * THE AXIS. Rebuilding once passes the first case and then stops — on a
     * phone that is the same silence as before, arriving one refresh later.
     */
    await mount();
    for (let i = 2; i <= 6; i++) {
      currentToken = `token-${i}`;
      await failAndAdvance();
    }

    expect(streams.map((s) => s.token)).toEqual([
      'token-1',
      'token-2',
      'token-3',
      'token-4',
      'token-5',
      'token-6',
    ]);
  });

  it('ACCUMULATING: the wait walks the ladder', async () => {
    await mount();
    const waits: number[] = [];
    const spy = vi.spyOn(globalThis, 'setTimeout');
    for (let i = 0; i < 3; i++) {
      spy.mockClear();
      await failAndAdvance();
      const armed = spy.mock.calls
        .map((c) => c[1])
        .filter((ms): ms is number => typeof ms === 'number');
      waits.push(Math.max(...armed));
    }
    spy.mockRestore();

    expect(waits).toEqual([RETRY_DELAYS_MS[1], RETRY_DELAYS_MS[2], RETRY_DELAYS_MS[3]]);
  });

  it('INTEGRITY: the failed stream is closed immediately, not left polling', async () => {
    // The window matters: without the close, the dead stream keeps retrying the
    // credential that just failed for the whole backoff.
    await mount();
    await act(async () => {
      streams[0].fire('error', {});
    });

    expect(streams[0].closed).toBe(true);
    expect(streams).toHaveLength(1);
  });

  it('INTEGRITY: a stream that opens resets the ladder', async () => {
    await mount();
    await failAndAdvance();
    await failAndAdvance();
    await act(async () => {
      streams[streams.length - 1].fire('open', {});
    });

    const spy = vi.spyOn(globalThis, 'setTimeout');
    await failAndAdvance();
    const armed = spy.mock.calls
      .map((c) => c[1])
      .filter((ms): ms is number => typeof ms === 'number');
    spy.mockRestore();

    expect(Math.max(...armed)).toBe(RETRY_DELAYS_MS[1]);
  });

  it('BOUNDARY: a guest opens no stream at all', async () => {
    // There is no account to receive anything for, and opening would earn a 401
    // and a rebuild loop — which is what this whole file is trying to stop.
    mode = 'guest';
    await mount();
    expect(streams).toHaveLength(0);
  });
});

describe('the key-events stream declares its own authentication', () => {
  /*
   * FOUND BY MUTATION TESTING. Flipping the stream helper's default from
   * "assume signed in" to "assume guest" changed no result here — because this
   * caller passed nothing and silently relied on the default. A stream that
   * inherits an assumption is a stream that breaks when somebody edits the
   * assumption for the OTHER caller.
   *
   * This effect only runs for an authenticated session, so the value is
   * constant — the point is that it is stated, not inferred.
   */
  it('CONTRACT: a refused credential still stops this stream', async () => {
    await mount();
    /*
     * BOTH failures must carry the status. `failAndAdvance()` with no argument
     * is a plain network drop, which RESETS the refusal run by design — a
     * credential that is fine and a network that wobbled must not add up to a
     * dead session.
     */
    await act(async () => {
      streams[0].fire('error', { xhrStatus: 401 });
    });
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await act(async () => {
      streams[1].fire('error', { xhrStatus: 401 });
    });
    await act(async () => {
      vi.runOnlyPendingTimers();
    });

    // Two refusals in a row end it, exactly as for chat. If this caller relied
    // on a default that later flipped, it would retry forever instead.
    expect(streams).toHaveLength(2);
  });
});
