// @vitest-environment jsdom
/**
 * Profile + account surfaces: `/my` (identity block, tabs, settings list),
 * `/profile` and `/recovery` (standalone, no app chrome), and the two
 * components that render INTO `/my`'s settings list (`AiAgentSettings`,
 * `AccountRecovery`).
 *
 * Edge-case matrix rows covered here (row → test):
 *   empty      — no nickname / no badges / no API keys / no recovery configured
 *                / no domain badge, each asserted as its own state rather than
 *                collapsed into one "empty" case
 *   boundary   — a 200-char nickname and a 1-char nickname both render whole
 *   UTF-8      — Korean and emoji nicknames survive verbatim (no uppercase
 *                mangling, no truncation in the DOM)
 *   authz      — a guest hitting `/my` is redirected and renders nothing
 *   contract   — the raw API key is shown exactly once, is never re-fetched,
 *                and the key LIST only ever carries the prefix
 *   contract   — the three files that share the settings surface declare the
 *                same list/row style objects (drift fails here, not in review)
 *   contract   — the Recovery row still links to `/recovery` (myPageRecovery)
 *   ui         — every section heading is `.os-label` (uppercase gated to
 *                :lang(en)), and NO owned file kills a focus ring with
 *                `outline: none`
 *   ui         — settings rows wrap instead of squeezing (320px behaviour)
 *   integrity  — a failed push-preferences load renders "couldn't load", never
 *                a confident "off"
 *   ui         — the standalone pages depend on no chrome they do not have
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}
vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver);

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
}));

// CommunityLayout brings in Header/LeftSidebar/RightSidebar/ChatRail, each with
// their own fetch surface and coverage elsewhere.
vi.mock('@/components/CommunityLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
}));

// The E2EE key stack is not the subject here — `AccountRecovery`'s LAYOUT is.
// Every transport is stubbed so the component's own states (checking / not set
// up / set up) can be driven directly.
const backupState = vi.hoisted(() => ({
  value: null as null | { wrappedMaster: string | null; passkeys: string[] },
  passkeySupported: true,
}));
vi.mock('@/lib/mls/webTransport', () => ({
  getDeviceMasterKey: vi.fn(async () => new Uint8Array(32)),
  recoverDevice: vi.fn(async () => {}),
  keyBackupHttp: () => ({
    getBackup: async () => backupState.value,
    postRecovery: async () => {},
    postPasskey: async () => {},
  }),
}));
vi.mock('@/lib/mls/keyManager', () => ({
  backupWithRecoveryCode: vi.fn(async () => 'code-code-code'),
  backupWithPasskey: vi.fn(async () => {}),
  recoverWithRecoveryCode: vi.fn(async () => null),
  recoverWithPasskey: vi.fn(async () => null),
}));
vi.mock('@/lib/mls/keyBackup', () => ({
  recoveryCodeEntropyBits: () => 0,
  RECOVERY_MIN_BITS: 128,
}));
vi.mock('@/lib/passkeyPrf', () => ({
  isPasskeySupported: () => backupState.passkeySupported,
  registerPasskeyPrf: vi.fn(async () => ({ credentialId: 'c', prfOutput: new Uint8Array(32) })),
  getPasskeyPrf: vi.fn(async () => ({ prfOutput: new Uint8Array(32) })),
}));

import MyPage from '@/app/my/page';
import AiAgentSettings from '@/components/AiAgentSettings';
import { AccountRecovery } from '@/components/AccountRecovery';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import type { Locale } from '@/lib/i18n';
import en from '@/lib/i18n/locales/en.json';

// ─── Part 1 — static contract over the files that share the surface ──────────

const SURFACE_FILES = [
  'src/app/my/page.tsx',
  'src/components/AiAgentSettings.tsx',
  'src/components/AccountRecovery.tsx',
] as const;

const OWNED_FILES = [
  ...SURFACE_FILES,
  'src/app/profile/page.tsx',
  'src/app/recovery/page.tsx',
] as const;

function source(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf-8');
}

/** The two style objects, whitespace-normalised, as one comparable string. */
function surfaceContract(file: string): string {
  const block = source(file).match(
    /const SETTINGS_LIST: React\.CSSProperties = \{[\s\S]*?\};\s*const SETTINGS_ROW: React\.CSSProperties = \{[\s\S]*?\};/,
  )?.[0];
  expect(block, `${file} declares SETTINGS_LIST + SETTINGS_ROW`).toBeTruthy();
  return block!.replace(/\s+/g, ' ');
}

describe('settings surface — one list idiom, three files', () => {
  it('every file that renders into the settings surface declares the SAME list/row contract', () => {
    // The three used to carry three different looks (a bare section, a
    // bordered card, a tinted box). Comparing the declarations is the only
    // version of "they match" that a future edit cannot quietly undo, because
    // there is no shared class to import — `globals.css` is owned elsewhere.
    const [first, ...rest] = SURFACE_FILES.map(surfaceContract);
    for (const other of rest) expect(other).toBe(first);
  });

  it('the contract is built from tokens only — no literal px, hex or rgba', () => {
    const contract = surfaceContract(SURFACE_FILES[0]);
    expect(contract).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(contract).not.toMatch(/rgba?\(/);
    // `1px` borders are the one literal length a border can have.
    expect(contract.replace(/1px/g, '')).not.toMatch(/\d+px/);
  });

  it('rows wrap rather than squeeze, so a 320px viewport drops the control below the label', () => {
    expect(surfaceContract(SURFACE_FILES[0])).toContain("flexWrap: 'wrap'");
  });

  it('every row is at least one tap target tall', () => {
    expect(surfaceContract(SURFACE_FILES[0])).toContain("minHeight: 'var(--touch-target-min)'");
  });

  it('no owned file removes a focus ring with `outline: none`', () => {
    // Keyboard focus has to stay visible on every control on these surfaces.
    // The shared `.os-button` / `.os-chip` / `.os-locale-select` classes define
    // their own `:focus-visible` ring; everything else keeps the UA's, which is
    // exactly what `outline: 'none'` used to throw away on the nickname and
    // delete-confirmation inputs.
    for (const file of OWNED_FILES) {
      expect(source(file), `${file}`).not.toMatch(/outline:\s*['"]none['"]/);
    }
  });

  it('the standalone pages depend on no chrome they do not have', () => {
    // `/profile` and `/recovery` render `<Header />` and nothing else — no
    // sidebar, no bottom tab bar, no chat rail — so anything that assumed a
    // surrounding layout would be broken there and only there.
    for (const file of ['src/app/profile/page.tsx', 'src/app/recovery/page.tsx']) {
      // Matched on the IMPORT, not on the bare name: both files name the
      // layout in a comment explaining that they deliberately do not use it.
      const src = source(file);
      expect(src, file).toContain("from '@/components/Header'");
      expect(src, file).not.toMatch(/from '@\/components\/(CommunityLayout|BottomTabBar)'/);
    }
  });
});

// ─── Harness ─────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

type Overrides = {
  session?: Record<string, unknown>;
  push?: Response;
  domainBadge?: Response;
};

let fetchSpy: ReturnType<typeof vi.fn>;

function routeFetch(o: Overrides = {}) {
  fetchSpy = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/auth/session') return Promise.resolve(json(o.session ?? { userId: 'me', nickname: 'me' }));
    if (url === '/api/profile/image') return Promise.resolve(json(null));
    if (url.startsWith('/api/my/posts')) return Promise.resolve(json({ posts: [] }));
    if (url === '/api/topics') return Promise.resolve(json({ topics: [] }));
    if (url.startsWith('/api/bookmarks')) return Promise.resolve(json({ posts: [] }));
    if (url === '/api/push/preferences') return Promise.resolve(o.push ?? json({ enabled: true, mutedTopicIds: [] }));
    if (url === '/api/profile/domain-badge') return Promise.resolve(o.domainBadge ?? json({ domains: [], availableDomain: null }));
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fetchSpy);
}

async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(node: React.ReactElement, locale: Locale = 'en') {
  await act(async () => {
    root.render(<I18nProvider initialLocale={locale}>{node}</I18nProvider>);
  });
  await flush();
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);
}

async function openSettings() {
  const tab = buttonByText(en.myPage.tabs.settings);
  expect(tab, 'Settings tab').toBeDefined();
  await act(async () => {
    tab!.click();
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  routerMock.push.mockClear();
  routerMock.replace.mockClear();
  backupState.value = { wrappedMaster: null, passkeys: [] };
  backupState.passkeySupported = true;
  routeFetch();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

// ─── Part 2 — /my identity block ─────────────────────────────────────────────

describe('MyPage — identity block', () => {
  it('EMPTY: a user with no nickname is named by the truncated nullifier, not by a blank heading', async () => {
    routeFetch({ session: { userId: '0xabcdef0123456789abcdef0123456789' } });
    await render(<MyPage />);
    const h1 = container.querySelector('h1') as HTMLElement;
    expect(h1).not.toBeNull();
    expect(h1.textContent!.trim().length).toBeGreaterThan(0);
  });

  it('EMPTY: no admin role and nothing recorded renders no badge row at all (not an empty box)', async () => {
    routeFetch({ session: { userId: 'me', nickname: 'me', totalRecorded: 0 } });
    await render(<MyPage />);
    expect(container.textContent).not.toContain(en.myPage.adminBadge);
    expect(container.textContent).not.toContain('recorded');
  });

  it('POPULATED: admin and on-chain claims both render as chips under the name', async () => {
    routeFetch({ session: { userId: 'me', nickname: 'me', role: 'admin', totalRecorded: 3 } });
    await render(<MyPage />);
    expect(container.textContent).toContain(en.myPage.adminBadge);
    expect(container.textContent).toContain('recorded 3 times on Base');
  });

  it('the privacy claim the design leads with is on the page', async () => {
    await render(<MyPage />);
    expect(container.textContent).toContain(en.myPage.identityNote);
  });

  it.each([
    ['boundary — 200 chars', 'n'.repeat(200)],
    ['boundary — 1 char', 'x'],
    ['UTF-8 — Korean', '한글닉네임'],
    ['UTF-8 — emoji', '🦄_agent_🎉'],
    ['hostile — HTML shaped', '<script>alert(1)</script>'],
  ])('%s: the nickname renders verbatim as text', async (_label, nickname) => {
    routeFetch({ session: { userId: 'me', nickname } });
    await render(<MyPage />);
    const h1 = container.querySelector('h1') as HTMLElement;
    expect(h1.textContent).toBe(nickname);
    // Rendered as text, never as markup.
    expect(container.querySelector('script')).toBeNull();
    // Long/unbreakable names must be allowed to wrap out of their box.
    expect(h1.style.overflowWrap).toBe('anywhere');
  });

  it('AUTHZ: a guest is redirected and renders nothing', async () => {
    routeFetch({ session: {} });
    await render(<MyPage />);
    expect(routerMock.replace).toHaveBeenCalledWith('/');
    expect(container.querySelector('h1')).toBeNull();
  });
});

// ─── Part 3 — /my settings tab ───────────────────────────────────────────────

describe('MyPage — settings reads as one list', () => {
  it('every section is titled with `.os-label` (uppercase gated to :lang(en))', async () => {
    await render(<MyPage />);
    await openSettings();
    const headings = Array.from(container.querySelectorAll('h3.os-label'));
    expect(headings.map((h) => h.textContent)).toEqual([
      en.myPage.settings.groups.preferences,
      en.myPage.settings.groups.profile,
      en.myPage.settings.aiAgents.title,
      en.myPage.settings.recovery.title,
      en.myPage.settings.account.title,
    ]);
    // Never hand-rolled: the class is what gates uppercase away from Hangul.
    for (const h of headings) expect((h as HTMLElement).style.textTransform).toBe('');
  });

  it('KO: the same headings render in Korean, still via `.os-label`', async () => {
    await render(<MyPage />, 'ko');
    const tabs = Array.from(container.querySelectorAll('button'));
    const settingsTab = tabs[tabs.length - 1];
    await act(async () => settingsTab.click());
    await flush();
    expect(container.querySelectorAll('h3.os-label').length).toBe(5);
    expect(container.textContent).toContain('환경설정');
  });

  it('the preferences list carries language, theme and push in one list', async () => {
    await render(<MyPage />);
    await openSettings();
    expect(container.textContent).toContain(en.common.language);
    expect(container.textContent).toContain(en.myPage.settings.theme.title);
    expect(container.querySelector('select.os-locale-select')).not.toBeNull();
    expect(container.querySelector('button[role="switch"]')).not.toBeNull();
  });

  it('INTEGRITY: a failed push-preferences load says so — it never renders a confident "off"', async () => {
    routeFetch({ push: json({}, false, 500) });
    await render(<MyPage />);
    await openSettings();
    expect(container.textContent).toContain(en.myPage.settings.notifications.loadFailed);
    expect(container.textContent).not.toContain(en.myPage.settings.notifications.pushOffHint);
    // No switch to flip while we do not know the value.
    expect(container.querySelector('button[role="switch"]')).toBeNull();
  });

  it('EMPTY: no verified domain renders the "none found" row, with no chips', async () => {
    await render(<MyPage />);
    await openSettings();
    expect(container.textContent).toContain(en.myPage.settings.domainBadges.noneFound);
    expect(buttonByText(en.myPage.settings.domainBadges.show)).toBeUndefined();
    expect(buttonByText(en.myPage.settings.domainBadges.hide)).toBeUndefined();
  });

  it('POPULATED: an active badge gets Hide, an available one gets Show', async () => {
    routeFetch({ domainBadge: json({ domains: ['masselabs.com'], availableDomain: 'other.com' }) });
    await render(<MyPage />);
    await openSettings();
    expect(container.textContent).toContain('masselabs.com');
    expect(container.textContent).toContain('other.com');
    expect(buttonByText(en.myPage.settings.domainBadges.hide)).toBeDefined();
    expect(buttonByText(en.myPage.settings.domainBadges.show)).toBeDefined();
  });

  it('CONTRACT: the Recovery row still links out to /recovery (FIX8 stays intact)', async () => {
    await render(<MyPage />);
    await openSettings();
    const link = container.querySelector('a[href="/recovery"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe(en.myPage.settings.recovery.cta);
  });

  it('the irreversible action asks for a typed confirmation before it enables', async () => {
    await render(<MyPage />);
    await openSettings();
    await act(async () => buttonByText(en.myPage.settings.dangerZone.deleteAccount)!.click());
    await flush();
    const confirm = buttonByText(en.myPage.settings.dangerZone.confirm) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    // No DELETE request may have gone out from merely opening the form.
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).not.toContain('/api/account');
  });
});

// ─── Part 4 — AiAgentSettings inside that surface ────────────────────────────

const RAW_KEY = `osk_${'a'.repeat(48)}`;

function keyFetch(overrides: { keys?: unknown[] } = {}) {
  const calls: string[] = [];
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/profile/api-keys' && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(json({ apiKeys: overrides.keys ?? [], allowedCmd: ['topics.read'] }));
    }
    if (url === '/api/profile/api-keys' && init?.method === 'POST') {
      return Promise.resolve(
        json({
          rawKey: RAW_KEY,
          key: {
            id: 'k1', name: 'laptop', prefix: 'osk_aaaaaaaa', isAI: true,
            cmd: ['topics.read'], historyGrant: 'none',
            createdAt: null, lastUsedAt: null, revokedAt: null,
          },
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', spy);
  return { spy, calls };
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('AiAgentSettings — the raw key is shown once and only once', () => {
  it('EMPTY: no keys yet renders the empty row, and no key material anywhere', async () => {
    keyFetch();
    await render(<AiAgentSettings />);
    expect(container.textContent).toContain(en.aiAgentSettings.noApiKeys);
    expect(container.textContent).not.toContain('osk_a');
  });

  it('CONTRACT: after creating, the raw key appears once; the list carries only the prefix; no re-fetch', async () => {
    const { calls } = keyFetch();
    await render(<AiAgentSettings />);

    const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => typeInto(nameInput, 'laptop'));
    await act(async () => buttonByText(en.aiAgentSettings.createKey)!.click());
    await flush();

    // Shown exactly once, in exactly one place.
    const shown = Array.from(container.querySelectorAll('code')).filter((c) => c.textContent === RAW_KEY);
    expect(shown.length).toBe(1);
    // The list row beside it never carries the secret.
    expect(container.textContent).toContain('osk_aaaaaaaa');

    // The key list is NOT re-read after creation — a refetch is exactly how a
    // "shown once" secret would come back from the server.
    expect(calls.filter((c) => c === 'GET /api/profile/api-keys').length).toBe(1);

    // Dismissing it removes it for good, still without asking the server.
    await act(async () => buttonByText(en.aiAgentSettings.dismissSavedKey)!.click());
    await flush();
    expect(container.textContent).not.toContain(RAW_KEY);
    expect(calls.filter((c) => c === 'GET /api/profile/api-keys').length).toBe(1);
  });

  it('the create control is disabled until the key has a valid name', async () => {
    keyFetch();
    await render(<AiAgentSettings />);
    expect((buttonByText(en.aiAgentSettings.createKey) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the scope chips use the shared `.os-chip` control (focus ring, tap size)', async () => {
    keyFetch();
    await render(<AiAgentSettings />);
    const chips = container.querySelectorAll('button.os-chip[aria-pressed]');
    expect(chips.length).toBeGreaterThan(0);
  });
});

// ─── Part 5 — AccountRecovery inside that surface ────────────────────────────

describe('AccountRecovery — states are distinguishable', () => {
  it('EMPTY: nothing configured says so in the warning tone, not in silence', async () => {
    backupState.value = { wrappedMaster: null, passkeys: [] };
    await render(<AccountRecovery userId="me" displayName="me" />);
    expect(container.textContent).toContain(en.accountRecovery.statusNotSetUp);
  });

  it('POPULATED: a registered passkey is reported as set up', async () => {
    backupState.value = { wrappedMaster: null, passkeys: ['c1'] };
    await render(<AccountRecovery userId="me" displayName="me" />);
    expect(container.textContent).toContain(en.accountRecovery.statusSetUp);
  });

  it('a browser without passkey support still offers the recovery-code path', async () => {
    backupState.passkeySupported = false;
    await render(<AccountRecovery userId="me" displayName="me" />);
    expect(container.textContent).not.toContain(en.accountRecovery.registerPasskey);
    expect(buttonByText(en.accountRecovery.generateRecoveryCode)).toBeDefined();
  });

  it('the page names itself with a real heading — it has no sidebar or tab bar to do it', async () => {
    await render(<AccountRecovery userId="me" displayName="me" />);
    const h1 = container.querySelector('h1') as HTMLElement;
    expect(h1.textContent).toBe(en.accountRecovery.heading);
    expect(h1.style.fontSize).toBe('var(--text-heading-lg)');
    // Its sections are labelled with the same idiom as `/my`'s.
    expect(container.querySelectorAll('h2.os-label').length).toBe(3);
  });
});
