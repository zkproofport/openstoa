/**
 * The recovery banner is a PROFILE-TAB prompt, and the repair behind it is not.
 *
 * Both halves used to live in one component mounted at the app ROOT, above the
 * tab navigator. That made the banner appear on every tab from first launch —
 * telling someone reading the feed that "every message is gone for good" before
 * their account had any history worth protecting — so the product decision is
 * that the banner belongs on Profile alone.
 *
 * The trap in carrying that out is that the repair is the opposite kind of
 * thing. `ensureTakKeychainBackup` fixes accounts ALREADY in the broken state
 * (a wrapped master_key with an empty `tak_key_backups` row), and the reason
 * that state exists at all is that its old trigger fired only when a key was
 * newly written. Re-binding it to "the user opened Profile" is the same bug one
 * screen further out: accounts stay broken until someone wanders over. So the
 * split is the point of this file — banner narrowed, repair not.
 *
 * WHY STRUCTURAL AND NOT "FEED DOES NOT RENDER IT". A test that mounts one
 * other screen and finds no banner is one new screen away from being wrong, and
 * this repo has already shipped exactly that mistake: the mDL button was hidden
 * on `WelcomeScreen` and left visible on `SignInSheet`, with a green suite
 * (`welcomeMdlButton.test.tsx` records the postmortem). The assertion here is
 * over the WHOLE mini-app source: the set of files that render `<RecoveryNudge`
 * is exactly one, named. A second mount anywhere — a new tab, a modal, a
 * re-added root mount — fails this regardless of which screen it is.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   — exactly one file in the mini-app renders the banner, and it is
 *                ProfileHomeScreen (whole-tree scan, not a per-screen probe)
 *   contract   — that screen is reachable from the Profile tab and only there
 *                (registered in ProfileStack; ProfileStack is the ProfileTab)
 *   contract   — the repair still wraps the WHOLE navigator, so it runs for a
 *                signed-in account that never opens Profile
 *   contract   — the repair executes with no banner mounted at all (behavioural,
 *                not just structural: the provider is rendered childless and
 *                `ensureTakKeychainBackup` is still called)
 *   integrity  — the banner no longer calls the repair itself, so the two can
 *                not silently re-couple
 *   empty      — a banner rendered outside the provider renders nothing and
 *                repairs nothing, rather than throwing and taking a tab down
 *   boundary / hostile / UTF-8 / very large / authz / race — N/A: this file is
 *                about WHERE a component is mounted; the banner's own inputs,
 *                authorization and account-switch behaviour are covered in
 *                `recoveryNudgeSafeArea.test.tsx` and
 *                `recoveryKeychainBackup.test.ts`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { HostProvider } from '@openstoa/miniapp-bridge';
import { render, flush } from './harness/render';
import { hostDouble } from './harness/screen';
import { useOpenStoaSession } from '../stores/sessionStore';

const SRC = join(__dirname, '..');

/** The one file allowed to render the banner. */
const THE_MOUNT = 'screens/profile/ProfileHomeScreen.tsx';

/**
 * An actual JSX mount of the banner, and not a name that merely starts with it.
 * `RecoveryRepair.tsx` renders `<RecoveryNudgeContext.Provider>`, which a bare
 * `includes('<RecoveryNudge')` counts as a second mount — a false positive that
 * would have to be silenced by loosening this test, i.e. by making it worse.
 * The trailing class covers `<RecoveryNudge />`, `<RecoveryNudge>` and a future
 * `<RecoveryNudge prop={…}/>` while excluding an identifier that continues.
 */
const RENDERS_BANNER = /<RecoveryNudge[\s/>]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // __tests__ is excluded: this very file names the element it asserts on,
      // and so does the safe-area test, which mounts it directly.
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Strip line and block comments — including JSX `{/* … *\/}`, which is a block
 * comment in braces. Prose ABOUT the banner is fine (both components' headers
 * discuss it by name); rendering it is what this file counts.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const transport = vi.hoisted(() => ({
  ensureTakKeychainBackup: vi.fn(async () => 'uploaded' as const),
  getBackup: vi.fn(async () => ({ wrappedMaster: null, passkeys: [] as unknown[] })),
}));

vi.mock('../crypto/mobileTransport', () => ({
  ensureTakKeychainBackup: transport.ensureTakKeychainBackup,
  keyBackupHttp: () => ({ getBackup: transport.getBackup }),
  recoverDevice: vi.fn(),
  getDeviceMasterKey: vi.fn(),
  uploadTakKeychainNow: vi.fn(),
}));

import { RecoveryNudge } from '../components/RecoveryNudge';
import { RecoveryRepairProvider } from '../components/RecoveryRepair';

function signIn(userId = 'u-profile-only-1') {
  useOpenStoaSession.setState({
    mode: 'authenticated',
    token: 'test-token',
    userId,
    nickname: 'tester',
    needsNickname: false,
    expiresAt: null,
    role: 'member',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.ensureTakKeychainBackup.mockResolvedValue('uploaded');
  transport.getBackup.mockResolvedValue({ wrappedMaster: null, passkeys: [] });
});

afterEach(() => {
  useOpenStoaSession.getState().clear();
});

describe('the recovery banner is mounted on Profile and nowhere else', () => {
  it('CONTRACT: NO file in the mini-app renders <RecoveryNudge/>', () => {
    /*
     * The banner is gone entirely — it is not "on Profile only" any more.
     *
     * Narrowing it to the Profile tab was the previous step and it was still
     * wrong: the prompt appeared because a backup had never been made, which is
     * not the same as a backup being NEEDED. Someone who has no intention of
     * moving devices was told, every visit, to do a thing they did not need,
     * and dismissing it did not settle the question because the condition that
     * raised it never changed.
     *
     * A backup is something a person does when they are about to need it —
     * changing phones — and that moment is now handled where it actually
     * happens: signing in on a second device warns first, with the server's
     * real answer about whether a backup exists (see `deviceTakeover`). The
     * rest of the time it is a button in Profile → Chat recovery, and nothing
     * nags.
     *
     * The REPAIR is unaffected and its cases below still stand: it fixes
     * accounts already in the broken state and must keep running for someone
     * who never opens Profile at all.
     */
    const mounts = walk(SRC)
      .filter((file) => RENDERS_BANNER.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(SRC, file).split(/[\\/]/).join('/'))
      .sort();

    expect(
      mounts,
      'the recovery banner was removed; a backup is a Profile button and a ' +
        'second-device warning, never an unprompted nag',
    ).toEqual([]);
  });

  it('CONTRACT: Profile still offers the backup as something you choose to do', () => {
    // Removing the nag must not remove the ABILITY. If this ever fails, the
    // feature is unreachable and the second-device warning has nothing to
    // point at.
    const profile = stripComments(
      readFileSync(join(SRC, 'screens/profile/EditProfileScreen.tsx'), 'utf8'),
    );
    expect(profile).toContain("navigate('AccountRecovery')");
  });

  it('CONTRACT: that screen is the Profile tab, not a screen that happens to be nearby', () => {
    // Two links, both asserted, because narrowing the mount to one screen only
    // means "Profile only" if that screen is on the Profile tab and on no other.
    const stacks = join(SRC, 'navigation/stacks');
    const registrars = readdirSync(stacks)
      .filter((f) => stripComments(readFileSync(join(stacks, f), 'utf8')).includes('ProfileHomeScreen'))
      .sort();
    expect(registrars, 'ProfileHomeScreen is registered outside ProfileStack').toEqual([
      'ProfileStack.tsx',
    ]);

    const nav = stripComments(readFileSync(join(SRC, 'navigation/OpenStoaTabNavigator.tsx'), 'utf8'));
    expect(nav).toMatch(/name="ProfileTab"\s*\n?\s*component=\{ProfileStack\}/);
    // ProfileStack is not also wired under another tab.
    expect(nav.match(/component=\{ProfileStack\}/g)).toHaveLength(1);
  });

  it('CONTRACT: the repair still wraps the whole navigator, banner or no banner', () => {
    // The half that must NOT move. A repair that only runs on Profile leaves
    // every account that never opens Profile broken — which is the shape of
    // the original defect, not a smaller version of it.
    const app = stripComments(readFileSync(join(SRC, 'OpenStoaApp.tsx'), 'utf8'));

    expect(app, 'the root no longer mounts the repair at all').toContain('<RecoveryRepairProvider>');
    expect(
      app.replace(/\s+/g, ' '),
      'the repair provider no longer wraps the tab navigator, so it does not cover every tab',
    ).toContain('<RecoveryRepairProvider> <OpenStoaTabNavigator /> </RecoveryRepairProvider>');
    expect(RENDERS_BANNER.test(app), 'the banner is back at the root, on every tab').toBe(false);
  });

  it('INTEGRITY: the repair lives in the provider, not in the banner', () => {
    const banner = readFileSync(join(SRC, 'components/RecoveryNudge.tsx'), 'utf8');
    const provider = readFileSync(join(SRC, 'components/RecoveryRepair.tsx'), 'utf8');

    expect(provider).toContain('ensureTakKeychainBackup(');
    expect(
      stripComments(banner),
      'the banner calls the repair again — a Profile visit would re-trigger it, and the two ' +
        'have re-coupled into the arrangement this split undid',
    ).not.toContain('ensureTakKeychainBackup');
  });
});

describe('the repair runs without the banner', () => {
  it('CONTRACT: a childless provider still repairs the account', async () => {
    // The behavioural counterpart to the structural assertions above: even with
    // no banner in the tree at all — which is every tab except Profile — the
    // account-level repair executes.
    signIn();
    const host = hostDouble();

    const rendered = await render(
      <HostProvider api={host.api as never}>
        <RecoveryRepairProvider />
      </HostProvider>,
    );
    await flush();

    expect(
      transport.ensureTakKeychainBackup,
      'the repair did not run without a banner mounted — it is bound to the banner again',
    ).toHaveBeenCalledTimes(1);
    expect(rendered.text(), 'the provider rendered UI of its own').toBe('');

    rendered.unmount();
  });

  it('EMPTY: a banner rendered outside the provider is silent, not fatal', async () => {
    // The default context value. A mis-wired mount should render nothing rather
    // than throw and take the tab down with it — and it must not run a repair
    // of its own behind the app's back either.
    signIn();
    const host = hostDouble();

    const rendered = await render(
      <HostProvider api={host.api as never}>
        <RecoveryNudge />
      </HostProvider>,
    );
    await flush();

    expect(rendered.text()).not.toContain('openstoa.recoveryNudge.title');
    expect(transport.ensureTakKeychainBackup).not.toHaveBeenCalled();

    rendered.unmount();
  });
});
