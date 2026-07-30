// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import TopicMuteToggle from '@/components/TopicMuteToggle';
import { I18nProvider } from '@/lib/i18n/I18nProvider';

/**
 * Per-topic mute bell (P-S) — the shared web control used by both the ChatPanel
 * header and the mobile-web chat sheet.
 *
 * Edge-case matrix rows covered here:
 *   authz      — guests / non-members (`enabled=false`) render NOTHING and the
 *                component never calls the API
 *   empty      — nothing is rendered until the read resolves (no guessed state)
 *   ext-failure— a 403/500/network failure leaves the control hidden rather
 *                than claiming "not muted"
 *   contract   — the click issues PATCH with the INVERTED value to the right
 *                topic-scoped path (a regression in either is caught)
 *   integrity  — the rendered state follows the server's echo, not the request
 *   race       — a failed toggle reverts to the previous state
 */

// React 19 act() environment flag.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOPIC = '11111111-2222-4333-8444-555555555555';

let container: HTMLDivElement;
let root: Root;

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

// `TopicMuteToggle` now reads copy through `useTranslation()` — see
// src/lib/i18n/I18nProvider.tsx. Every render needs the provider in the
// tree, same as the app root (src/app/layout.tsx).
async function render(ui: React.ReactElement) {
  await act(async () => {
    root.render(<I18nProvider initialLocale="en">{ui}</I18nProvider>);
  });
}

function button(): HTMLButtonElement | null {
  return container.querySelector('button');
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.restoreAllMocks();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('TopicMuteToggle', () => {
  it('renders nothing and never calls the API for a guest / non-member', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await render(<TopicMuteToggle topicId={TOPIC} enabled={false} />);

    expect(button()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders nothing when the read fails (403 non-member / network error)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'Not a member' }, false, 403)) as unknown as typeof fetch;

    await render(<TopicMuteToggle topicId={TOPIC} enabled />);

    expect(button()).toBeNull();
  });

  it('renders an un-muted bell after the read resolves', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ topicId: TOPIC, muted: false })) as unknown as typeof fetch;

    await render(<TopicMuteToggle topicId={TOPIC} enabled />);

    const b = button();
    expect(b).not.toBeNull();
    expect(b!.getAttribute('aria-pressed')).toBe('false');
    expect(b!.getAttribute('aria-label')).toBe('Mute notifications for this topic');
  });

  it('renders a muted bell when the server says muted', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ topicId: TOPIC, muted: true })) as unknown as typeof fetch;

    await render(<TopicMuteToggle topicId={TOPIC} enabled />);

    expect(button()!.getAttribute('aria-pressed')).toBe('true');
    expect(button()!.getAttribute('aria-label')).toBe('Unmute notifications for this topic');
  });

  it('CONTRACT: clicking PATCHes the topic-scoped path with the INVERTED value', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ topicId: TOPIC, muted: false }))
      .mockResolvedValueOnce(jsonResponse({ topicId: TOPIC, muted: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await render(<TopicMuteToggle topicId={TOPIC} enabled />);
    await act(async () => {
      button()!.click();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`/api/topics/${TOPIC}/push`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ muted: true });
    expect(button()!.getAttribute('aria-pressed')).toBe('true');
  });

  it('INTEGRITY: adopts the server echo, not the requested value', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ topicId: TOPIC, muted: false }))
      // Server refuses the transition and reports it is still un-muted.
      .mockResolvedValueOnce(jsonResponse({ topicId: TOPIC, muted: false }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await render(<TopicMuteToggle topicId={TOPIC} enabled />);
    await act(async () => {
      button()!.click();
    });

    expect(button()!.getAttribute('aria-pressed')).toBe('false');
  });

  it('reverts the optimistic flip when the PATCH fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ topicId: TOPIC, muted: false }))
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, false, 500));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await render(<TopicMuteToggle topicId={TOPIC} enabled />);
    await act(async () => {
      button()!.click();
    });

    expect(button()!.getAttribute('aria-pressed')).toBe('false');
  });

  it('reverts when the PATCH rejects outright (offline)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ topicId: TOPIC, muted: true }))
      .mockRejectedValueOnce(new Error('network down'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await render(<TopicMuteToggle topicId={TOPIC} enabled />);
    await act(async () => {
      button()!.click();
    });

    expect(button()!.getAttribute('aria-pressed')).toBe('true');
  });
});
