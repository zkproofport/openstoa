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
    myDeviceId: async () => 'device-1',
    distributePublicRoot: async () => 0,
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

function composerInput(): HTMLInputElement {
  return container.querySelector('input[type="text"]') as HTMLInputElement;
}

beforeEach(() => {
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
        return json({ topic: { visibility: 'public' }, currentUserRole: 'member' });
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
  it('CONTRACT: the banner is present and its copy comes from the en dictionary', async () => {
    await mount();

    expect(banner()).not.toBeNull();
    expect(banner()!.textContent).toContain(enLocale.chat.e2ee);
    // The claim itself, not a paraphrase: the server must be named as unable
    // to read the contents.
    expect(enLocale.chat.e2ee.toLowerCase()).toContain('server');
  });

  it('LOCALE ko: the same banner renders the Korean string, not the English one', async () => {
    await mount({}, 'ko');

    expect(banner()!.textContent).toContain(koLocale.chat.e2ee);
    expect(banner()!.textContent).not.toContain(enLocale.chat.e2ee);
  });

  it('AUTHZ guest: the encryption claim still shows, but there is no connection state', async () => {
    await mount({ isGuest: true, isMember: false });

    expect(banner()).not.toBeNull();
    expect(banner()!.textContent).toContain(enLocale.chat.e2ee);
    expect(connection()).toBeNull();
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

describe('connection state', () => {
  it('RACE: before the stream opens it reads Reconnecting, never blank', async () => {
    await mount();

    expect(connection()!.textContent?.trim()).toBe(enLocale.chat.reconnecting);
  });

  it('once the stream is live it reads Connected, as a visible word', async () => {
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    expect(connection()!.textContent?.trim()).toBe(enLocale.chat.connected);
  });

  it('a dropped transport flips the visible word back to Reconnecting', async () => {
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();
    await act(async () => FakeEventSource.last.fail());
    await flush();

    expect(connection()!.textContent?.trim()).toBe(enLocale.chat.reconnecting);
  });

  it('A11Y: the state is an announced live region with a name', async () => {
    await mount();

    expect(connection()!.getAttribute('aria-live')).toBe('polite');
    expect(connection()!.getAttribute('aria-atomic')).toBe('true');
    expect(connection()!.getAttribute('aria-label')).toBe(enLocale.chat.connectionStatusLabel);
  });

  it('LOCALE ko: the connection word is Korean', async () => {
    await mount({}, 'ko');
    await act(async () => FakeEventSource.last.open());
    await flush();

    expect(connection()!.textContent?.trim()).toBe(koLocale.chat.connected);
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
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'hello');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(sendButton().disabled).toBe(false);
  });
});
