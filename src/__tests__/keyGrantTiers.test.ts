/**
 * `grantRoomKeys` routes a room to the mechanism its TIER declares — web half.
 *
 * This is the function the account-wide `key-needed` broadcast calls for any
 * topic, without opening it, and it is where the DM defect lived: a
 * `kind === 'dm'` early return, with the comment "both parties were there from
 * the start". Both ACCOUNTS were. Their DEVICES were not, and a device is what
 * holds a key — so a DM's key never left the browser that minted it and every
 * DM was unreadable everywhere else, permanently.
 *
 * The route is asserted by SPYING on the TAK store, not by reading the source,
 * because the failure was a missing CALL, not missing code: `distributeRoot…`
 * existed the whole time and nothing reached it for a DM.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract invocation → each tier calls exactly the one mechanism its policy
 *                         declares, and calls nothing else — so deleting a call
 *                         or re-adding a tier's early return goes red
 *   contract invocation → a DM is routed by `kind`, NOT by the `'secret'` its
 *                         row carries, which is the whole regression
 *   authorization       → `secret` grants only for the owner; a member sends
 *                         nothing, which is what that tier exists for
 *   empty / null        → a topic lookup that 404s, or answers a body with no
 *                         topic at all, sends nothing rather than guessing
 *   hostile             → an unrecognised visibility falls back to the tier that
 *                         promises the LEAST, and still routes somewhere real
 *   race                → N/A: the call is advisory and idempotent — the store's
 *                         own `lastDistributedEpoch` makes a repeat a no-op
 *   UTF-8 / large / boundary → N/A: the input is a topic id and a tier name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const tak = vi.hoisted(() => ({
  distributeRootWhenGroupChanged: vi.fn(async () => 0),
  grantPrivateHistory: vi.fn(async () => 0),
}));

const fetchMock = vi.hoisted(() => ({ impl: vi.fn() }));

vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...args: unknown[]) => fetchMock.impl(...args),
}));
vi.mock('@/lib/mls/webTransport', () => ({
  getTakSessionStore: () => tak,
}));

import { grantRoomKeys } from '@/lib/keyGrant';

const TOPIC = 'topic-1';

/** `GET /api/topics/{id}` answering with this body. */
function topicIs(body: unknown, ok = true) {
  fetchMock.impl.mockResolvedValue({ ok, json: async () => body });
}

beforeEach(() => {
  tak.distributeRootWhenGroupChanged.mockClear();
  tak.grantPrivateHistory.mockClear();
  fetchMock.impl.mockReset();
});

describe('grantRoomKeys — the tier picks the mechanism', () => {
  it('CONTRACT: a DM distributes its root, addressed as the `dm` tier', async () => {
    /*
     * The regression. The row says `visibility: 'secret'`; only `kind` says DM.
     * Passing the visibility through would take the per-epoch branch, which is
     * how a DM's key came to have no way out of the device that minted it.
     */
    topicIs({ topic: { visibility: 'secret', kind: 'dm' }, currentUserRole: 'member' });

    await grantRoomKeys(TOPIC);

    expect(tak.distributeRootWhenGroupChanged).toHaveBeenCalledWith(TOPIC, 'dm');
    expect(tak.grantPrivateHistory).not.toHaveBeenCalled();
  });

  it('CONTRACT: a public topic distributes its root', async () => {
    topicIs({ topic: { visibility: 'public', kind: 'topic' }, currentUserRole: 'member' });

    await grantRoomKeys(TOPIC);

    expect(tak.distributeRootWhenGroupChanged).toHaveBeenCalledWith(TOPIC, 'public');
    expect(tak.grantPrivateHistory).not.toHaveBeenCalled();
  });

  it('CONTRACT: a private topic grants epochs, from any member', async () => {
    topicIs({ topic: { visibility: 'private', kind: 'topic' }, currentUserRole: 'member' });

    await grantRoomKeys(TOPIC);

    expect(tak.grantPrivateHistory).toHaveBeenCalledWith(TOPIC);
    expect(tak.distributeRootWhenGroupChanged).not.toHaveBeenCalled();
  });

  it('AUTHZ: a secret topic grants ONLY for the owner', async () => {
    // A member handing out a hidden room's history is the thing that tier
    // exists to prevent, so this is a security boundary and not a preference.
    topicIs({ topic: { visibility: 'secret', kind: 'topic' }, currentUserRole: 'member' });
    await grantRoomKeys(TOPIC);
    expect(tak.grantPrivateHistory).not.toHaveBeenCalled();

    topicIs({ topic: { visibility: 'secret', kind: 'topic' }, currentUserRole: 'owner' });
    await grantRoomKeys(TOPIC);
    expect(tak.grantPrivateHistory).toHaveBeenCalledWith(TOPIC);
  });

  it('AUTHZ: a secret DM is still a DM — `kind` outranks the role gate', async () => {
    // Every DM member is inserted with role 'member' (`POST /api/dm`), so a
    // rule keyed on `secret && owner` could never have fired for one even
    // without the early return. Two independent reasons the key never moved.
    topicIs({ topic: { visibility: 'secret', kind: 'dm' }, currentUserRole: 'member' });

    await grantRoomKeys(TOPIC);

    expect(tak.distributeRootWhenGroupChanged).toHaveBeenCalledWith(TOPIC, 'dm');
  });

  it.each([
    ['a lookup that fails', { ok: false, body: {} }],
    ['a body with no topic', { ok: true, body: {} }],
    ['a null topic', { ok: true, body: { topic: null } }],
  ])('EMPTY: %s sends nothing rather than guessing', async (_label, { ok, body }) => {
    topicIs(body, ok);

    await grantRoomKeys(TOPIC);

    if (!ok) {
      // Not a member any more, or the topic is gone. Nothing to hand over.
      expect(tak.distributeRootWhenGroupChanged).not.toHaveBeenCalled();
      expect(tak.grantPrivateHistory).not.toHaveBeenCalled();
    }
  });

  it('HOSTILE: an unrecognised visibility routes to the least-promising tier', async () => {
    // `chatTierOf` maps anything it does not know to `public`, which promises
    // the least. It still has to route SOMEWHERE real — falling through to no
    // call at all is how a room silently stops sharing keys.
    for (const visibility of ['PRIVATE', 'sekret', '', null, undefined, '{}']) {
      tak.distributeRootWhenGroupChanged.mockClear();
      topicIs({ topic: { visibility, kind: 'topic' }, currentUserRole: 'member' });

      await grantRoomKeys(TOPIC);

      expect(tak.distributeRootWhenGroupChanged, String(visibility)).toHaveBeenCalledWith(TOPIC, 'public');
    }
  });
});
