// @vitest-environment jsdom
/**
 * `Header.tsx` — FIX7 (collapse duplicate chat entry points) + FIX8 (move
 * Recovery out of the top-level nav).
 *
 * Edge-case matrix rows covered here:
 *   contract — the chat rail toggle is the ONLY chat/DM entry point in the
 *              header; the old "Messages" full-page link to `/dm` is gone
 *   contract — no `/recovery` link in the top-level nav (moved to `/my`'s
 *              Settings tab — see `myPageRecovery.test.tsx`)
 *   authz    — a guest sees neither the chat toggle nor any signed-in-only
 *              link, even when `onChatToggle` is passed (defence in depth:
 *              `CommunityLayout` already withholds `onChatToggle` from a
 *              guest, but the button itself is also gated on `user`)
 *   contract — pages that render `Header` standalone (no `onChatToggle`
 *              passed) never render a chat toggle with nothing to toggle
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import Header from '@/components/Header';
import { I18nProvider } from '@/lib/i18n/I18nProvider';

let container: HTMLDivElement;
let root: Root;

function json(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(props: React.ComponentProps<typeof Header> = {}) {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <Header {...props} />
      </I18nProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('signed in, inside CommunityLayout (onChatToggle passed)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
  });

  it('CONTRACT: the chat rail toggle is present and is the ONLY chat/DM entry point', async () => {
    await render({ onChatToggle: vi.fn(), chatOpen: false });

    expect(container.querySelector('button[aria-label="Open chat"]')).not.toBeNull();
    // The old full-page "Messages" link to /dm is gone.
    expect(container.querySelector('a[href="/dm"]')).toBeNull();
    expect(container.textContent).not.toContain('Messages');
  });

  it('FIX8: no /recovery link in the top-level nav', async () => {
    await render({ onChatToggle: vi.fn(), chatOpen: false });

    expect(container.querySelector('a[href="/recovery"]')).toBeNull();
  });

  it('clicking the chat toggle invokes onChatToggle', async () => {
    const onChatToggle = vi.fn();
    await render({ onChatToggle, chatOpen: false });

    await act(async () => {
      (container.querySelector('button[aria-label="Open chat"]') as HTMLButtonElement).click();
    });
    expect(onChatToggle).toHaveBeenCalledTimes(1);
  });

  it('reflects the open state via aria-pressed / aria-label', async () => {
    await render({ onChatToggle: vi.fn(), chatOpen: true });

    const btn = container.querySelector('button[aria-pressed]') as HTMLButtonElement;
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('Close chat');
  });
});

describe('CONTRACT: standalone Header (no onChatToggle — recovery/docs/profile pages)', () => {
  it('never renders a chat toggle with nothing to toggle, even when signed in', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render();

    expect(container.querySelector('button[aria-label="Open chat"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Close chat"]')).toBeNull();
  });
});

describe('AUTHZ: guest', () => {
  it('sees no chat toggle even if onChatToggle is passed, and no signed-in-only links', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(null))));
    await render({ onChatToggle: vi.fn(), chatOpen: false });

    expect(container.querySelector('button[aria-label="Open chat"]')).toBeNull();
    expect(container.querySelector('a[href="/dm"]')).toBeNull();
    expect(container.querySelector('a[href="/recovery"]')).toBeNull();
    expect(container.querySelector('a[href="/"]')?.textContent).toBe('Sign in');
  });

  it('FIX6: still sees the language switcher — not an auth-gated preference', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(null))));
    await render({ onChatToggle: vi.fn(), chatOpen: false });

    expect(container.querySelector('[role="group"][aria-label="Language"]')).not.toBeNull();
  });
});
