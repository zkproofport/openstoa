/**
 * `RecoveryNudge` and the top of the screen.
 *
 * HISTORY, because this file's assertion was INVERTED and that is easy to
 * mistake for a regression. The banner used to be mounted at OpenStoaApp's
 * ROOT, above `OpenStoaTabNavigator`, with nothing between it and the window —
 * so a flat `marginTop: 12` put its top edge under the status bar / notch, and
 * this file asserted it must add `insets.top` itself.
 *
 * The banner is now Profile-only (product decision: it nagged from first launch
 * on every tab, about chat keys, to people reading the feed). Its one mount
 * point is inside `ProfileHomeScreen`, which lives in `ProfileStack` under
 * `MiniAppHeader` (`navigation/shared.tsx`) — and that header ALREADY applies
 * `paddingTop: insets.top`. A banner that also added the inset would double it
 * and sit ~50px down the screen on a notched device.
 *
 * So the property being defended is the same one ("the banner is not laid out
 * wrongly relative to the status bar"); the mechanism that satisfies it moved
 * from the banner to the header above it. This file asserts BOTH halves, because
 * either alone is a half-truth: the banner adds no inset of its own, AND the
 * surface it mounts under still consumes one.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   — the banner's rendered top offset is INDEPENDENT of the window
 *                inset (0 and 51 produce the same offset): re-adding
 *                `insets.top` to the banner turns this red
 *   contract   — the header above its mount point does consume `insets.top`,
 *                asserted at the source, so "the banner does not need to" stays
 *                a fact rather than an assumption
 *   boundary   — inset of 0 renders the banner normally (no crash, no
 *                disappearance); 51 is the notch-class device
 *   integrity  — the banner's own content (title/body/cta/dismiss) is
 *                unaffected by the inset — this is a LAYOUT property, not a
 *                content one
 *   authz      — N/A here (covered by the `shouldNudgeRecovery` matrix in
 *                `recoveryKeychainBackup.test.ts`); this file only exercises
 *                the one path that reaches `show=true` so there is a banner
 *   race       — two mounts in a row (mount → dismiss → remount) do not
 *                regress into a double-mount or a lingering timer; folded
 *                into the dismissal-persistence test below since it already
 *                remounts
 *   hostile/UTF-8/very large — N/A: this component takes no free text input
 *
 * WHERE THE BANNER MAY BE MOUNTED AT ALL is a different question, and it is
 * asserted structurally in `recoveryNudgeProfileOnly.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HostProvider } from '@openstoa/miniapp-bridge';
import { render, flush, type Rendered } from './harness/render';
import { hostDouble, type HostDouble } from './harness/screen';
import { setSafeAreaInsets, resetSafeAreaInsets } from './harness/safeAreaStub';
import { useOpenStoaSession } from '../stores/sessionStore';
import { recoveryNudgeDismissKey } from '../lib/recoveryNudge';

const transport = vi.hoisted(() => ({
  ensureTakKeychainBackup: vi.fn(async () => 'uploaded' as const),
  getBackup: vi.fn(async () => ({ wrappedMaster: null, passkeys: [] as unknown[] })),
}));

// `RecoveryNudge` imports `AccountRecoveryScreen` for its modal content, and
// the harness's `Modal` stand-in renders `children` unconditionally (it does
// not gate on `visible` — see `reactNative.tsx`), so `AccountRecoveryScreen`
// mounts for real even though the modal is never opened in these tests. Its
// own mount effect calls `keyBackupHttp(...).getBackup()` — the SAME mock
// below — so nothing extra is needed for that; `recoverDevice`,
// `getDeviceMasterKey` and `uploadTakKeychainNow` are only reached from
// button handlers this file never presses, so no-op stubs are enough.
//
// `ensureTakKeychainBackup` is reached from `RecoveryRepairProvider` now, not
// from the banner — same module, same mock.
vi.mock('../crypto/mobileTransport', () => ({
  ensureTakKeychainBackup: transport.ensureTakKeychainBackup,
  keyBackupHttp: () => ({ getBackup: transport.getBackup }),
  recoverDevice: vi.fn(),
  getDeviceMasterKey: vi.fn(),
  uploadTakKeychainNow: vi.fn(),
}));

import { RecoveryNudge } from '../components/RecoveryNudge';
import { RecoveryRepairProvider } from '../components/RecoveryRepair';

const USER_ID = 'u-recovery-nudge-1';
const TITLE = 'openstoa.recoveryNudge.title';
const DISMISS = 'openstoa.recoveryNudge.dismiss';

/**
 * Mount the banner the way the app does: inside the repair provider, which is
 * what decides whether there is a banner at all. Mounting `<RecoveryNudge/>`
 * bare would render nothing — the provider owns the decision now — so this
 * composition is the unit under test, not a convenience wrapper.
 */
async function mount(host: HostDouble): Promise<Rendered> {
  return render(
    <HostProvider api={host.api as never}>
      <RecoveryRepairProvider>
        <RecoveryNudge />
      </RecoveryRepairProvider>
    </HostProvider>,
  );
}

function signIn() {
  useOpenStoaSession.setState({
    mode: 'authenticated',
    token: 'test-token',
    userId: USER_ID,
    nickname: 'tester',
    needsNickname: false,
    expiresAt: null,
    role: 'member',
  });
}

/** Every ancestor of `node`, nearest first. */
function ancestorsOf(node: NonNullable<ReturnType<Rendered['pressableWith']>>) {
  const chain: typeof node[] = [];
  // `ReactTestInstance.parent` walks toward the root; stop at the top.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let n: any = (node as any).parent;
  while (n) {
    chain.push(n);
    n = n.parent;
  }
  return chain;
}

/** Does `node` sit under a `SafeAreaView` that includes the top edge? */
function hasTopSafeAreaAncestor(node: NonNullable<ReturnType<Rendered['pressableWith']>>): boolean {
  return ancestorsOf(node).some((n) => {
    // Widened deliberately: react-test-renderer types `type` as the union of
    // React Native's OWN host components, which cannot include the harness's
    // stub. Compared unwidened, tsc proves the branch dead (TS2367) and the
    // matcher silently stops seeing the very thing it exists to see. The stub
    // really does render a host element named 'SafeAreaView' (see
    // harness/safeAreaStub.tsx).
    if (typeof n.type !== 'string' || (n.type as string) !== 'SafeAreaView') return false;
    const edges = n.props.edges as string[] | undefined;
    return !edges || edges.includes('top');
  });
}

/** Sum of `marginTop`/`paddingTop` across `node` and its ancestors. */
function staticTopOffset(node: NonNullable<ReturnType<Rendered['pressableWith']>>): number {
  const nodes = [node, ...ancestorsOf(node)];
  let total = 0;
  for (const n of nodes) {
    const style = n.props?.style;
    if (style && typeof style === 'object' && !Array.isArray(style)) {
      const s = style as Record<string, unknown>;
      if (typeof s.marginTop === 'number') total += s.marginTop;
      if (typeof s.paddingTop === 'number') total += s.paddingTop;
    }
  }
  return total;
}

/** Render once at `top` and report the banner's total top offset. */
async function topOffsetAtInset(top: number): Promise<number> {
  setSafeAreaInsets({ top });
  signIn();
  const rendered = await mount(hostDouble());
  await flush();

  const banner = rendered.root.findAll((n) => n.props?.accessibilityRole === 'alert')[0];
  expect(banner, 'expected the nudge banner to render (shouldNudgeRecovery should be true here)').toBeDefined();
  expect(
    hasTopSafeAreaAncestor(banner),
    'the banner wrapped itself in a SafeAreaView(top) — its mount point is already below MiniAppHeader',
  ).toBe(false);

  const offset = staticTopOffset(banner);
  rendered.unmount();
  return offset;
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.ensureTakKeychainBackup.mockResolvedValue('uploaded');
  transport.getBackup.mockResolvedValue({ wrappedMaster: null, passkeys: [] });
  resetSafeAreaInsets();
});

afterEach(() => {
  useOpenStoaSession.getState().clear();
  resetSafeAreaInsets();
});

describe('RecoveryNudge — top offset', () => {
  it('CONTRACT: the banner adds no window inset of its own', async () => {
    // 0 vs a notch-class 51. Asserting EQUALITY rather than a bound is what
    // makes this bite: any re-introduction of `insets.top` inside the banner
    // (`marginTop: GAP + insets.top`, a `SafeAreaView` wrapper, a
    // `paddingTop: insets.top` on an ancestor it renders itself) moves one of
    // these two numbers and not the other.
    const flat = await topOffsetAtInset(0);
    const notched = await topOffsetAtInset(51);

    expect(
      notched,
      `the banner's top offset changed with the window inset (${flat}px → ${notched}px). ` +
        'Its mount point is inside ProfileStack, under MiniAppHeader, which already applies ' +
        'paddingTop: insets.top — adding it here double-counts it.',
    ).toBe(flat);
  });

  it('CONTRACT: the header above its mount point is what consumes the inset', () => {
    // The other half of the contract above. Without this, "the banner needs no
    // inset" is an assumption about a file this test never looks at, and the
    // day someone sets `headerShown: false` on ProfileHome the banner goes
    // under the status bar with every test still green.
    const src = join(__dirname, '..');

    const header = readFileSync(join(src, 'navigation/shared.tsx'), 'utf8');
    expect(header, 'MiniAppHeader stopped padding for the safe-area top inset').toContain(
      'paddingTop: insets.top',
    );

    const stack = readFileSync(join(src, 'navigation/stacks/ProfileStack.tsx'), 'utf8');
    // ProfileHome renders under that header: the stack takes its screenOptions
    // from the shared factory, and nothing turns the header off.
    expect(stack).toContain('useMiniAppStackScreenOptions');
    expect(stack).toContain('screenOptions={screenOptions}');
    expect(stack).toMatch(/name="ProfileHome"/);
    expect(stack, 'ProfileHome lost its header — the banner now needs the inset back').not.toContain(
      'headerShown: false',
    );
  });

  it('BOUNDARY: a zero inset still renders the banner (no crash, no disappearance)', async () => {
    setSafeAreaInsets({ top: 0 });
    signIn();
    const host = hostDouble();

    const rendered = await mount(host);
    await flush();

    expect(rendered.text()).toContain(TITLE);
    rendered.unmount();
  });

  it('INTEGRITY: the inset does not touch the banner content', async () => {
    setSafeAreaInsets({ top: 51 });
    signIn();
    const host = hostDouble();

    const rendered = await mount(host);
    await flush();

    expect(rendered.text()).toContain(TITLE);
    expect(rendered.text()).toContain('openstoa.recoveryNudge.body');
    expect(rendered.text()).toContain('openstoa.recoveryNudge.cta');
    expect(rendered.text()).toContain(DISMISS);

    rendered.unmount();
  });
});

describe('RecoveryNudge — dismissal persists across a remount', () => {
  it('pressing "Not now" writes the per-account dismissal key, and a fresh mount stays quiet', async () => {
    signIn();
    const host = hostDouble(); // SAME host/localStore reused across both mounts below

    const first = await mount(host);
    await flush();
    expect(first.text(), 'banner should be showing before dismissal').toContain(TITLE);

    await first.press(first.pressableWith(DISMISS)!);

    expect(await host.localStore.getItem(recoveryNudgeDismissKey(USER_ID))).toBe('1');
    expect(first.text()).not.toContain(TITLE);
    first.unmount();

    // RACE / boundary: mount a second, independent instance against the SAME
    // host — this is what actually happens when the Profile screen is torn
    // down and rebuilt — and confirm the earlier dismissal is not forgotten.
    const second = await mount(host);
    await flush();
    expect(second.text(), 'dismissal did not survive a remount').not.toContain(TITLE);

    second.unmount();
  });
});

describe('RecoveryNudge — an account switch without an app restart', () => {
  it('CONTRACT: the next person gets their own prompt after the first dismisses', async () => {
    // The repair provider wraps the navigator, so tab navigation never remounts
    // it and a run-once latch survives the whole app run. With a bare
    // `useRef(false)` that latch outlived the account it ran for: A dismissed,
    // B signed in without a restart, and B never saw their own prompt — `show`
    // stayed false from A's dismissal and the effect returned on the latch
    // before it could look at B at all.
    //
    // That is precisely the case `recoveryNudgeDismissKey` is keyed per account
    // to prevent ("a handed-over phone must not hide the prompt for the next
    // person, who has their own unprotected history"). The key was right; the
    // latch above it made the key moot.
    const OTHER_USER_ID = 'u-recovery-nudge-2';
    signIn();
    const host = hostDouble(); // one device, so one store across both accounts

    const rendered = await mount(host);
    await flush();
    expect(rendered.text(), 'first account should be prompted').toContain(TITLE);

    await rendered.press(rendered.pressableWith(DISMISS)!);
    expect(rendered.text()).not.toContain(TITLE);
    expect(await host.localStore.getItem(recoveryNudgeDismissKey(USER_ID))).toBe('1');

    // The SAME mounted instance now sees a different signed-in account, which
    // is what a sign-out/sign-in without an app restart does to it.
    useOpenStoaSession.setState({
      mode: 'authenticated',
      token: 'test-token-2',
      userId: OTHER_USER_ID,
      nickname: 'tester-two',
      needsNickname: false,
      expiresAt: null,
      role: 'member',
    });
    await flush();

    expect(
      rendered.text(),
      "the second account inherited the first account's dismissal",
    ).toContain(TITLE);

    // INTEGRITY: the first account's dismissal is still recorded — the fix
    // re-decides for the new account, it does not wipe the old decision.
    expect(await host.localStore.getItem(recoveryNudgeDismissKey(USER_ID))).toBe('1');
    expect(await host.localStore.getItem(recoveryNudgeDismissKey(OTHER_USER_ID))).toBeNull();

    rendered.unmount();
  });

  it('INTEGRITY: the same account staying signed in is still only decided once', async () => {
    // Guards the fix from over-correcting into "re-run on every render", which
    // would re-show a banner the user just dismissed.
    signIn();
    const host = hostDouble();

    const rendered = await mount(host);
    await flush();
    await rendered.press(rendered.pressableWith(DISMISS)!);
    expect(rendered.text()).not.toContain(TITLE);

    // Same userId, new object identity — a re-render, not an account change.
    signIn();
    await flush();

    expect(rendered.text(), 'a re-render re-showed a dismissed banner').not.toContain(TITLE);
    rendered.unmount();
  });
});
