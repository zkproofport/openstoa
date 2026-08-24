// @vitest-environment jsdom
/**
 * ChatPanel — the E2EE statement, the connection state, and the composer.
 *
 * Why these three are one file: they are the chat surface's *informational*
 * layer, and each was a defect of the same kind — the product knew something
 * the interface never said out loud.
 *
 *   · End-to-end encryption is the whole claim of this chat, and before this
 *     change the string "encrypt" appeared only in implementation comments.
 *     A user had no way to learn from the UI that the server cannot read the
 *     messages.
 *   · Connection state was a 7px dot whose only label was a `title` attribute
 *     — nothing for a screen reader, and ambiguous for everyone else.
 *   · The send control was a text button, so the composer's geometry changed
 *     with the length of the word "Send" in the active locale.
 *
 * Edge-case matrix rows covered here:
 *   contract   — banner copy comes from i18n, asserted against the dictionary
 *                itself in BOTH locales (never a literal in the component)
 *   authz      — guest / non-member sees the claim but no connection state
 *   connection — pre-open, connected, and dropped states each say a visible
 *                word, and the region is announced (`aria-live`)
 *   race       — first paint happens before the SSE opens; it must read
 *                "Reconnecting", never blank
 *   a11y       — the send control keeps an accessible name once it is an icon
 *   boundary   — composer input holds the 16px floor (below it iOS Safari
 *                zooms the page on focus) and the 44px touch target
 *   regression — the panel introduces no second `role="status"`; that selector
 *                is load-bearing in lockedHistory.test.tsx
 */
import enLocale from '@/lib/i18n/locales/en.json';
import { TIER_CLAIM_VISIBLE_MS } from '@/lib/chatTierExplainer';
import koLocale from '@/lib/i18n/locales/ko.json';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOPIC = '11111111-2222-4333-8444-555555555555';

vi.mock('@/lib/mls/webTransport', () => ({
  getMlsSessionStore: () => ({
    open: async () => null,
    openCached: async () => null,
    seal: async () => ({ ciphertext: 'ct', epoch: 0 }),
    cachePlaintext: async () => {},
  }),
  getTakSessionStore: () => ({
    backfill: async () => [],
    backfillMissingArchive: async () => {},
    myDeviceId: async () => 'device-1',
    distributeRoot: async () => 0,
    // On a TIMER in the panel, so no test reached it until one started
    // advancing the clock. Absent from this double it threw "is not a
    // function" — a mock that is only complete for the tests that happen to
    // run synchronously.
    distributeRootWhenGroupChanged: async () => 0,
    reconcileMembership: async () => {},
    archiveRootState: async () => null,
    forgetUnsettledRoot: () => {},
    grantPrivateHistory: async () => {},
    sealForPush: async () => null,
    archiveOnSend: async () => {},
  }),
  // 'ready' keeps LockedHistoryNotice (the panel's one role="status") out of
  // the way — its own behaviour is pinned by lockedHistory.test.tsx.
  getDeviceKeyState: async () => 'ready',
  recoverDeviceWithPasskey: async () => true,
}));

vi.mock('@/components/TopicMuteToggle', () => ({
  default: () => React.createElement('div', { 'data-testid': 'mute-toggle' }),
}));

const { default: ChatPanel } = await import('@/components/ChatPanel');
const { I18nProvider } = await import('@/lib/i18n/I18nProvider');

// ─── EventSource double ──────────────────────────────────────────────────────

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
  open() {
    this.onopen?.();
  }
  fail() {
    this.onerror?.();
  }
  static get last(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }
}

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

// ─── Harness ─────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(
  props: Partial<React.ComponentProps<typeof ChatPanel>> = {},
  locale: 'en' | 'ko' = 'en',
) {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale={locale}>
        <ChatPanel topicId={TOPIC} isGuest={false} isMember {...props} />
      </I18nProvider>,
    );
  });
  await flush();
}

function banner(): HTMLElement | null {
  return container.querySelector('[data-testid="chat-e2ee-banner"]');
}

function connection(): HTMLElement | null {
  return container.querySelector('[data-testid="chat-connection-state"]');
}

function sendButton(): HTMLButtonElement {
  return container.querySelector(`button[aria-label="${enLocale.chat.send}"]`) as HTMLButtonElement;
}

// A textarea since Shift+Enter had to be able to insert a newline — see
// chatComposerNewline.test.tsx. An <input> cannot hold one.
function composerInput(): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

/**
 * What `GET /api/topics/{id}` answers for the room under test — the two fields
 * the banner derives its tier from. Public by default, because that is the tier
 * whose claim is most easily got wrong; a case that needs another tier sets
 * this before mounting.
 */
let topicMeta: { visibility?: string; kind?: string } = { visibility: 'public' };

/**
 * When set, the topic lookup does not answer until this resolves — the only way
 * to observe the frame BEFORE the tier is known, which is where a banner could
 * flash a promise it has to withdraw.
 */
let topicMetaGate: Promise<void> | null = null;

beforeEach(() => {
  topicMeta = { visibility: 'public' };
  topicMetaGate = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/session') return json({ userId: 'me' });
      if (url === `/api/topics/${TOPIC}`) {
        if (topicMetaGate) await topicMetaGate;
        return json({ topic: topicMeta, currentUserRole: 'member' });
      }
      if (url.startsWith(`/api/topics/${TOPIC}/chat`)) return json({ messages: [], total: 0 });
      return json({ error: 'not found' }, false, 404);
    }),
  );
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('E2EE banner', () => {
  /*
   * This panel is mounted over a PUBLIC topic (see the fetch stub above), and
   * public is the one tier whose archive key the server holds. The banner used
   * to say "the server cannot read this" in every room, which was false here —
   * so the cases below assert the tier-appropriate claim AND the absence of the
   * encryption promise. A regression that restores the old single string fails
   * both halves.
   */
  it('CONTRACT: a PUBLIC room says the service can read it — and never claims e2ee', async () => {
    await mount();

    expect(banner()).not.toBeNull();
    expect(banner()!.textContent).toContain(enLocale.chat.tierClaim.serverReadable);
    expect(banner()!.textContent).not.toContain(enLocale.chat.tierClaim.e2ee);
    // The claim itself, not a paraphrase: the service must be named as able to
    // read this tier's history.
    expect(enLocale.chat.tierClaim.serverReadable.toLowerCase()).toContain('service');
    expect(banner()!.getAttribute('data-claim')).toBe('serverReadable');
  });

  it('LOCALE ko: the same banner renders the Korean string, not the English one', async () => {
    await mount({}, 'ko');

    expect(banner()!.textContent).toContain(koLocale.chat.tierClaim.serverReadable);
    expect(banner()!.textContent).not.toContain(enLocale.chat.tierClaim.serverReadable);
  });

  it('AUTHZ guest: the claim still shows, but there is no connection state', async () => {
    // A guest is deciding whether to join; what the service can read is exactly
    // the thing they are deciding about.
    await mount({ isGuest: true, isMember: false });

    expect(banner()).not.toBeNull();
    expect(banner()!.textContent).toContain(enLocale.chat.tierClaim.serverReadable);
    expect(banner()!.textContent).not.toContain(enLocale.chat.tierClaim.e2ee);
    expect(connection()).toBeNull();
  });

  it('a PRIVATE room does claim end-to-end encryption — the promise is real there', async () => {
    topicMeta = { visibility: 'private' };
    await mount();

    expect(banner()!.getAttribute('data-claim')).toBe('e2ee');
    expect(banner()!.textContent).toContain(enLocale.chat.tierClaim.e2ee);
    expect(banner()!.textContent).not.toContain(enLocale.chat.tierClaim.serverReadable);
  });

  it('a SECRET room claims it too', async () => {
    topicMeta = { visibility: 'secret' };
    await mount();

    expect(banner()!.getAttribute('data-claim')).toBe('e2ee');
  });

  it('a DM claims it whatever visibility its row carries', async () => {
    // A DM is a two-member topic with `kind='dm'`; its `visibility` column is
    // not the thing that decides its tier, and reading it would be the bug.
    topicMeta = { visibility: 'public', kind: 'dm' };
    await mount();

    expect(banner()!.getAttribute('data-claim')).toBe('e2ee');
  });

  it('RACE: before the topic lookup answers, the banner promises the LEAST', async () => {
    /*
     * The lookup is a fetch; the first frame paints without it. A panel that
     * defaulted to "end-to-end encrypted" would flash a promise it might then
     * have to withdraw — so the default is the tier that claims least, and a
     * private room is only upgraded once the answer is in.
     */
    topicMeta = { visibility: 'private' };
    let answer: () => void = () => {};
    topicMetaGate = new Promise<void>((resolve) => {
      answer = resolve;
    });

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <ChatPanel topicId={TOPIC} isGuest={false} isMember />
        </I18nProvider>,
      );
    });
    // The lookup is still in flight here — this is the frame a real reader sees
    // on a slow network.
    expect(banner()!.getAttribute('data-claim')).toBe('serverReadable');

    await act(async () => {
      answer();
    });
    await flush();
    expect(banner()!.getAttribute('data-claim')).toBe('e2ee');
  });

  it('HOSTILE: an unrecognised visibility never buys the encryption promise', async () => {
    for (const bad of ['PRIVATE', 'sekret', '', '{}']) {
      topicMeta = { visibility: bad };
      await mount();
      expect(banner()!.getAttribute('data-claim'), bad).toBe('serverReadable');
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  it('CONTRACT: the banner links to the page that explains the tiers', async () => {
    await mount();
    const link = banner()!.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/docs/tiers');
    expect(link?.textContent).toBe(enLocale.chat.tierClaim.learnMore);
  });

  it('AUTHZ non-member: same as guest — claim shown, no connection state', async () => {
    await mount({ isGuest: false, isMember: false });

    expect(banner()).not.toBeNull();
    expect(connection()).toBeNull();
  });

  it('CONTRACT: the banner survives hideHeader — the rail supplies its own header', async () => {
    await mount({ hideHeader: true, fullHeight: true, roomy: true });

    expect(container.querySelector('[data-testid="mute-toggle"]')).toBeNull(); // header really is hidden
    expect(banner()).not.toBeNull();
    expect(connection()).not.toBeNull();
  });
});

describe('the claim withdraws, the marker does not', () => {
  /*
   * The sentence used to stand above every conversation forever. On a phone
   * that is three or four lines of standing notice, which is furniture, and
   * furniture goes unread — worst in exactly this tier, where the sentence is a
   * WARNING ("the service holds a key to its history and can read it") rather
   * than a reassurance.
   *
   * So the sentence withdraws after `TIER_CLAIM_VISIBLE_MS`. What must not
   * withdraw with it is the claim: the strip keeps its per-tier colour, its
   * 🔒 / ℹ️ marker and the connection dot, and the marker is a button that says
   * the sentence again. These cases hold that line — a change that hid the
   * whole strip would pass "the sentence goes away" and fail here.
   */
  beforeEach(() => {
    // The panel awaits real microtasks while mounting; a frozen clock would
    // deadlock those rather than merely holding the withdraw timer.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const withdraw = async () => {
    await act(async () => {
      vi.advanceTimersByTime(TIER_CLAIM_VISIBLE_MS + 1);
    });
  };

  const claimButton = () =>
    container.querySelector('[data-testid="chat-tier-claim-button"]') as HTMLButtonElement | null;

  it('CONTRACT: the sentence is read on entry, then withdraws', async () => {
    await mount();
    expect(banner()!.textContent).toContain(enLocale.chat.tierClaim.serverReadable);

    await withdraw();
    expect(banner()!.textContent).not.toContain(enLocale.chat.tierClaim.serverReadable);
  });

  it('CONTRACT: the strip, its tier and the connection dot all stay behind', async () => {
    await mount();
    await withdraw();

    // Still a strip, still tier-marked, still carrying the connection state —
    // the room is not allowed to become indistinguishable from any other.
    expect(banner()).not.toBeNull();
    expect(banner()!.getAttribute('data-claim')).toBe('serverReadable');
    expect(banner()!.getAttribute('data-expanded')).toBe('false');
    expect(connection()).not.toBeNull();
  });

  it('CONTRACT: the marker is a button that says the sentence again', async () => {
    await mount();
    await withdraw();

    const button = claimButton();
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      button!.click();
    });

    expect(banner()!.textContent).toContain(enLocale.chat.tierClaim.serverReadable);
    expect(claimButton()!.getAttribute('aria-expanded')).toBe('true');
  });

  it('A11Y: the marker is named by the claim, so it is never a bare emoji', async () => {
    await mount();
    await withdraw();

    // The emoji is aria-hidden; without a name on the button the only remaining
    // statement of the tier would be a colour.
    expect(claimButton()!.getAttribute('aria-label')).toBe(enLocale.chat.tierClaim.serverReadable);
  });

  it('BOUNDARY: an upgraded tier gets its own reading time, not the tail of the old one', async () => {
    /*
     * The tier arrives from a lookup, so a private room shows the public
     * sentence first (see the RACE case above). If the timer ran from mount,
     * the true sentence could land on an already-expired window and never be
     * read at all — the one reader who most needs it is the one on a slow
     * connection.
     */
    topicMeta = { visibility: 'private' };
    let answer: () => void = () => {};
    topicMetaGate = new Promise<void>((resolve) => {
      answer = resolve;
    });

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <ChatPanel topicId={TOPIC} isGuest={false} isMember />
        </I18nProvider>,
      );
    });
    await withdraw();
    expect(banner()!.getAttribute('data-expanded')).toBe('false');

    await act(async () => {
      answer();
    });
    await flush();

    expect(banner()!.getAttribute('data-claim')).toBe('e2ee');
    expect(banner()!.getAttribute('data-expanded')).toBe('true');
    expect(banner()!.textContent).toContain(enLocale.chat.tierClaim.e2ee);
  });
});

describe('connection state', () => {
  /*
   * The state used to be a WORD next to the encryption line. It changed width
   * between "Connected" and "Reconnecting", wrapped that line to a second row
   * at panel widths, and so pushed the whole message list down and back every
   * time the stream blinked. It is now a fixed 6px dot and the word moved to
   * the accessible name — same information, no geometry.
   */
  const stateName = (locale: typeof enLocale) => (word: string) =>
    `${locale.chat.connectionStatusLabel}: ${word}`;

  it('RACE: before the stream opens it says Reconnecting, never blank', async () => {
    await mount();

    expect(connection()!.getAttribute('aria-label')).toBe(stateName(enLocale)(enLocale.chat.reconnecting));
  });

  it('once the stream is live it says Connected', async () => {
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    expect(connection()!.getAttribute('aria-label')).toBe(stateName(enLocale)(enLocale.chat.connected));
  });

  it('a dropped transport flips it back to Reconnecting', async () => {
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();
    await act(async () => FakeEventSource.last.fail());
    await flush();

    expect(connection()!.getAttribute('aria-label')).toBe(stateName(enLocale)(enLocale.chat.reconnecting));
  });

  it('CONTRACT: it carries no TEXT, so its width cannot change with the state', async () => {
    // This is the whole point of the change — assert the geometry, not just
    // the wording, or the chip comes back the next time someone wants a label.
    await mount();
    const before = connection()!.textContent;
    await act(async () => FakeEventSource.last.open());
    await flush();

    expect(before).toBe('');
    expect(connection()!.textContent).toBe('');
  });

  it('A11Y: the state is an announced live region with a name', async () => {
    await mount();

    expect(connection()!.getAttribute('aria-live')).toBe('polite');
    expect(connection()!.getAttribute('aria-atomic')).toBe('true');
    expect(connection()!.getAttribute('aria-label')).toContain(enLocale.chat.connectionStatusLabel);
  });

  it('A11Y: hovering shows the same word, for readers who are not using AT', async () => {
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    expect(connection()!.getAttribute('title')).toBe(enLocale.chat.connected);
  });

  it('LOCALE ko: the connection word is Korean', async () => {
    await mount({}, 'ko');
    await act(async () => FakeEventSource.last.open());
    await flush();

    expect(connection()!.getAttribute('aria-label')).toBe(stateName(koLocale)(koLocale.chat.connected));
  });

  it('REGRESSION: the panel adds no second role="status" (lockedHistory.test.tsx depends on that selector)', async () => {
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    expect(container.querySelectorAll('[role="status"]').length).toBe(0);
  });
});

describe('composer', () => {
  it('BOUNDARY: the input holds the 16px floor and the 44px touch target, as a pill', async () => {
    await mount();
    const input = composerInput();

    // 16px exactly: below it, iOS Safari zooms the whole page on focus.
    expect(input.style.fontSize).toBe('var(--text-body)');
    expect(input.style.minHeight).toBe('var(--touch-target-min)');
    expect(input.style.borderRadius).toBe('var(--radius-pill)');
  });

  it('A11Y: the send control is an icon button that still has the accessible name "Send"', async () => {
    await mount();
    const send = sendButton();

    expect(send).not.toBeNull();
    // Icon, not text — the label lives in aria-label so the composer's width
    // does not depend on the locale's word for "send".
    expect(send.querySelector('svg')).not.toBeNull();
    expect(send.textContent).toBe('');
    expect(send.style.width).toBe('var(--touch-target-min)');
    expect(send.style.height).toBe('var(--touch-target-min)');
    expect(send.style.borderRadius).toBe('var(--radius-pill)');
  });

  it('LOCALE ko: the send control names itself in Korean', async () => {
    await mount({}, 'ko');

    expect(container.querySelector(`button[aria-label="${koLocale.chat.send}"]`)).not.toBeNull();
  });

  it('A11Y: the attach control is a same-sized labelled icon button', async () => {
    await mount();
    const attach = container.querySelector(
      `button[aria-label="${enLocale.chat.attachImage}"]`,
    ) as HTMLButtonElement;

    expect(attach).not.toBeNull();
    expect(attach.style.width).toBe('var(--touch-target-min)');
    expect(attach.style.height).toBe('var(--touch-target-min)');
  });

  it('the send control is disabled while empty and enabled once there is text and a stream', async () => {
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    expect(sendButton().disabled).toBe(true);

    const input = composerInput();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'hello');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(sendButton().disabled).toBe(false);
  });
});
