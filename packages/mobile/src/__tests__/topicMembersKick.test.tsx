/**
 * A-3, mini-app side: `TopicMembersScreen` now wires a kick through
 * `reconcileAfterKick` (unit-pinned in `reconcileAfterKick.test.ts`) instead
 * of leaving the removed account's other devices in the encrypted group
 * until someone else's client happens to open the room.
 *
 * This file only proves the WIRING survived: the screen still mounts with
 * the new `useHost` / `getMlsSessionStore` imports, and an admin's long-press
 * on a plain member still reaches the native kick menu with the SAME
 * confirm-Alert contract as before. It does not re-drive the confirm click
 * itself — see `reconcileAfterKick.test.ts`'s docstring for why the test
 * harness's `Alert.alert` stand-in cannot do that (it records only
 * title/message, not the `buttons` array's `onPress` callbacks).
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract → 'the screen renders' (proves the new imports resolve); 'an
 *              admin long-pressing a member reaches the kick option, which
 *              in turn opens the SAME confirm dialog as before this change'
 *   authz    → 'a plain member gets no long-press handler on any row at all'
 *              (unchanged `isOwnerOrAdmin` gate — this work must not loosen it)
 *   boundary/hostile/UTF-8/empty/large/race → N/A here: unchanged by this
 *              screen's A-3 work; the part that changed (the reconcile +
 *              notice) is covered by reconcileAfterKick.test.ts instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { renderScreen } from './harness/screen';
import { flush } from './harness/render';
import { TopicMembersScreen } from '../screens/topics/TopicMembersScreen';
import { useOpenStoaSession } from '../stores/sessionStore';
// The stand-in aliased in for every '.tsx' test — see vitest.config.ts. Real
// import specifier so this file observes the SAME Alert/ActionSheetIOS the
// screen under test calls into, not a second copy.
import { Alert, ActionSheetIOS } from 'react-native';

const TOPIC = '11111111-2222-4333-8444-555555555555';

function membersFetch(currentUserRole: 'owner' | 'admin' | 'member') {
  const body = {
    members: [
      { userId: 'me', nickname: 'me', role: currentUserRole },
      { userId: 'u1', nickname: 'bob', role: 'member' },
    ],
    currentUserRole,
  };
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(`/api/topics/${TOPIC}/members`)) {
      return { ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response;
    }
    if (url.includes(`/api/topics/${TOPIC}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ currentUserRole }),
        text: async () => '',
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response;
  });
}

/** Every TouchableOpacity that would fire a long-press — i.e. every member
 *  row the current viewer can act on at all. */
function longPressableRows(root: ReactTestInstance) {
  return root.findAll((n) => typeof n.type === 'string' && n.type === 'TouchableOpacity' && !!n.props.onLongPress);
}

/**
 * Advance a REAL timer tick, inside `act`.
 *
 * `flush()` (harness/render.tsx) drains only the MICROTASK queue
 * (`await Promise.resolve()`), which never lets a `setTimeout` fire.
 * @tanstack/react-query's `notifyManager` batches the state update after a
 * query settles via `setTimeout(0)` in this Node test environment (it has no
 * way to detect React Native's batched-updates hook here), so a query whose
 * FETCH has resolved can still leave the component un-rerendered after any
 * number of microtask-only flushes — this screen fires two such queries
 * (members + topic meta). Without this, assertions raced the notification and
 * intermittently observed the pre-fetch tree.
 */
async function settleTimers(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/*
 * `useOpenStoaSession` is a real zustand store — a module-level singleton
 * that outlives any one `renderScreen()` call. Without pinning it here, this
 * file's own tests would depend on whichever mode a PRIOR render left behind
 * (mode='unknown' shows a SignInPrompt instead of the members list, which
 * silently satisfies the AUTHZ assertion below for the wrong reason). Set to
 * a known signed-in identity before every test, matching the admin/member
 * accounts `membersFetch` describes.
 */
beforeEach(() => {
  useOpenStoaSession.setState({
    mode: 'authenticated',
    token: 'test-token',
    userId: 'me',
    nickname: 'me',
    needsNickname: false,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    role: 'member',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Alert.reset();
  ActionSheetIOS.reset();
  useOpenStoaSession.setState({
    mode: 'unknown',
    token: null,
    userId: null,
    nickname: null,
    needsNickname: false,
    expiresAt: null,
    role: 'member',
  });
});

describe('TopicMembersScreen — kick wiring survives A-3', () => {
  it('CONTRACT: the screen renders with the new MLS-reconcile imports wired', async () => {
    vi.stubGlobal('fetch', membersFetch('admin'));
    const { rendered } = await renderScreen(<TopicMembersScreen />, { params: { topicId: TOPIC } });
    await flush(20);
    await settleTimers(); // see settleTimers()'s docstring for why this is needed

    expect(rendered.text()).toContain('bob');
    rendered.unmount();
  });

  it('CONTRACT: an admin long-pressing a plain member reaches the kick option and its confirm dialog', async () => {
    vi.stubGlobal('fetch', membersFetch('admin'));
    const { rendered } = await renderScreen(<TopicMembersScreen />, { params: { topicId: TOPIC } });
    await flush(20);
    await settleTimers();

    const rows = longPressableRows(rendered.root);
    expect(rows.length, 'an admin should get exactly one actionable row (bob; not themselves)').toBe(1);

    await act(async () => {
      (rows[0].props.onLongPress as () => void)();
    });

    expect(ActionSheetIOS.calls.length).toBe(1);
    const call = ActionSheetIOS.calls[0] as { options: { options: string[] }; callback: (i: number) => void };
    expect(call.options.options).toContain('openstoa.members.kick');

    // Selecting the kick option opens the SAME confirm dialog the pre-A-3
    // code did — this change must not alter what the admin is asked before
    // anything happens, only what they are told afterward.
    const kickIndex = call.options.options.indexOf('openstoa.members.kick');
    await act(async () => {
      call.callback(kickIndex);
    });

    expect(Alert.alerts).toContainEqual({
      title: 'openstoa.members.kick',
      message: 'openstoa.members.kickConfirm',
    });

    rendered.unmount();
  });

  it('AUTHZ: a plain member gets no long-press handler on any row', async () => {
    vi.stubGlobal('fetch', membersFetch('member'));
    const { rendered } = await renderScreen(<TopicMembersScreen />, { params: { topicId: TOPIC } });
    await flush(20);
    await settleTimers();

    // Guards against a false pass from the screen failing to render at all
    // (which would ALSO show zero long-pressable rows, for the wrong reason).
    expect(rendered.text()).toContain('bob');
    expect(longPressableRows(rendered.root)).toHaveLength(0);

    rendered.unmount();
  });
});
