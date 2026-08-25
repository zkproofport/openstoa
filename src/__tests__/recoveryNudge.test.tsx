// @vitest-environment jsdom
/**
 * The first-run recovery nudge (design §10-1 / Phase 4), and the silent
 * account-level backup repair it rides along with.
 *
 * Recovery used to be reachable ONLY from `/recovery`, `/my`, and the mobile
 * profile screen — there was no first-run prompt at all, so the overwhelmingly
 * common case was a user who never set it up and silently could not recover
 * anything.
 *
 * Edge-case matrix rows covered here:
 *   authz      — guests never trigger the repair and never see the banner
 *   contract   — the repair runs on session start even when the banner is
 *                suppressed (dismissed / already on /recovery), because it is
 *                the fix for accounts already in the broken state
 *   dismissed  — a dismissal persists across mounts, keyed BY ACCOUNT so a
 *                second user on the same browser still gets prompted
 *   configured — a user who already has recovery is never nudged
 *   empty      — a user with no chat history yet is never nudged
 *   ext-dep    — an unreadable server never produces a banner (claim nothing)
 *   race       — the repair runs once per mounted session, not per render
 *   ui         — the banner is dismissible and does not block: it renders as a
 *                sibling of the page content, with no dialog/overlay semantics
 *   UTF-8/i18n — the copy resolves in en AND ko, never a raw key
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const backend = vi.hoisted(() => ({
  ensureCalls: 0,
  outcome: 'present' as 'uploaded' | 'empty' | 'present' | 'untrusted' | 'failed',
  wrappedMaster: null as string | null,
  passkeys: [] as unknown[],
  backupThrows: false,
  pathname: '/topics',
  pushed: [] as string[],
}));

vi.mock('@/lib/mls/webTransport', () => ({
  ensureTakKeychainBackup: async () => {
    backend.ensureCalls += 1;
    return backend.outcome;
  },
  keyBackupHttp: () => ({
    getBackup: async () => {
      if (backend.backupThrows) throw new Error('offline');
      return { wrappedMaster: backend.wrappedMaster, passkeys: backend.passkeys };
    },
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (p: string) => backend.pushed.push(p), replace: vi.fn() }),
  usePathname: () => backend.pathname,
}));

import RecoveryNudge from '@/components/RecoveryNudge';
import { shouldNudgeRecovery, recoveryNudgeDismissKey } from '@/lib/recoveryNudge';
import { TestProviders, flushQueries } from './harness/providers';
import en from '@/lib/i18n/locales/en.json';
import ko from '@/lib/i18n/locales/ko.json';
import type { Locale } from '@/lib/i18n';

let container: HTMLDivElement;
let root: Root;

async function render(
  props: { isGuest: boolean; sessionChecked: boolean } = { isGuest: false, sessionChecked: true },
  locale: Locale = 'en',
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(TestProviders, {
        initialLocale: locale,
        children: React.createElement(RecoveryNudge, props),
      }),
    );
  });
  /*
   * The banner now reads its account from the shared session query, which
   * delivers on a real `setTimeout(0)` rather than a microtask — so without
   * this the component is still deciding when the assertions run.
   */
  await flushQueries();
}

function banner() {
  return container.querySelector('[data-testid="recovery-nudge"]');
}

beforeEach(() => {
  backend.ensureCalls = 0;
  backend.outcome = 'present';
  backend.wrappedMaster = null;
  backend.passkeys = [];
  backend.backupThrows = false;
  backend.pathname = '/topics';
  backend.pushed = [];
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ userId: 'user-1' }), { status: 200 }))),
  );
});

afterEach(() => {
  // The pure-decision block below renders nothing, so there may be no root.
  if (!root) return;
  act(() => root.unmount());
  container.remove();
  root = undefined as unknown as Root;
});

describe('shouldNudgeRecovery — the decision, independent of any UI', () => {
  const base = { authenticated: true, dismissed: false, hasRecovery: false, backup: 'present' as const };

  it('prompts a signed-in user with history and no recovery', () => {
    expect(shouldNudgeRecovery(base)).toBe(true);
    expect(shouldNudgeRecovery({ ...base, backup: 'uploaded' })).toBe(true);
  });

  it('NEVER prompts a guest', () => {
    expect(shouldNudgeRecovery({ ...base, authenticated: false })).toBe(false);
  });

  it('NEVER prompts a user who already has recovery', () => {
    expect(shouldNudgeRecovery({ ...base, hasRecovery: true })).toBe(false);
  });

  it('NEVER prompts a user who dismissed it', () => {
    expect(shouldNudgeRecovery({ ...base, dismissed: true })).toBe(false);
  });

  it('stays quiet when there is nothing to lose yet, or nothing is known', () => {
    // The reason the prompt is not at signup: a fresh account holds no chat
    // keys, so the warning would name a loss that cannot happen yet.
    expect(shouldNudgeRecovery({ ...base, backup: 'empty' })).toBe(false);
    expect(shouldNudgeRecovery({ ...base, backup: 'failed' })).toBe(false);
    expect(shouldNudgeRecovery({ ...base, backup: 'untrusted' })).toBe(false);
  });

  it('the dismissal key is per-account, so one user cannot silence another', () => {
    expect(recoveryNudgeDismissKey('a')).not.toBe(recoveryNudgeDismissKey('b'));
    expect(recoveryNudgeDismissKey('a')).toContain('a');
  });
});

describe('RecoveryNudge — repair', () => {
  it('CONTRACT: runs the account-level backup repair on session start', async () => {
    await render();
    expect(backend.ensureCalls).toBe(1);
  });

  it('AUTHZ: a guest triggers no repair and sees no banner', async () => {
    await render({ isGuest: true, sessionChecked: true });
    expect(backend.ensureCalls).toBe(0);
    expect(banner()).toBeNull();
  });

  it('waits for the session to resolve before doing anything', async () => {
    await render({ isGuest: false, sessionChecked: false });
    expect(backend.ensureCalls).toBe(0);
  });

  it('CONTRACT: repairs even when the banner is suppressed by a dismissal', async () => {
    localStorage.setItem(recoveryNudgeDismissKey('user-1'), '1');
    await render();
    expect(backend.ensureCalls).toBe(1);
    expect(banner()).toBeNull();
  });

  it('CONTRACT: repairs even on /recovery, where the banner would be redundant', async () => {
    backend.pathname = '/recovery';
    await render();
    expect(backend.ensureCalls).toBe(1);
    expect(banner()).toBeNull();
  });

  it('RACE: the repair runs once per mounted session, not once per render', async () => {
    await render();
    await act(async () => {
      root.render(
        React.createElement(TestProviders, {
          initialLocale: 'en' as Locale,
          children: React.createElement(RecoveryNudge, { isGuest: false, sessionChecked: true }),
        }),
      );
    });
    expect(backend.ensureCalls).toBe(1);
  });

  it('EXTERNAL FAILURE: no session means no repair and no banner', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    await render();
    expect(backend.ensureCalls).toBe(0);
    expect(banner()).toBeNull();
  });
});

/**
 * THERE IS NO BANNER, and that is the requirement.
 *
 * This block used to assert that a prompt appeared for anyone with chat history
 * and no recovery, that it could be dismissed, and that the dismissal stuck.
 * The owner's decision replaced all of it: backing up is a BUTTON in Profile
 * settings, pressed by someone moving to a new device, and the docs are where
 * that is explained. Someone who has not asked to back up is not in an error
 * state, and the top of every page is not the place to tell them otherwise.
 *
 * Removing it beat fixing it, and the reason is worth keeping. The nudge
 * already HAD a per-account dismissal and it still reappeared on every launch:
 * the dismissal was written to a store that is optional on the mini-app's host
 * bridge, so `?.` swallowed the write and "Not now" meant "not for thirty
 * seconds". Reproduced on a real device. A better place to record a dismissal
 * would have been one more layer on a thing that should not exist.
 *
 * The SILENT REPAIR is a different job and its cases are above, untouched — it
 * fixes accounts whose backup row is empty and asks nothing of anyone.
 */
describe('RecoveryNudge — there is no banner', () => {
  it('CONTRACT: renders nothing for a user with history and no recovery', async () => {
    // The exact case the banner used to fire on.
    await render();
    expect(banner()).toBeNull();
  });

  it('CONTRACT: renders nothing on any path, including /recovery', async () => {
    backend.pathname = '/recovery';
    await render();
    expect(banner()).toBeNull();
  });

  it('INTEGRITY: the repair still runs while nothing is rendered', async () => {
    // The point of keeping this component at all. If the banner's removal ever
    // takes the repair with it, this goes red rather than an account silently
    // keeping an empty backup row.
    await render();
    expect(backend.ensureCalls).toBe(1);
    expect(banner()).toBeNull();
  });
});
