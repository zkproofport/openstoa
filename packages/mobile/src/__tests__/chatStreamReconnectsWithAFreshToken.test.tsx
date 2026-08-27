/**
 * The chat stream reconnects with a token it read just now, not the one it was
 * born with.
 *
 * THE DEFECT, reported from an iPhone as "메시지 보내면 Resend 계속 되고
 * Reconnecting 나온다", and diagnosed here by reading rather than guessing —
 * two earlier explanations (ghost MLS leaves, epoch churn) explained the ghost
 * devices but nothing about this banner.
 *
 *     const token = await host.getOpenStoaToken();   // read ONCE
 *     new EventSource(url, { headers: { Authorization: `Bearer ${token}` } });
 *     // react-native-sse then reconnects on its own — same headers, forever
 *     }, [topicId, host]);                           // host never changes
 *
 * The REST client refreshes the session and writes a NEW token back to the host
 * (`openstoaClient.ts`). So after a refresh the app held two truths at once:
 * ordinary requests worked, and the chat stream retried a dead credential until
 * the screen was closed. The banner appears once the stream has been not-open
 * for ten seconds and never cleared, because every retry carried the same
 * expired token. Sends made in that state failed and sat offering Resend.
 *
 * `host` is the host app's API singleton — one object for the life of the app —
 * so no dependency the effect watched could ever notice a token change.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → an error tears the stream down and builds a new one
 *   contract   → the new one carries the token read AT THAT MOMENT
 *   累積       → five failures in a row each re-read the token. THE axis: code
 *                that reconnects once passes a single-failure test and then
 *                sticks on the second, which on a phone is "it recovered once
 *                and then hung"
 *   累積       → the delay walks the ladder rather than repeating one interval
 *   integrity  → a stream that opens resets the ladder, so the next outage
 *                starts fast instead of inheriting the last one's patience
 *   integrity  → exactly one stream is alive at a time; a reconnect closes the
 *                previous one before opening another
 *   boundary   → unmounting while a retry is armed leaves nothing running
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';

/** Every EventSource this test made, in order, with the header it was given. */
const streams: Array<{
  token: string | null;
  closed: boolean;
  listeners: Record<string, (e: unknown) => void>;
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
        listeners: this.listeners,
        fire: (name, e) => this.listeners[name]?.(e ?? {}),
      };
      streams.push(this.entry);
    }
    addEventListener(name: string, fn: (e: unknown) => void) {
      this.listeners[name] = fn;
    }
    /*
     * The real EventSource has this, and the stream helper calls it before
     * closing. A fake without it threw inside the helper's try/catch, so the
     * close never ran and this file reported the stream as still open — a
     * failure invented entirely by the fake.
     */
    removeAllEventListeners() {
      this.listeners = {};
    }
    close() {
      this.entry.closed = true;
    }
  },
}));

/** The token the host currently holds. Rotated to stand in for a refresh. */
let currentToken = 'token-1';
/** Whether the session store reports somebody signed in. */
let signedIn = true;

vi.mock('@openstoa/miniapp-bridge', () => ({
  useHost: () => hostSingleton,
}));

/*
 * ONE object for the whole test file, exactly as the app has one for the life of
 * the process. Handing back a new object per render would make the effect
 * re-run on its own and hide the very bug this file is about.
 */
const hostSingleton = {
  getOpenStoaToken: async () => currentToken,
  getEnvironment: () => ({ openstoaBaseUrl: 'http://test' }),
  secureStore: undefined,
  localStore: undefined,
};

/*
 * Stable, like the real one. It happens not to matter here — this effect does
 * not depend on the client — but the sibling test for the key-events stream was
 * silently passing against reverted code because its client mock returned a new
 * object per render and re-ran the effect by itself. A fake that is less stable
 * than the real thing does not make a test stricter; it makes it blind.
 */
const clientSingleton = {};
vi.mock('../stores/sessionStore', () => ({
  useOpenStoaSession: Object.assign(
    (sel: (s: { mode: string }) => unknown) => sel({ mode: signedIn ? 'authenticated' : 'guest' }),
    { getState: () => ({ mode: signedIn ? 'authenticated' : 'guest' }) },
  ),
}));
vi.mock('../hooks/useOpenStoaClient', () => ({ useOpenStoaClient: () => clientSingleton }));
/*
 * STABLE, like the real store, which is a singleton per session. A fresh object
 * per call changes the effect's dependencies on every render, so the effect
 * re-runs by itself — which resets the retry ladder and makes every wait look
 * like the first one. Same trap as the client mock below, found the same way.
 */
const mlsSingleton = {};
vi.mock('../crypto/mobileTransport', () => ({
  getMlsSessionStore: () => mlsSingleton,
  toDisplayMessageMls: async (_m: unknown, _t: string, raw: unknown) => raw,
}));

import { useChatSocket } from '../api/chatSocket';
import { RETRY_DELAYS_MS } from '../crypto/backupRetry';

/*
 * Lets a case watch the status the hook reports. Declared outside the component
 * so a test can set it before mounting; reset in `beforeEach`.
 */
let statusSpy: ((s: string) => void) | null = null;

function Harness({ topicId }: { topicId: string }) {
  const { status } = useChatSocket(topicId);
  React.useEffect(() => {
    statusSpy?.(status);
  }, [status]);
  return null;
}

/** Render, and let the async connect settle. */
async function mount(topicId = 't1') {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<Harness topicId={topicId} />);
  });
  return tree;
}

/** Fail the newest stream and run the backoff timer it arms. */
async function failAndAdvance(xhrStatus?: number) {
  await act(async () => {
    streams[streams.length - 1].fire('error', { message: 'boom', xhrStatus });
  });
  await act(async () => {
    vi.runOnlyPendingTimers();
  });
}

beforeEach(() => {
  streams.length = 0;
  currentToken = 'token-1';
  statusSpy = null;
  signedIn = true;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the chat stream re-reads the token when it reconnects', () => {
  it('CONTRACT: a refreshed token is picked up by the reconnect', async () => {
    await mount();
    expect(streams).toHaveLength(1);
    expect(streams[0].token).toBe('token-1');

    // The REST client refreshed the session while the stream was open.
    currentToken = 'token-2';
    await failAndAdvance();

    expect(streams).toHaveLength(2);
    expect(streams[1].token, 'the reconnect must not reuse the dead token').toBe('token-2');
  });

  it('ACCUMULATING: five failures in a row each re-read the token', async () => {
    /*
     * THE AXIS THE DEFECT LIVED ON. A reconnect that happens once passes the
     * case above and then sticks — on a phone that reads as "it came back once
     * and then hung", which is indistinguishable from the original bug to
     * everyone except whoever is holding the phone.
     */
    await mount();

    for (let i = 2; i <= 6; i++) {
      currentToken = `token-${i}`;
      await failAndAdvance();
    }

    expect(streams).toHaveLength(6);
    expect(streams.map((s) => s.token)).toEqual([
      'token-1',
      'token-2',
      'token-3',
      'token-4',
      'token-5',
      'token-6',
    ]);
  });

  it('ACCUMULATING: the wait walks the ladder instead of repeating one interval', async () => {
    /*
     * A fixed delay is a hammer on a server that is already unwell, and the
     * ladder wraps rather than settling so a phone that was underground gets a
     * quick attempt soon after its signal returns.
     */
    await mount();
    const waits: number[] = [];
    const spy = vi.spyOn(globalThis, 'setTimeout');

    for (let i = 0; i < 3; i++) {
      spy.mockClear();
      await failAndAdvance();
      const armed = spy.mock.calls.map((c) => c[1]).filter((ms): ms is number => typeof ms === 'number');
      waits.push(Math.max(...armed));
    }
    spy.mockRestore();

    expect(waits).toEqual([RETRY_DELAYS_MS[1], RETRY_DELAYS_MS[2], RETRY_DELAYS_MS[3]]);
  });

  it('INTEGRITY: the failed stream is closed IMMEDIATELY, not when the retry fires', async () => {
    /*
     * The window is the point, and checking after the reconnect misses it: the
     * effect's cleanup would close the old stream anyway once `attempt` changes,
     * so a test that only looks at the end state passes against code that leaves
     * the dead stream running for the whole backoff — up to five minutes of
     * `react-native-sse` retrying the credential that just failed, which is the
     * behaviour this fix exists to stop.
     */
    await mount();
    await act(async () => {
      streams[0].fire('error', { message: 'boom' });
    });

    expect(streams[0].closed, 'the dead stream must not keep retrying').toBe(true);
    expect(streams, 'and nothing new opens until the backoff elapses').toHaveLength(1);
  });

  it('INTEGRITY: exactly one stream is alive after repeated reconnects', async () => {
    // Two live streams means duplicated messages and two sockets held open by a
    // screen showing one conversation.
    await mount();
    await failAndAdvance();
    await failAndAdvance();

    expect(streams.filter((s) => !s.closed)).toHaveLength(1);
  });

  it('INTEGRITY: a stream that opens resets the ladder', async () => {
    await mount();
    await failAndAdvance();
    await failAndAdvance();

    // It finally connects.
    await act(async () => {
      streams[streams.length - 1].fire('open');
    });

    const spy = vi.spyOn(globalThis, 'setTimeout');
    await failAndAdvance();
    const armed = spy.mock.calls.map((c) => c[1]).filter((ms): ms is number => typeof ms === 'number');
    spy.mockRestore();

    // Back to the fast end of the ladder, not the third rung it had climbed to.
    expect(Math.max(...armed)).toBe(RETRY_DELAYS_MS[1]);
  });

  it('BOUNDARY: unmounting while a retry is armed leaves nothing running', async () => {
    /*
     * An armed retry outlives the screen that armed it. Left alone it wakes up
     * and reconnects into an unmounted component — a stream nobody reads, kept
     * open by nobody watching.
     */
    const tree = await mount();
    await act(async () => {
      streams[streams.length - 1].fire('error', { message: 'boom' });
    });

    const before = streams.length;
    /*
     * Observed through `clearTimeout`, not through "no new stream appeared".
     * A timer that fires after unmount calls `setAttempt` on a dead component,
     * which React quietly ignores — so the end state looks identical whether the
     * timer was cancelled or simply wasted. The only visible difference is
     * whether the pending timer was cleared.
     */
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    await act(async () => {
      tree.unmount();
    });
    const clearedCount = cleared.mock.calls.length;
    cleared.mockRestore();

    await act(async () => {
      vi.runOnlyPendingTimers();
    });

    expect(clearedCount, 'the armed retry must be cancelled on unmount').toBeGreaterThan(0);
    expect(streams).toHaveLength(before);
    expect(streams.every((s) => s.closed)).toBe(true);
  });
});

describe('a refused credential stops the stream instead of retrying forever', () => {
  it('CONTRACT: two refusals in a row stop it, and nothing is armed', async () => {
    /*
     * A dropped connection wants patience; a refused credential wants the
     * person to sign in again. Retrying a refusal is how a signed-out phone
     * ends up knocking on the door every few minutes for the rest of the day —
     * and every knock is a request the server has to answer.
     */
    await mount();
    await failAndAdvance(401);
    // The first refusal still tries once more: the token may have been
    // refreshed a moment ago by a request running in parallel.
    expect(streams).toHaveLength(2);

    await act(async () => {
      streams[1].fire('error', { message: 'boom', xhrStatus: 401 });
    });
    await act(async () => {
      vi.runOnlyPendingTimers();
    });

    expect(streams, 'no third attempt after two refusals').toHaveLength(2);
    expect(streams.every((s) => s.closed)).toBe(true);
  });

  it('CONTRACT: 403 counts the same as 401', async () => {
    // Both mean "the server looked at this credential and said no". Only 401
    // was handled at first, which left the other one retrying forever.
    await mount();
    await failAndAdvance(403);
    await act(async () => {
      streams[1].fire('error', { message: 'boom', xhrStatus: 403 });
    });
    await act(async () => {
      vi.runOnlyPendingTimers();
    });

    expect(streams).toHaveLength(2);
  });

  it('ACCUMULATING: a refusal followed by a plain drop does NOT stop it', async () => {
    /*
     * THE AXIS. Counting refusals with a flag rather than a run — "have we ever
     * seen a 401?" — would stop a stream whose credential was fine and whose
     * network merely wobbled afterwards, which is a chat that goes dead on a
     * train. The count has to reset on anything that is not a refusal.
     */
    await mount();
    await failAndAdvance(401);
    await failAndAdvance(undefined); // a plain network drop
    await failAndAdvance(401);
    await failAndAdvance(undefined);

    // Still going: no two refusals ever landed back to back.
    expect(streams.length).toBeGreaterThanOrEqual(5);
  });

  it('INTEGRITY: a stream that opens in between forgives the earlier refusal', async () => {
    // Opening is proof the credential is good now. Holding the earlier refusal
    // against it would kill a stream that just demonstrated it works.
    await mount();
    await failAndAdvance(401);
    await act(async () => {
      streams[1].fire('open');
    });
    await failAndAdvance(401);

    expect(streams).toHaveLength(3);
  });

  it('CONTRACT: the screen is told it was refused, not that it is reconnecting', async () => {
    /*
     * "Reconnecting" is a lie once the server has said no — there is nothing to
     * reconnect to until the person signs in again, and a message that keeps
     * promising a recovery that cannot happen is why somebody sits waiting
     * instead of acting.
     */
    const seen: string[] = [];
    statusSpy = (s) => seen.push(s);
    await mount();
    await failAndAdvance(401);
    await act(async () => {
      streams[1].fire('error', { message: 'boom', xhrStatus: 401 });
    });

    expect(seen).toContain('rejected');
    expect(seen.lastIndexOf('rejected')).toBeGreaterThan(seen.lastIndexOf('connecting'));
  });
});

describe('a guest is never told their session died', () => {
  /*
   * Both cases answer 401: a signed-out person sending nothing, and a signed-in
   * person whose token expired. The SERVER distinguishes them — it now answers
   * `code: 'no-credential'` versus `code: 'credential-dead'` — but an
   * EventSource error event carries only the HTTP status, so the client cannot
   * read that code and has to know which side it is on from its own state.
   *
   * Without that, opening the app while signed out put "다시 로그인해 주세요"
   * in front of somebody who had never signed in — and worse, STOPPED the
   * stream, so it would not come back when they did sign in.
   */
  it('CONTRACT: a guest keeps retrying instead of being stopped', async () => {
    statusSpy = null;
    signedIn = false;
    await mount();

    await failAndAdvance(401);
    await failAndAdvance(401);
    await failAndAdvance(401);

    // Four streams: the first plus three retries. A refusal count would have
    // stopped this at two.
    expect(streams.length).toBeGreaterThanOrEqual(4);
  });

  it('CONTRACT: a signed-in person still stops after two refusals', async () => {
    // The control. If guests and members were treated alike in the other
    // direction, a dead session would knock forever again.
    signedIn = true;
    await mount();
    await failAndAdvance(401);
    await act(async () => {
      streams[1].fire('error', { message: 'boom', xhrStatus: 401 });
    });
    await act(async () => {
      vi.runOnlyPendingTimers();
    });

    expect(streams).toHaveLength(2);
  });

  it('ACCUMULATING: ten refusals as a guest never produce a rejected status', async () => {
    /*
     * THE AXIS. A guard that only checks the first refusal lets the message
     * appear on the third — which is exactly the state somebody sits in while
     * they are reading the sign-in screen.
     */
    const seen: string[] = [];
    statusSpy = (s) => seen.push(s);
    signedIn = false;
    await mount();

    for (let i = 0; i < 10; i++) await failAndAdvance(401);

    expect(seen).not.toContain('rejected');
  });
});
