// @vitest-environment jsdom
/**
 * The reader keeps seeing the NEWEST message while the room fills in — and the
 * panel does it by geometry, not by chasing.
 *
 * WHAT THIS FILE USED TO ASSERT, and why it was rewritten. The panel rendered a
 * normal column and scrolled to the floor whenever anything changed, so these
 * tests COUNTED scrolls: a decrypt had to produce one, a growing `<img>` had to
 * produce one. That is what the mechanism did, and the mechanism was wrong.
 * Three of them ran at once — an anchor holding a row still, an
 * `onContentSizeChange`-equivalent forcing the floor, a first-paint scroll —
 * and with several pictures resolving a few frames apart they took turns
 * winning. The owner filmed the result twice ("올라갔다 내려갔다").
 *
 * The column is now `column-reverse`: the newest message is at offset 0, so
 * everything that grows, grows AWAY from the reader. Measured in Chrome before
 * the change was written — a 300px viewport over 30 rows, `scrollTop` 0 at
 * rest; growing a MIDDLE row by 400px moved the newest row's edge by 0px;
 * appending a 10-row older page moved it by 0px. Signal Android
 * (`setReverseLayout(true)`) and Telegram Android do the same, which is why
 * neither shows this and why KakaoTalk does not either.
 *
 * So the correct assertion INVERTED. A decrypt must now produce NO scroll, and
 * a picture loading must produce NO scroll — a scroll there would mean the
 * chasing came back. What still has to hold is the guarantee itself, and that
 * is asserted structurally.
 *
 * EDGE-CASE MATRIX → coverage
 *   contract   → the column is reversed, which is what makes offset 0 the newest
 *   contract   → rows render newest-first, so the reversed column reads in order
 *   contract   → decryption in place scrolls NOTHING
 *   contract   → an <img> finishing its load scrolls NOTHING
 *   contract   → a message ARRIVING while the reader is at the newest does pull
 *   authz/read → a reader who has scrolled UP is never yanked down
 *   empty      → an empty room scrolls nothing
 *
 * jsdom has no layout engine, so scrolls are COUNTED rather than positions
 * measured — the same instrument `chatPanel-sync.test.tsx` uses.
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
  /** Deliver one server-sent event to whoever subscribed to `type`. */
  emit(type: string, event: { data: string }) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
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

/**
 * The reversed message column.
 *
 * Found by the property under test rather than by a test id: the column IS the
 * element whose `flex-direction` is `column-reverse`, so a change that drops
 * the reversal fails the lookup instead of quietly passing a weaker assertion
 * against some other div.
 */
function content(): HTMLElement {
  const el = Array.from(container.querySelectorAll<HTMLElement>('div')).find(
    (d) => d.style.flexDirection === 'column-reverse',
  );
  if (!el) throw new Error('no reversed message column: the panel is not inverted');
  return el;
}

/** The panel's own scroller — the reversed column's parent. */
function scroller(): HTMLElement {
  const parent = content().parentElement;
  if (!parent) throw new Error('the message column has no scroller');
  return parent;
}

/** Push one row down the stream, the way a message really arrives. */
function deliver(row: Record<string, unknown>) {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error('the panel never opened a stream');
  // The stream carries the message row ITSELF, not a wrapper — see the
  // panel's `message` listener, which parses `e.data` straight into `ingest`.
  source.emit('message', { data: JSON.stringify(row) });
}

/**
 * Grow the message column, as a picture resolving its height does.
 *
 * No observer to fire any more — that was the point of removing it — so this
 * changes the box and lets React settle. If anything still reacts to a growing
 * list by scrolling, the assertions catch it.
 */
async function grow(height: number) {
  Object.defineProperty(content(), 'getBoundingClientRect', {
    value: () => ({ height }) as DOMRect,
    configurable: true,
  });
  await act(async () => {});
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
  installFetch();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe('scrolling to the bottom when the room becomes readable', () => {
  it('CONTRACT: the message column is REVERSED, which is what pins the newest', async () => {
    await mount();
    await act(async () => releaseBackfill([{ messageId: 'm3', plaintext: 'three' }]));
    await flush();

    // Every guarantee below rests on this one property. Asserted directly so a
    // future edit that drops it fails here rather than in a bug report.
    expect(content().style.flexDirection).toBe('column-reverse');
  });

  it('CONTRACT: rows render NEWEST-FIRST, so the reversed column reads in order', async () => {
    await mount();
    await act(async () =>
      releaseBackfill([
        { messageId: 'm1', plaintext: 'one' },
        { messageId: 'm2', plaintext: 'two' },
        { messageId: 'm3', plaintext: 'three' },
      ]),
    );
    await flush();

    const text = content().textContent ?? '';
    // Reversed, the FIRST child is at the visual bottom. Newest first in the
    // DOM is therefore newest at the bottom on screen; getting this backwards
    // renders the whole conversation upside down without erroring.
    expect(text.indexOf('three')).toBeLessThan(text.indexOf('one'));
  });

  it('CONTRACT: decrypting rows in place scrolls NOTHING', async () => {
    await mount();
    const afterFirstPaint = scrollCalls;

    await act(async () => {
      releaseBackfill([
        { messageId: 'm1', plaintext: 'one' },
        { messageId: 'm2', plaintext: 'two' },
        { messageId: 'm3', plaintext: 'three' },
      ]);
    });
    await flush();

    expect(container.textContent, 'the rows never decrypted').toContain('three');
    /*
     * The inversion of the old assertion. Bodies arriving cannot move the
     * newest message, so a scroll here would mean something started chasing the
     * floor again — the exact regression this file now exists to catch.
     */
    expect(scrollCalls, 'a decrypt scrolled: the chasing came back').toBe(afterFirstPaint);
  });

  it('CONTRACT: an attachment finishing its load scrolls NOTHING', async () => {
    await mount();
    await act(async () => releaseBackfill([{ messageId: 'm3', plaintext: 'three' }]));
    await flush();
    const before = scrollCalls;

    // An <img> is zero-high until its bytes arrive and hundreds of pixels
    // afterwards. In the reversed column that growth happens above the newest
    // message, so nothing has to move — and there is no observer left to fire.
    await grow(900);

    expect(scrollCalls, 'a picture loading scrolled: the chasing came back').toBe(before);
  });

  it('CONTRACT: a message ARRIVING while the reader is at the newest pulls the view', async () => {
    await mount();
    await act(async () => releaseBackfill([{ messageId: 'm3', plaintext: 'three' }]));
    await flush();
    const before = scrollCalls;

    // The one case that still scrolls: a row appears at the newest end while
    // the reader is sitting there. Delivered the way the panel really receives
    // one — over the stream.
    await act(async () => {
      deliver({ ...wire(4), message: null });
    });
    await flush(2);

    expect(scrollCalls, 'a new message did not bring the reader with it').toBeGreaterThan(before);
  });

  it('AUTHZ-of-attention: a reader who scrolled UP is never yanked back down', async () => {
    await mount();
    await act(async () => releaseBackfill([{ messageId: 'm3', plaintext: 'three' }]));
    await flush();

    /*
     * Reversed, distance from the newest is |scrollTop| — the panel reads it
     * through `Math.abs` because Chrome and Firefox report it negative and
     * Safari has reported it positive. 200 either way is "scrolled back".
     */
    const el = scroller();
    Object.defineProperty(el, 'scrollHeight', { value: 4000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    el.scrollTop = -200;
    await act(async () => {
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const before = scrollCalls;

    await act(async () => {
      deliver({ ...wire(5), message: null });
    });
    await flush(2);

    expect(scrollCalls, 'reading history was interrupted by someone else typing').toBe(before);
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
