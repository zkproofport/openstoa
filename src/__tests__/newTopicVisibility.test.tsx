// @vitest-environment jsdom
/**
 * The web topic form offers all three visibility tiers.
 *
 * `secret` was held back deliberately, and the comment saying so gave a
 * condition rather than a date: it is the one tier whose confidentiality rests
 * entirely on join control, and that path — expiring single-use invites only,
 * no permanent code — was new and unexercised at the time. It is now enforced
 * where it counts, in `/api/topics/join/[inviteCode]`, which refuses a
 * permanent code for any non-public topic; `e2e/invite-tokens.test.ts` covers
 * that route. What was left was the form, and a tier nobody can select cannot
 * be exercised end to end.
 *
 * This test pins the offer itself. The tiers' behaviour lives elsewhere and is
 * tested there — `chatTierPolicy.test.ts` for the key rules, and
 * `tierAccess-routes.test.ts` for who may read what.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract  → all three radios render and none is disabled
 *   integrity → each radio carries its own tier value, so a copy-paste that
 *               points two rows at one value fails here
 *   boundary  → every tier in the union is asserted, not just the new one
 *   authz / hostile / empty / UTF-8 / large / race → N/A: `visibility` is a
 *               closed set of three literals picked from radios, and the
 *               server validates it independently (`VALID_VISIBILITIES` in
 *               `/api/topics`). Who may then join is the server's decision,
 *               covered by `tierAccess-routes.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

// Chrome, not subject: the page's own layout and proof gate would each drag in
// a session and a wallet for a question about three radio buttons.
vi.mock('@/components/CommunityLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/ProofGate', () => ({
  default: () => <div data-testid="proof-gate" />,
}));

// The key IS the assertion target: rewording a label must not fail a test
// about which tiers exist.
vi.mock('@/lib/i18n/I18nProvider', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import NewTopicPage from '@/app/topics/new/page';

const TIERS = ['public', 'private', 'secret'] as const;

describe('new topic form — every visibility tier is offered', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    global.fetch = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ categories: [] }) }) as unknown as Response,
    ) as unknown as typeof global.fetch;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  /** The visibility radios, in DOM order. */
  function visibilityRadios(): HTMLInputElement[] {
    return Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="radio"][name="visibility"]'),
    );
  }

  it('CONTRACT: all three tiers render, and none of them is disabled', async () => {
    await act(async () => {
      root.render(<NewTopicPage />);
    });

    const radios = visibilityRadios();
    expect(radios.map((r) => r.value)).toEqual([...TIERS]);
    for (const radio of radios) {
      expect(radio.disabled, `${radio.value} is still disabled`).toBe(false);
    }
  });

  it('INTEGRITY: public is the default, and picking secret moves the selection', async () => {
    await act(async () => {
      root.render(<NewTopicPage />);
    });

    const byValue = (v: string) => visibilityRadios().find((r) => r.value === v)!;
    expect(byValue('public').checked).toBe(true);

    await act(async () => {
      byValue('secret').click();
    });

    expect(byValue('secret').checked).toBe(true);
    expect(byValue('public').checked).toBe(false);
  });
});
