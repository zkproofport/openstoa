// @vitest-environment jsdom
/**
 * `BareChatShell.tsx` — the popped-out `/chat`, `/dm` shell's own chrome:
 * width control (P-1) and Close (P-2, replacing the old back-arrow).
 *
 * Edge-case matrix rows covered here:
 *   default      — fills the window (no cap) on first mount, no persisted
 *                  preference
 *   boundary     — each width preset (narrow/wide/full) updates the content
 *                  pane's max-width and persists via `chatWidth.ts`
 *   contract     — a persisted preference from a earlier visit is applied on
 *                  mount; Close calls `window.close()`
 *   ext-failure  — the browser refusing to close the tab (silently ignoring
 *                  `window.close()`) falls back to an in-app navigation
 *                  rather than leaving a dead button
 *
 * jsdom has no layout engine, so this only asserts the inline `maxWidth`
 * style value (a real DOM property, not a computed layout metric) — it does
 * NOT assert actual rendered pixel width or viewport overflow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pushMock = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

import BareChatShell from '@/components/BareChatShell';
import { CHAT_WIDTH_KEY } from '@/lib/chatWidth';
import { I18nProvider } from '@/lib/i18n/I18nProvider';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.localStorage.clear();
  pushMock.mockClear();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// `BareChatShell` now reads copy through `useTranslation()` — see
// src/lib/i18n/I18nProvider.tsx. Every render needs the provider in the
// tree, same as the app root (src/app/layout.tsx).
async function mount() {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <BareChatShell>
          <div data-testid="child">content</div>
        </BareChatShell>
      </I18nProvider>,
    );
  });
}

function contentPane(): HTMLElement {
  return container.querySelector('[data-testid="child"]')!.parentElement as HTMLElement;
}

function widthButton(label: 'Narrow' | 'Wide' | 'Full'): HTMLButtonElement {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement;
}

describe('width control', () => {
  it('DEFAULT: fills the window on first mount — no cap, Full shown as selected', async () => {
    await mount();

    expect(contentPane().style.maxWidth).toBe('100%');
    expect(widthButton('Full').getAttribute('aria-pressed')).toBe('true');
    expect(widthButton('Narrow').getAttribute('aria-pressed')).toBe('false');
  });

  it('BOUNDARY: choosing Narrow caps the content and persists the choice', async () => {
    await mount();

    await act(async () => {
      widthButton('Narrow').click();
    });

    expect(contentPane().style.maxWidth).toBe('640px');
    expect(widthButton('Narrow').getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem(CHAT_WIDTH_KEY)).toBe('narrow');
  });

  it('BOUNDARY: choosing Wide caps the content and persists the choice', async () => {
    await mount();

    await act(async () => {
      widthButton('Wide').click();
    });

    expect(contentPane().style.maxWidth).toBe('860px');
    expect(window.localStorage.getItem(CHAT_WIDTH_KEY)).toBe('wide');
  });

  it('CONTRACT: a preference persisted on an earlier visit is applied on mount', async () => {
    window.localStorage.setItem(CHAT_WIDTH_KEY, 'wide');

    await mount();

    expect(contentPane().style.maxWidth).toBe('860px');
    expect(widthButton('Wide').getAttribute('aria-pressed')).toBe('true');
  });

  it('a corrupted persisted value is ignored — falls back to full rather than crashing', async () => {
    window.localStorage.setItem(CHAT_WIDTH_KEY, 'gigantic');

    await mount();

    expect(contentPane().style.maxWidth).toBe('100%');
  });
});

describe('close (replaces the old back-arrow — see module doc P-2)', () => {
  it('CONTRACT: pressing Close calls window.close() exactly once', async () => {
    await mount();
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    const closeBtn = container.querySelector('button[aria-label="Close"]') as HTMLButtonElement;

    await act(async () => {
      closeBtn.click();
    });

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('EXT-FAILURE: a tab the browser refuses to close falls back to an in-app destination, not a dead button', async () => {
    vi.useFakeTimers();
    await mount();
    // Simulates a browser that silently ignores window.close() — e.g. a tab
    // whose history grew, or a policy that blocks it. The tab is still here.
    vi.spyOn(window, 'close').mockImplementation(() => {});
    const closeBtn = container.querySelector('button[aria-label="Close"]') as HTMLButtonElement;

    await act(async () => {
      closeBtn.click();
    });
    expect(pushMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(pushMock).toHaveBeenCalledWith('/topics');
  });

  it('does not leak the fallback timer after unmount (no push after the component is gone)', async () => {
    vi.useFakeTimers();
    await mount();
    vi.spyOn(window, 'close').mockImplementation(() => {});
    const closeBtn = container.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    await act(async () => {
      closeBtn.click();
    });

    await act(async () => {
      root.unmount();
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(pushMock).not.toHaveBeenCalled();
  });
});
