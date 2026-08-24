/**
 * Which transport a push takes, and why the token decides it.
 *
 * THE DEFECT. Android is meant to go straight to FCM as a data message — that
 * is the only way `expo-notifications` builds the notification, and therefore
 * the only way the app can dismiss one room's notifications when that room is
 * opened. But the Android client asks for a raw FCM token and DELIBERATELY
 * falls back to the Expo one when the device cannot produce it, on the grounds
 * that "a push that arrives and cannot be dismissed is still better than no
 * push". That fallback was invisible to the router: the device registered as
 * `android`, every send went to FCM, and FCM answered `INVALID_ARGUMENT` on
 * `message.token` — forever, because nothing acted on that answer either.
 *
 * Observed on staging: `fcm send failed {"status":400,"error":
 * "INVALID_ARGUMENT"}` on every dispatch, beside a `push token registered`
 * line reporting `platform: "android"`.
 *
 * EDGE-CASE MATRIX → coverage
 *   contract   → a raw token on android goes to FCM; an Expo token never does
 *   contract   → iOS is untouched, whatever its token looks like
 *   integrity  → the ciphertext path routes the same way as the plain one
 *   boundary   → both Expo spellings, and a token that merely CONTAINS the word
 *   empty      → empty and whitespace tokens do not crash the router
 *   hostile    → a token that starts with the prefix but is otherwise junk
 *   external   → a provider without `sendCiphertext` is not a crash
 * N/A: authorization — the router has no caller identity; recipients are
 * resolved and filtered upstream in `pushStore`/`pushPrefs`.
 */
import { describe, it, expect, vi } from 'vitest';
import { PlatformSplitProvider, ExpoPushProvider, isExpoToken } from '@/lib/pushProvider';
import type { PushProvider, PushTarget } from '@/lib/push';

function spyProvider(name: string) {
  const sent: string[] = [];
  const provider: PushProvider = {
    send: vi.fn(async (t: PushTarget) => {
      sent.push(`send:${t.pushToken}`);
    }),
    sendCiphertext: vi.fn(async (t: PushTarget) => {
      sent.push(`cipher:${t.pushToken}`);
    }),
  };
  return { name, provider, sent };
}

const RAW_FCM =
  'dGhpcy1pcy1hLWZha2UtZmNtLXRva2VuOkFQQTkxYkZ3ZXJ0eXVpb3Bhc2RmZ2hqa2x6eGN2Ym5t';
const EXPO = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';
const EXPO_OLD = 'ExpoPushToken[yyyyyyyyyyyyyyyyyyyyyy]';

const payload = { title: 'x', body: 'y', data: { topicId: 't1' } } as never;

describe('CONTRACT: android goes to FCM unless the token says otherwise', () => {
  it('a raw token on android goes to FCM', async () => {
    const ios = spyProvider('ios');
    const fcm = spyProvider('fcm');
    const split = new PlatformSplitProvider(ios.provider, fcm.provider);

    await split.send({ pushToken: RAW_FCM, platform: 'android' }, payload);

    expect(fcm.sent).toEqual([`send:${RAW_FCM}`]);
    expect(ios.sent).toEqual([]);
  });

  it.each([
    ['current spelling', EXPO],
    ['older spelling', EXPO_OLD],
  ])('an Expo token on android goes to Expo, not FCM (%s)', async (_label, token) => {
    const ios = spyProvider('ios');
    const fcm = spyProvider('fcm');
    const split = new PlatformSplitProvider(ios.provider, fcm.provider);

    await split.send({ pushToken: token, platform: 'android' }, payload);

    // FCM cannot deliver this and never could — it answers INVALID_ARGUMENT on
    // message.token, which is precisely the staging failure this prevents.
    expect(fcm.sent, 'an Expo token was handed to FCM').toEqual([]);
    expect(ios.sent).toEqual([`send:${token}`]);
  });

  it('iOS is untouched, whatever the token looks like', async () => {
    const ios = spyProvider('ios');
    const fcm = spyProvider('fcm');
    const split = new PlatformSplitProvider(ios.provider, fcm.provider);

    await split.send({ pushToken: EXPO, platform: 'ios' }, payload);
    await split.send({ pushToken: RAW_FCM, platform: 'ios' }, payload);

    expect(fcm.sent).toEqual([]);
    expect(ios.sent).toEqual([`send:${EXPO}`, `send:${RAW_FCM}`]);
  });
});

describe('INTEGRITY: the ciphertext path routes identically', () => {
  it('an Expo token takes the Expo path for a sealed payload too', async () => {
    const ios = spyProvider('ios');
    const fcm = spyProvider('fcm');
    const split = new PlatformSplitProvider(ios.provider, fcm.provider);

    await split.sendCiphertext({ pushToken: EXPO, platform: 'android' }, payload);
    await split.sendCiphertext({ pushToken: RAW_FCM, platform: 'android' }, payload);

    expect(ios.sent).toEqual([`cipher:${EXPO}`]);
    expect(fcm.sent).toEqual([`cipher:${RAW_FCM}`]);
  });

  it('iOS REGRESSION: the real Expo provider still carries a sealed payload', async () => {
    /*
     * The split must not have cost iOS its lock-screen preview.
     *
     * `sendCiphertext` is OPTIONAL on the interface and the split calls it
     * conditionally, which is right — a provider that cannot seal must not
     * crash a chat message — and is also a place a regression can hide: losing
     * the implementation turns the preview off silently, and every case above
     * would still pass because they use spies that always have the method.
     *
     * So this one asserts against the REAL class: whatever the split does, an
     * iOS target must reach something that actually implements it.
     */
    const expo = new ExpoPushProvider(undefined);
    expect(
      typeof (expo as unknown as { sendCiphertext?: unknown }).sendCiphertext,
      'ExpoPushProvider lost sendCiphertext — iOS lock-screen previews are off',
    ).toBe('function');

    const fcm = spyProvider('fcm');
    const split = new PlatformSplitProvider(expo, fcm.provider);
    const calls: string[] = [];
    vi.spyOn(expo, 'sendCiphertext').mockImplementation(async (t) => {
      calls.push(t.pushToken);
    });

    await split.sendCiphertext({ pushToken: 'apns-token', platform: 'ios' }, payload);
    expect(calls, 'an iOS sealed payload never reached the Expo provider').toEqual(['apns-token']);
    expect(fcm.sent).toEqual([]);
  });

  it('EXTERNAL: a provider with no sendCiphertext is not a crash', async () => {
    const bare: PushProvider = { send: vi.fn(async () => {}) };
    const split = new PlatformSplitProvider(bare, bare);
    await expect(
      split.sendCiphertext({ pushToken: RAW_FCM, platform: 'android' }, payload),
    ).resolves.toBeUndefined();
  });
});

describe('isExpoToken on its own', () => {
  it.each([
    [EXPO, true],
    [EXPO_OLD, true],
    ['ExponentPushToken[]', true],
    [RAW_FCM, false],
    ['', false],
    ['   ', false],
    // Contains the word but is not one: matching loosely would send a real FCM
    // token to Expo, which fails in the opposite direction and just as silently.
    ['fcm-token-mentioning-ExponentPushToken[inside]', false],
    ['exponentpushtoken[lowercase]', false],
  ])('%s → %s', (token, expected) => {
    expect(isExpoToken(token)).toBe(expected);
  });

  it('EMPTY: a missing token does not throw', () => {
    expect(isExpoToken(undefined as unknown as string)).toBe(false);
  });
});
