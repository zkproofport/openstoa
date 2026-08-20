// @vitest-environment jsdom
/**
 * The browser acting on "somebody needs keys", without opening that chat.
 *
 * The web has no push. So for a browser holding a private topic's keys, this
 * stream is the ONLY way it can be told to hand them over — otherwise the
 * newcomer waits for its user to happen to open that exact conversation, which
 * is the bug this whole change is about.
 *
 * `useAccountEvents.ts` is small, and almost all of it is decisions that go
 * wrong quietly: opening a stream for a signed-out visitor, granting twice for
 * one topic, letting a grant failure escape into the page, keeping the stream
 * after unmount. Those are the assertions.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → an event runs the grant for the topic it names
 *   authz      → a signed-out visitor opens no stream at all
 *   race       → repeats for one topic while a grant is in flight collapse to
 *                one; a later event for the same topic still runs
 *   hostile    → junk JSON, a missing topicId, and a non-string topicId are
 *                ignored rather than passed on
 *   empty      → an empty topicId is not a topic
 *   external   → a grant that rejects does not surface, and does not wedge the
 *                in-flight guard for the next event
 *   boundary   → two different topics both run
 *   UTF-8 / very large → N/A: the payload is an id the server minted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const grantMock = vi.hoisted(() => vi.fn(async (_topicId: string) => {}));
vi.mock('@/lib/keyGrant', () => ({ grantRoomKeys: grantMock }));

const { useAccountEvents } = await import('@/lib/useAccountEvents');

/** Records what was opened, and lets a test push events into it. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
  }
  static get last(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }
}

function Probe({ enabled }: { enabled: boolean }) {
  useAccountEvents(enabled);
  return null;
}

let container: HTMLDivElement;
let root: Root;

async function mount(enabled = true) {
  await act(async () => {
    root.render(<Probe enabled={enabled} />);
  });
}

/** Let the grant's promise chain settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => void (await Promise.resolve()));
}

beforeEach(() => {
  grantMock.mockClear();
  grantMock.mockImplementation(async () => {});
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('the account stream on the web', () => {
  it('CONTRACT: a key-needed event grants for the topic it names', async () => {
    await mount();
    await act(async () => FakeEventSource.last.emit('key-needed', { topicId: 't1', epoch: 3 }));
    await settle();

    expect(grantMock).toHaveBeenCalledWith('t1');
  });

  it('AUTHZ: a signed-out visitor opens no stream', async () => {
    // There is no account to receive anything for, and the request would only
    // earn a 401 and a reconnect loop.
    await mount(false);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('RACE: repeats for one topic collapse into a single grant', async () => {
    // The server broadcasts to every member, so several events for one room
    // arrive together; each starting its own pass over the same leaves is waste
    // at best and interleaved writes at worst.
    let release: () => void = () => {};
    grantMock.mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );

    await mount();
    await act(async () => {
      FakeEventSource.last.emit('key-needed', { topicId: 't1' });
      FakeEventSource.last.emit('key-needed', { topicId: 't1' });
      FakeEventSource.last.emit('key-needed', { topicId: 't1' });
    });

    expect(grantMock).toHaveBeenCalledTimes(1);

    await act(async () => release());
    await settle();

    // And the guard clears, so a later event is not swallowed forever.
    await act(async () => FakeEventSource.last.emit('key-needed', { topicId: 't1' }));
    await settle();
    expect(grantMock).toHaveBeenCalledTimes(2);
  });

  it('BOUNDARY: two different topics both run', async () => {
    await mount();
    await act(async () => {
      FakeEventSource.last.emit('key-needed', { topicId: 't1' });
      FakeEventSource.last.emit('key-needed', { topicId: 't2' });
    });
    await settle();

    expect(grantMock.mock.calls.map((c) => c[0]).sort()).toEqual(['t1', 't2']);
  });

  it.each([
    ['junk that is not JSON', 'not json at all'],
    ['no topicId', JSON.stringify({ epoch: 1 })],
    ['a non-string topicId', JSON.stringify({ topicId: 42 })],
    ['a null topicId', JSON.stringify({ topicId: null })],
    ['an empty topicId', JSON.stringify({ topicId: '' })],
  ])('HOSTILE/EMPTY: %s grants nothing', async (_label, payload) => {
    await mount();
    await act(async () => FakeEventSource.last.emit('key-needed', payload));
    await settle();

    expect(grantMock).not.toHaveBeenCalled();
  });

  it('EXTERNAL FAILURE: a rejected grant does not escape, and unblocks the next one', async () => {
    // Rejecting is the COMMON case: most members hold nothing for the topic in
    // the broadcast. An unhandled rejection per event would be constant noise.
    grantMock.mockRejectedValueOnce(new Error('holds nothing'));

    await mount();
    await act(async () => FakeEventSource.last.emit('key-needed', { topicId: 't1' }));
    await settle();

    await act(async () => FakeEventSource.last.emit('key-needed', { topicId: 't1' }));
    await settle();
    expect(grantMock).toHaveBeenCalledTimes(2);
  });

  it('EXTERNAL: an environment with no EventSource is skipped, not crashed', async () => {
    /*
     * This hook lives in the layout wrapping every community page, so a throw
     * here takes the page down — which is exactly what happened the first time
     * it was mounted somewhere without the API. Losing the nudge costs a delay
     * the room's own retry already covers.
     */
    vi.stubGlobal('EventSource', undefined);

    await expect(mount()).resolves.toBeUndefined();
    expect(container.isConnected, 'the page came down with the stream').toBe(true);
    expect(grantMock).not.toHaveBeenCalled();
  });

  it('CONTRACT: unmounting closes the stream', async () => {
    await mount();
    const es = FakeEventSource.last;
    await act(async () => root.unmount());

    expect(es.closed).toBe(true);
    // Re-created for the afterEach unmount, which must not throw.
    root = createRoot(container);
  });
});
