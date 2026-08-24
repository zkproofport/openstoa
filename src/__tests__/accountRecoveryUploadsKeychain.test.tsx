// @vitest-environment jsdom
/**
 * THE REGRESSION TEST for the reported bug: setting up recovery must back up
 * the TAK keychain, not just wrap the master_key.
 *
 * What was reported: a user registered a passkey in the mobile app, opened the
 * chat, then opened the same account in a phone browser. The browser said "no
 * recovery key is set up" and 16 messages stayed locked. Cause: `AccountRecovery`
 * wrote `key_backups` (the wrapped master_key) and nothing else. `tak_key_backups`
 * was only ever written by the TAK key-CHANGE hook, which fires when a key is
 * newly WRITTEN — and a user who already holds their keys writes none. So
 * recovery came back and opened nothing, forever.
 *
 * Before the fix, every `it` in the first describe below fails: no upload
 * happened on either backup path.
 *
 * Edge-case matrix rows covered here:
 *   contract   — BOTH setup paths (passkey, recovery code) upload the keychain;
 *                deleting either call fails this file
 *   ordering   — the master_key wrap is posted BEFORE the keychain upload, so a
 *                failing upload can never cost the user the wrap
 *   ext-dep    — a failed upload still leaves recovery set up, and says so
 *                VISIBLY instead of leaving a silent half-built state
 *   authz      — an untrusted device surfaces its own distinct explanation
 *   empty      — a user with no chat keys yet sees success with no warning
 *   UTF-8/i18n — the partial-state copy resolves in en AND ko, never a raw key
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({
  order: [] as string[],
  uploadOutcome: 'uploaded' as 'uploaded' | 'empty' | 'present' | 'untrusted' | 'failed',
}));

vi.mock('@/lib/mls/webTransport', () => ({
  getDeviceMasterKey: async () => new Uint8Array(32),
  recoverDevice: async () => true,
  uploadTakKeychainNow: async () => {
    calls.order.push('uploadTakKeychainNow');
    return calls.uploadOutcome;
  },
  keyBackupHttp: () => ({
    getBackup: async () => ({ wrappedMaster: null, passkeys: [] }),
    postRecovery: async () => {
      calls.order.push('postRecovery');
    },
    postPasskey: async () => {
      calls.order.push('postPasskey');
    },
    getTakBackup: async () => null,
  }),
}));

vi.mock('@/lib/passkeyPrf', () => ({
  isPasskeySupported: () => true,
  registerPasskeyPrf: async () => ({ credentialId: 'cred-1', prfOutput: new Uint8Array(32) }),
  getPasskeyPrf: async () => ({ prfOutput: new Uint8Array(32) }),
}));

vi.mock('@/lib/mls/keyManager', () => ({
  backupWithRecoveryCode: async (_mk: Uint8Array, post: (s: string) => Promise<void>) => {
    await post('wrapped');
    return 'ABCD-EFGH-IJKL-MNOP';
  },
  backupWithPasskey: async (
    _mk: Uint8Array,
    credentialId: string,
    _prf: Uint8Array,
    post: (id: string, w: string) => Promise<void>,
  ) => {
    await post(credentialId, 'wrapped');
  },
  recoverWithRecoveryCode: async () => new Uint8Array(32),
  recoverWithPasskey: async () => new Uint8Array(32),
}));

import { AccountRecovery } from '@/components/AccountRecovery';
import { TestProviders } from './harness/providers';
import en from '@/lib/i18n/locales/en.json';
import ko from '@/lib/i18n/locales/ko.json';
import type { Locale } from '@/lib/i18n';

let container: HTMLDivElement;
let root: Root;

async function render(locale: Locale = 'en') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(TestProviders, {
        initialLocale: locale,
        children: React.createElement(AccountRecovery, { userId: 'user-1', displayName: 'Someone' }),
      }),
    );
  });
}

function buttonWith(text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`no button "${text}" — have: ${[...container.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`);
  return el as HTMLButtonElement;
}

async function click(text: string) {
  await act(async () => {
    buttonWith(text).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  calls.order = [];
  calls.uploadOutcome = 'uploaded';
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('setting up recovery backs up the TAK keychain', () => {
  it('REGRESSION: registering a passkey uploads the keychain', async () => {
    await render();
    await click(en.accountRecovery.registerPasskey);

    expect(calls.order).toContain('uploadTakKeychainNow');
  });

  it('REGRESSION: generating a recovery code uploads the keychain', async () => {
    await render();
    await click(en.accountRecovery.generateRecoveryCode);

    expect(calls.order).toContain('uploadTakKeychainNow');
  });

  it('ORDERING: the master_key wrap lands FIRST, so a failed upload cannot cost it', async () => {
    await render();
    await click(en.accountRecovery.registerPasskey);

    expect(calls.order).toEqual(['postPasskey', 'uploadTakKeychainNow']);

    calls.order = [];
    await click(en.accountRecovery.generateRecoveryCode);
    expect(calls.order).toEqual(['postRecovery', 'uploadTakKeychainNow']);
  });

  it('exactly one upload per setup — no duplicate POST per click', async () => {
    await render();
    await click(en.accountRecovery.registerPasskey);

    expect(calls.order.filter((c) => c === 'uploadTakKeychainNow')).toHaveLength(1);
  });
});

describe('a keychain upload that does not land is surfaced, never silent', () => {
  it('EXTERNAL FAILURE: recovery still succeeds, and the partial state is stated', async () => {
    calls.uploadOutcome = 'failed';
    await render();
    await click(en.accountRecovery.registerPasskey);

    // The wrap is real — the success message stays.
    expect(container.textContent).toContain(en.accountRecovery.passkeyRegistered);
    // ...and the user is told what did NOT happen. A silent half-built recovery
    // is the whole defect.
    const partial = container.querySelector('[data-testid="recovery-partial"]');
    expect(partial?.textContent).toBe(en.accountRecovery.keychainUploadFailed);
  });

  it('AUTHZ: an untrusted device gets its own explanation, not the generic one', async () => {
    calls.uploadOutcome = 'untrusted';
    await render();
    await click(en.accountRecovery.generateRecoveryCode);

    const partial = container.querySelector('[data-testid="recovery-partial"]');
    expect(partial?.textContent).toBe(en.accountRecovery.keychainUntrusted);
    expect(partial?.textContent).not.toBe(en.accountRecovery.keychainUploadFailed);
  });

  it('EMPTY: a user with no chat keys yet sees success and NO warning', async () => {
    calls.uploadOutcome = 'empty';
    await render();
    await click(en.accountRecovery.registerPasskey);

    expect(container.textContent).toContain(en.accountRecovery.passkeyRegistered);
    expect(container.querySelector('[data-testid="recovery-partial"]')).toBeNull();
  });

  it('a successful upload shows no warning either', async () => {
    calls.uploadOutcome = 'uploaded';
    await render();
    await click(en.accountRecovery.registerPasskey);

    expect(container.querySelector('[data-testid="recovery-partial"]')).toBeNull();
  });

  it('the warning clears when the next action starts', async () => {
    calls.uploadOutcome = 'failed';
    await render();
    await click(en.accountRecovery.registerPasskey);
    expect(container.querySelector('[data-testid="recovery-partial"]')).not.toBeNull();

    calls.uploadOutcome = 'uploaded';
    await click(en.accountRecovery.generateRecoveryCode);
    expect(container.querySelector('[data-testid="recovery-partial"]')).toBeNull();
  });

  it('i18n: the partial-state copy renders in Korean, not a raw key', async () => {
    calls.uploadOutcome = 'failed';
    await render('ko');
    await click(ko.accountRecovery.registerPasskey);

    const partial = container.querySelector('[data-testid="recovery-partial"]');
    expect(partial?.textContent).toBe(ko.accountRecovery.keychainUploadFailed);
    expect(partial?.textContent).not.toContain('accountRecovery.');
    expect(partial?.textContent).not.toBe(en.accountRecovery.keychainUploadFailed);
  });
});
