/**
 * A-3: the mini-app's kick surface (TopicMembersScreen) must not silently
 * claim a clean removal when an AI (or any) member's devices could not all
 * be evicted from the encrypted group.
 *
 * `reconcileAfterKick` is the extracted, directly-testable core of that —
 * see its own docstring for why it lives outside the screen: the screen's
 * kick action is reached through ActionSheetIOS → a confirm Alert, and the
 * test harness's thin RN stand-in
 * (`packages/mobile/src/__tests__/harness/reactNative.tsx`) records only
 * `Alert.alert`'s title/message, not its `buttons` callbacks — so nothing
 * can drive a mounted screen through that confirm click today. This file
 * pins the logic that actually matters instead of the dialog around it.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → 'a partial removal is reported' / 'reconcileMembership is
 *                called with the topicId and the REMAINING members from the
 *                SERVER, not a stale cache'
 *   integrity  → 'a CLEAN removal reports zero'
 *   boundary   → 'an EMPTY remaining-members list is refused, not swept'
 *                (0 members) / exactly one remaining member (1) is swept
 *   external   → 'the members GET failing reports zero, not a throw'
 *              → 'reconcileMembership REJECTING reports zero, not a throw'
 *   hostile/UTF-8/large/race → N/A: the input this function acts on is a
 *                server-returned userId list and an integer count from the
 *                MLS layer, not raw user text — same as the web-side
 *                equivalent test (src/__tests__/kickPartialNotice.test.tsx).
 *   authz      → N/A: the kick's authorization is the DELETE route's job,
 *                unchanged by this function, which only runs after that
 *                route has already succeeded.
 */
import { describe, it, expect, vi } from 'vitest';
import { reconcileAfterKick } from '../screens/topics/reconcileAfterKick';
import type { OpenStoaClient } from '../api/openstoaClient';
import type { MlsSessionStore } from '../crypto/mlsSession';

const TOPIC = 't1';

function fakeClient(members: Array<{ userId: string }> | (() => never)): OpenStoaClient {
  return {
    get: vi.fn(async () => {
      if (typeof members === 'function') return members();
      return { members };
    }),
  } as unknown as OpenStoaClient;
}

function fakeMls(
  impl: (topicId: string, ids: string[]) => Promise<{ epoch: number; removed: number; unattributable: number }>,
): MlsSessionStore {
  return { reconcileMembership: vi.fn(impl) } as unknown as MlsSessionStore;
}

describe('reconcileAfterKick', () => {
  it('CONTRACT: reports how many devices a partial removal left behind', async () => {
    const client = fakeClient([{ userId: 'me' }, { userId: 'carol' }]);
    const mls = fakeMls(async () => ({ epoch: 5, removed: 1, unattributable: 3 }));

    const count = await reconcileAfterKick(client, mls, TOPIC);

    expect(count).toBe(3);
  });

  it('INTEGRITY: a clean removal reports zero', async () => {
    const client = fakeClient([{ userId: 'me' }]);
    const mls = fakeMls(async () => ({ epoch: 5, removed: 1, unattributable: 0 }));

    expect(await reconcileAfterKick(client, mls, TOPIC)).toBe(0);
  });

  it('CONTRACT: reconcileMembership is called with the topicId and the fresh member ids', async () => {
    const client = fakeClient([{ userId: 'me' }, { userId: 'carol' }, { userId: 'ai-bot' }]);
    const mls = fakeMls(async () => ({ epoch: 5, removed: 0, unattributable: 0 }));

    await reconcileAfterKick(client, mls, TOPIC);

    expect(mls.reconcileMembership).toHaveBeenCalledTimes(1);
    expect(mls.reconcileMembership).toHaveBeenCalledWith(TOPIC, ['me', 'carol', 'ai-bot']);
  });

  it('BOUNDARY: an empty remaining-members list is refused, not swept', async () => {
    // Sweeping an empty list would read to reconcileMembership as "nobody is
    // a member", which evicts every leaf still in the tree — the guard must
    // fire before the call, not rely on the MLS layer refusing it.
    const client = fakeClient([]);
    const mls = fakeMls(async () => ({ epoch: 5, removed: 99, unattributable: 0 }));

    const count = await reconcileAfterKick(client, mls, TOPIC);

    expect(count).toBe(0);
    expect(mls.reconcileMembership).not.toHaveBeenCalled();
  });

  it('BOUNDARY: exactly one remaining member is still swept', async () => {
    const client = fakeClient([{ userId: 'me' }]);
    const mls = fakeMls(async (_topicId, ids) => {
      expect(ids).toEqual(['me']);
      return { epoch: 2, removed: 0, unattributable: 1 };
    });

    expect(await reconcileAfterKick(client, mls, TOPIC)).toBe(1);
  });

  it('EXTERNAL FAILURE: the members GET rejecting reports zero, not a throw', async () => {
    const client = fakeClient((() => {
      throw new Error('network down');
    }) as never);
    const mls = fakeMls(async () => ({ epoch: 5, removed: 0, unattributable: 0 }));

    await expect(reconcileAfterKick(client, mls, TOPIC)).resolves.toBe(0);
    expect(mls.reconcileMembership).not.toHaveBeenCalled();
  });

  it('EXTERNAL FAILURE: reconcileMembership rejecting (epoch-CAS loss) reports zero, not a throw', async () => {
    // A failed sweep is not a false assurance — the tree is untouched and the
    // next member's client reconciles instead. Reporting anything nonzero
    // here would tell the admin devices were left behind when nothing was
    // actually determined.
    const client = fakeClient([{ userId: 'me' }]);
    const mls = fakeMls(async () => {
      throw new Error('epoch-CAS lost');
    });

    await expect(reconcileAfterKick(client, mls, TOPIC)).resolves.toBe(0);
  });
});
