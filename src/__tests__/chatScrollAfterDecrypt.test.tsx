// @vitest-environment jsdom
/**
 * The room scrolls to the bottom when it becomes READABLE, not only when a new
 * message arrives.
 *
 * The defect: the auto-scroll effect was keyed on the bottom row's ID, and
 * decryption never changes an id — `catchUpArchive` replaces bodies in place on
 * rows that are already in state. So the pass that finally turns a wall of
 * locked placeholders into a conversation returned before scrolling, and the
 * reader was left looking at wherever the empty rows had happened to put them.
 *
 * It compounded with `initialScrolledRef`, which the FIRST paint sets — a paint
 * where every row is locked and renders nothing. The scroll recorded as "done"
 * was a scroll over no content, and each row then grew twice: once as it
 * decrypted, and once as its `<img>` loaded.
 *
 * EDGE-CASE MATRIX → coverage
 *   contract   → decryption in place re-runs the bottom scroll
 *   contract   → an <img> finishing its load re-pins the bottom
 *   authz/read → a reader who has scrolled UP is never yanked back down
 *   boundary   → a shrink is not chased
 *   empty      → an empty room scrolls nothing
 *
 * jsdom has no layout engine, so `scrollTo` calls are counted rather than
 * positions measured — the same instrument `chatPanel-sync.test.tsx` uses, and
 * `scrollToBottom` calls exactly that (see its doc comment in ChatPanel).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushQueries } from './harness/providers';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOPIC = '11111111-2222-4333-8444-555555555555';
const ME = 'nullifier-me';

/** Resolved by the test, so the archive catch-up lands AFTER the first paint. */
let releaseBackfill: (rows: { messageId: string; plaintext: string }[]) => void;
let backfillPromise: Promise<{ messageId: string; plaintext: string }[]>;

const mlsStore = {
  // Nothing opens through MLS: these rows predate this device, which is the
  // whole reason the archive catch-up exists.
  openCached: vi.fn(async () => null),
  open: vi.fn(async () => null),
  seal: vi.fn(async (_t: string, plaintext: string) => ({ ciphertext: `ct-${plaintext}`, epoch: 0 })),
  cachePlaintext: vi.fn(async () => {}),
};

const takStore = {
  backfill: vi.fn(() => backfillPromise),
  myDeviceId: vi.fn(async () => 'device-1'),
  distributeRoot: vi.fn(async () => 0),
  distributeRootWhenGroupChanged: vi.fn(async () => 0),
  grantPrivateHistory: vi.fn(async () => {}),
  sealForPush: vi.fn(async () => null),
  takForPush: vi.fn(async () => null),
  archiveOnSend: vi.fn(async () => {}),
  archiveRootState: vi.fn(async () => 'verified'),
  backfillMissingArchive: vi.fn(async () => 0),
  forgetUnsettledRoot: vi.fn(() => {}),
  sealMedia: vi.fn(async () => null),
  openMedia: vi.fn(async () => ({ ok: false as const, reason: 'no-key' as const })),
};

vi.mock('@/lib/mls/webTransport', () => ({
  getMlsSessionStore: () => mlsStore,
  getTakSessionStore: () => takStore,
  getDeviceKeyState: async () => 'ready',
  recoverDeviceWithPasskey: async () => true,
}));

const { default: ChatPanel } = await import('@/components/ChatPanel');
const { TestProviders } = await import('./harness/providers');

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  close() {}
}

/** The panel's growth observer, captured so a test can fire it deliberately. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  target: Element | null = null;
  constructor(public cb: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.target = el;
  }
  disconnect() {
    this.target = null;
  }
}

let scrollCalls: number;
let container: HTMLDivElement;
let root: Root;
let history: Record<string, unknown>[];

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function wire(n: number) {
  return {
    id: `m${n}`,
    topicId: TOPIC,
    userId: 'nullifier-other',
    nickname: 'alice',
    type: 'message',
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    message: null,
    sealed: { ciphertext: `ct-m${n}`, epoch: 0 },
  };
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/session') return json({ userId: ME });
      // Matched by SHAPE, not by one id: the empty-room case needs a topic the
      // module-level paint cache has never seen (see that test).
      if (/^\/api\/topics\/[^/?]+$/.test(url)) {
        return json({ topic: { visibility: 'public' }, currentUserRole: 'member' });
      }
      if (/^\/api\/topics\/[^/]+\/chat\?/.test(url)) {
        return json({ messages: history, total: history.length });
      }
      return json({ ok: true });
    }),
  );
}

/*
 * A macrotask drain, not a microtask one.
 *
 * TanStack Query delivers results through `notifyManager`, which schedules on a
 * real `setTimeout(0)` — so draining microtasks alone leaves every query result
 * undelivered and every assertion reading "not yet". Same helper, same reason,
 * as the mini-app harness's `settle`.
 */
const flush = flushQueries;

async function mount(topicId = TOPIC) {
  await act(async () => {
    root.render(
      <TestProviders initialLocale="en">
        <ChatPanel topicId={topicId} isGuest={false} isMember={true} />
      </TestProviders>,
    );
  });
  await flush();
}

/** The panel's own scroller — the element `scrollToBottom` writes to. */
function scroller(): HTMLElement {
  const observed = FakeResizeObserver.instances.at(-1)?.target;
  if (!observed?.parentElement) throw new Error('the message list was never observed');
  return observed.parentElement;
}

/** Grow the observed content box and let the observer see it. */
async function grow(height: number) {
  const ro = FakeResizeObserver.instances.at(-1)!;
  Object.defineProperty(ro.target!, 'getBoundingClientRect', {
    value: () => ({ height }) as DOMRect,
    configurable: true,
  });
  await act(async () => ro.cb());
  await flush(2);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  scrollCalls = 0;
  history = [wire(1), wire(2), wire(3)];
  backfillPromise = new Promise((resolve) => {
    releaseBackfill = resolve;
  });
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = function scrollIntoView() {
    scrollCalls++;
  };
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = function scrollTo() {
    scrollCalls++;
  };
  window.localStorage.clear();
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver as unknown as typeof ResizeObserver);
  installFetch();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  FakeEventSource.instances = [];
  FakeResizeObserver.instances = [];
  vi.unstubAllGlobals();
});

describe('scrolling to the bottom when the room becomes readable', () => {
  it('CONTRACT: decrypting rows in place re-runs the bottom scroll', async () => {
    await mount();
    // The first paint has already happened, over rows that render nothing.
    const afterFirstPaint = scrollCalls;
    expect(afterFirstPaint).toBeGreaterThan(0);

    await act(async () => {
      releaseBackfill([
        { messageId: 'm1', plaintext: 'one' },
        { messageId: 'm2', plaintext: 'two' },
        { messageId: 'm3', plaintext: 'three' },
      ]);
    });
    await flush();

    expect(container.textContent, 'the rows never decrypted').toContain('three');
    expect(
      scrollCalls,
      'the pass that made the room readable did not scroll — ids do not change when a body does',
    ).toBeGreaterThan(afterFirstPaint);
  });

  it('CONTRACT: an attachment finishing its load re-pins the bottom', async () => {
    await mount();
    await act(async () => releaseBackfill([{ messageId: 'm3', plaintext: 'three' }]));
    await flush();
    const before = scrollCalls;

    // An <img> is zero-high until its bytes arrive and hundreds of pixels
    // afterwards. No state changes, so no effect can see it — only the box does.
    await grow(900);

    expect(scrollCalls, 'the list grew under a reader at the bottom and nothing moved').toBeGreaterThan(before);
  });

  it('AUTHZ-of-attention: a reader who scrolled UP is never yanked back down', async () => {
    await mount();
    await act(async () => releaseBackfill([{ messageId: 'm3', plaintext: 'three' }]));
    await flush();

    const el = scroller();
    Object.defineProperty(el, 'scrollHeight', { value: 4000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    el.scrollTop = 200;
    await act(async () => {
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const before = scrollCalls;

    await grow(2000);

    expect(scrollCalls, 'reading history was interrupted by a picture loading below').toBe(before);
  });

  it('BOUNDARY: a shrink is not chased', async () => {
    await mount();
    await act(async () => releaseBackfill([{ messageId: 'm3', plaintext: 'three' }]));
    await flush();
    await grow(900);
    const before = scrollCalls;

    await grow(100);

    expect(scrollCalls).toBe(before);
  });

  it('EMPTY: a room with no messages scrolls nothing', async () => {
    /*
     * A topic id no earlier case in this file used. `ChatPanel` keeps a
     * module-level paint cache of the last rows painted per room, so re-opening
     * `TOPIC` here would restore three messages, scroll for them, and only then
     * find the room empty — which is correct product behaviour and the wrong
     * arrangement for this assertion.
     */
    history = [];
    await mount('99999999-8888-4777-8666-555555555555');
    await act(async () => releaseBackfill([]));
    await flush();

    expect(scrollCalls).toBe(0);
  });
});
