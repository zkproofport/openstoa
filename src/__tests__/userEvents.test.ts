/**
 * Getting a key-holder to hand keys over without anyone opening a chat room.
 *
 * On the scoped tiers the server holds no key, so a newcomer can only be
 * unlocked by a device that already has one. That device is almost never in the
 * room — which is why a private topic's second device sat on "Encrypted — this
 * device has no key for it" until somebody happened to reopen the exact chat.
 * `inviteHistoryRepro.test.ts` proved the crypto was never at fault: the grant
 * works, it just was not being run.
 *
 * So this covers the nudge, and specifically the granularity of it. A first
 * attempt routed per ACCOUNT — stream if the account had one, push if not — and
 * that is wrong in the case that matters most: the browser is open while the
 * phone holding the keys is asleep. The account read as reachable, no push went
 * out, and the grant still never happened. The split is therefore per DEVICE.
 *
 * The security property is asserted directly rather than assumed: this channel
 * carries no key material. It says a topic may need keys; the keys themselves
 * still travel sealed to a recipient leaf through the bundle mailbox.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → every account is published to; devices without a stream are
 *                the ones woken
 *   integrity  → a device already streaming is never also pushed; the payload
 *                carries no key material; each account has its OWN channel
 *   boundary   → nobody; one device; several devices of one account, mixed
 *   empty      → an empty recipient list does nothing, including no presence read
 *   race       → the TTL outlives the heartbeat, and an expired marker stops
 *                counting on the next read rather than waiting for a sweep
 *   external   → Redis failing does not throw into an accepted commit
 *   hostile    → a presence field with a junk expiry is treated as absent
 *   authz      → N/A: the recipient set is the topic's member list, which the
 *                route reads; this module is told who, not who may
 *   UTF-8 / very large → N/A: ids and an integer epoch, no free text
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisMock = vi.hoisted(() => ({
  // Parameters are declared so `mock.calls` is typed: an untyped `vi.fn()`
  // infers an empty tuple and every read of a call argument is an error.
  publish: vi.fn(async (_channel: string, _payload: string) => 1),
  hgetall: vi.fn(async (_key: string) => ({}) as Record<string, string>),
  hset: vi.fn(async (_key: string, _field: string, _value: string) => 1),
  hdel: vi.fn(async (_key: string, _field: string) => 1),
  expire: vi.fn(async (_key: string, _seconds: number) => 1),
}));

vi.mock('@/lib/redis', () => ({ getRedis: () => redisMock }));

const {
  publishKeyNeeded,
  userChannel,
  markUserStreamOpen,
  markUserStreamClosed,
  streamingHandles,
  SSE_PRESENCE_TTL_SECONDS,
} = await import('@/lib/userEvents');

const TOPIC = '11111111-2222-4333-8444-555555555555';
const FUTURE = () => String(Date.now() + 60_000);

/** Say which devices of which accounts currently hold a stream. */
function presence(byUser: Record<string, string[]>) {
  redisMock.hgetall.mockImplementation(async (key: string) => {
    const userId = key.split(':').pop()!;
    const handles = byUser[userId] ?? [];
    return Object.fromEntries(handles.map((h) => [h, FUTURE()]));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  presence({});
});

describe('routing a key-needed nudge', () => {
  it('CONTRACT: every account is published to, on its own channel', async () => {
    await publishKeyNeeded(['alice', 'bob'], TOPIC, 7);

    const channels = redisMock.publish.mock.calls.map((c) => c[0]).sort();
    expect(channels).toEqual([userChannel('alice'), userChannel('bob')].sort());
  });

  it('CONTRACT: publishing does not depend on anyone listening', async () => {
    // A channel with no subscriber costs one no-op, and checking first was what
    // made the account-level decision look reasonable in the first place.
    presence({});
    await publishKeyNeeded(['alice'], TOPIC, 7);
    expect(redisMock.publish).toHaveBeenCalledTimes(1);
  });

  it('INTEGRITY: the browser being open does not silence the sleeping phone', async () => {
    /*
     * The defect this file exists for. Alice has a stream from her laptop and
     * none from her phone; the phone is the device holding the keys. Routing by
     * account called her reachable and sent no push, so the phone never granted.
     */
    presence({ alice: ['laptop'] });
    let seen: Map<string, Set<string>> | null = null;
    await publishKeyNeeded(['alice'], TOPIC, 3, async (perUser) => {
      seen = perUser;
    });

    expect(seen).not.toBeNull();
    const handles = seen!.get('alice')!;
    expect(handles.has('laptop'), 'the laptop was not reported as streaming').toBe(true);
    expect(handles.has('phone'), 'a device with no stream was reported as streaming').toBe(false);
  });

  it('BOUNDARY: several devices of one account are reported individually', async () => {
    presence({ alice: ['laptop', 'tablet'] });
    let seen: Map<string, Set<string>> | null = null;
    await publishKeyNeeded(['alice'], TOPIC, 1, async (perUser) => {
      seen = perUser;
    });

    expect([...seen!.get('alice')!].sort()).toEqual(['laptop', 'tablet']);
  });

  it('BOUNDARY: an account with nothing open reports an empty set, not a missing one', async () => {
    // The waker distinguishes "no streams" from "not asked about", so an empty
    // set has to be present rather than absent.
    presence({ alice: ['laptop'] });
    let seen: Map<string, Set<string>> | null = null;
    await publishKeyNeeded(['alice', 'bob'], TOPIC, 1, async (perUser) => {
      seen = perUser;
    });

    expect(seen!.has('bob')).toBe(true);
    expect(seen!.get('bob')!.size).toBe(0);
  });

  it('EMPTY: no recipients does nothing, and never reads presence', async () => {
    const wake = vi.fn(async () => {});
    await publishKeyNeeded([], TOPIC, 1, wake);

    expect(redisMock.publish).not.toHaveBeenCalled();
    expect(redisMock.hgetall).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it('CONTRACT: with no push wired, the SSE half still runs and presence is not read', async () => {
    // Push being unconfigured must never disable the primary route — that is
    // the whole reason the waker is a parameter and not a hard dependency.
    await expect(publishKeyNeeded(['alice'], TOPIC, 1)).resolves.toBeUndefined();
    expect(redisMock.publish).toHaveBeenCalledTimes(1);
    expect(redisMock.hgetall).not.toHaveBeenCalled();
  });

  it('INTEGRITY: the payload carries no key material', async () => {
    await publishKeyNeeded(['alice'], TOPIC, 9);

    const raw = redisMock.publish.mock.calls[0][1];
    const parsed = JSON.parse(raw) as { event: string; data: Record<string, unknown> };
    expect(parsed.event).toBe('key-needed');
    // An allow-list, not a search for known-bad names: a field added later is
    // caught by this even if nobody thinks to add it to a deny-list.
    expect(Object.keys(parsed.data).sort()).toEqual(['epoch', 'topicId']);
  });

  it('EXTERNAL FAILURE: Redis falling over does not throw into an accepted commit', async () => {
    redisMock.publish.mockRejectedValueOnce(new Error('redis down'));

    // The caller has already applied the commit and cannot un-apply it; a
    // bookkeeping failure answering an accepted commit with 500 would send the
    // client into a retry against the epoch its own commit produced.
    await expect(publishKeyNeeded(['alice'], TOPIC, 1)).resolves.toBeUndefined();
  });
});

describe('which devices are reachable', () => {
  it('CONTRACT: opening a stream marks that device, and refreshes the object TTL', async () => {
    await markUserStreamOpen('alice', 'phone');

    expect(redisMock.hset).toHaveBeenCalledWith(
      expect.stringContaining('alice'),
      'phone',
      expect.any(String),
    );
    expect(redisMock.expire).toHaveBeenCalled();
  });

  it('RACE: the TTL outlives the 30s heartbeat, so a slow tick is not a disconnect', () => {
    // A marker that expired between beats would push a device whose app is open
    // and idle — a notification for something it is already handling.
    expect(SSE_PRESENCE_TTL_SECONDS).toBeGreaterThan(60);
  });

  it('CONTRACT: closing drops only that device', async () => {
    await markUserStreamClosed('alice', 'phone');
    expect(redisMock.hdel).toHaveBeenCalledWith(expect.stringContaining('alice'), 'phone');
  });

  it('RACE: an expired marker stops counting on the next read', async () => {
    redisMock.hgetall.mockResolvedValueOnce({
      phone: String(Date.now() - 1),
      laptop: FUTURE(),
    });

    const set = await streamingHandles('alice');
    expect(set.has('phone'), 'a device that stopped beating still counted').toBe(false);
    expect(set.has('laptop')).toBe(true);
  });

  it('HOSTILE: a junk expiry is treated as absent, never as forever', async () => {
    redisMock.hgetall.mockResolvedValueOnce({ phone: 'not-a-number', tablet: '' });

    expect(await streamingHandles('alice')).toEqual(new Set());
  });

  it('EMPTY: an account with no presence hash yields an empty set', async () => {
    redisMock.hgetall.mockResolvedValueOnce({} as Record<string, string>);
    expect(await streamingHandles('alice')).toEqual(new Set());
  });
});
