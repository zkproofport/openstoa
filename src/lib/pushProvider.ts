/**
 * Real Expo Push provider adapter (design §13). This is the thin, swappable edge
 * behind the `PushProvider` interface in `push.ts`: a single HTTP endpoint
 * (`https://exp.host/--/api/v2/push/send`) fronts BOTH iOS APNs and Android FCM
 * via Expo push tokens, so one adapter covers every device. APNs/FCM credentials
 * are configured in the Expo project (a device/creds step), NOT in code.
 *
 * SI-1 for push is preserved here: the content-free `send` carries zero message
 * content, and `sendCiphertext` carries only the ALREADY-SEALED opaque `ct` (the
 * server never had the plaintext). `ct`/tokens are NEVER logged — only counts and
 * Expo ticket statuses.
 *
 * Robustness: every HTTP failure is swallowed (fire-and-forget) so a push send can
 * never break the chat POST's 200. Push is OFF unless `PUSH_MODE` is set; a
 * `PUSH_DISABLED` flag force-disables it. When disabled, `getPushProvider()`
 * returns null and dispatch is a clean no-op (NOT a hardcoded fake — CLAUDE.md).
 */
import type {
  PushProvider,
  PushTarget,
  DummyPushPayload,
  CiphertextPushPayload,
  KeyNeededPushPayload,
} from '@/lib/push';
import { logger } from '@/lib/logger';
import { getFcmProvider } from '@/lib/fcmProvider';

const ROUTE = 'push-provider';

/** The one well-known Expo push endpoint (not a secret, not env-configurable). */
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/**
 * The Android channel the app declares at push registration.
 *
 * Ignored by iOS. On Android it is what keeps Firebase from displaying the
 * message itself: a Firebase-built notification carries none of the extras
 * expo-notifications stamps, so `getPresentedNotificationsAsync()` returns an
 * empty list for it and the app can never dismiss it when the room is opened.
 * The app names the same string in `pushClearing.ts` (`CHAT_CHANNEL_ID`), and
 * a disagreement between the two is silent — the notification simply lands on
 * the fallback channel again and the tray stops clearing.
 */
const CHAT_CHANNEL_ID = 'chat';
/** Where an accepted ticket's real outcome shows up. */
const EXPO_RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts';
/** Expo's documented cap for one getReceipts call. */
const EXPO_RECEIPT_MAX = 1000;
/**
 * How long to leave a ticket before asking about it.
 *
 * Expo answers `pending` for a receipt it has not resolved yet, and a pending
 * answer teaches nothing. Long enough that the common case has settled, short
 * enough to stay inside the request the push was sent from.
 */
const RECEIPT_DELAY_MS = 5_000;

/** Expo accepts up to 100 message objects per POST — we chunk to respect it. */
export const EXPO_BATCH_MAX = 100;

/** Shape of a single Expo push message object (only the fields we send). */
interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  /**
   * Android: the channel expo-notifications must deliver this on.
   *
   * Without it Firebase displays the message itself on its own fallback
   * channel, and a Firebase-built notification carries none of the extras expo
   * stamps — so `getPresentedNotificationsAsync()` cannot see it and the app
   * cannot dismiss it when the user opens the room. Ignored by iOS.
   */
  channelId?: string;
  /** Android: 'high' delivers the data message immediately. */
  priority?: 'default' | 'normal' | 'high';
  /** iOS: sets APNs `mutable-content=1` so the NSE wakes to decrypt + rewrite. */
  mutableContent?: boolean;
  /** iOS: starts the app in the background (content-available) for the handler. */
  _contentAvailable?: boolean;
}

/**
 * Split an array into chunks of at most `size`. Pure + exported so the ≤100
 * batching contract is unit-testable without a live Expo endpoint.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Expo push adapter. `send` delivers the content-free dummy; `sendCiphertext`
 * delivers the Phase B ciphertext-bearing payload (design §13.5). Both funnel
 * through `postMessages`, which chunks to `EXPO_BATCH_MAX` and swallows errors.
 * The Expo access token is OPTIONAL — Expo allows unauthenticated sends for
 * projects that have not enabled enhanced security, so the `Authorization` header
 * is attached only when `EXPO_ACCESS_TOKEN` is present.
 */
export class ExpoPushProvider implements PushProvider {
  constructor(private readonly accessToken?: string) {}

  async send(target: PushTarget, payload: DummyPushPayload): Promise<void> {
    // Content-free: exactly {to, title, body, data:{topicId}} — no ct, no plaintext.
    await this.postMessages([
      {
        to: target.pushToken,
        title: payload.title,
        body: payload.body,
        data: payload.data,
        channelId: CHAT_CHANNEL_ID,
      },
    ]);
  }

  async sendCiphertext(target: PushTarget, payload: CiphertextPushPayload): Promise<void> {
    // Phase B (design §13.5): placeholder title/body + the opaque ct in `data`.
    // `mutableContent` wakes the iOS NSE; `_contentAvailable` + `priority:'high'`
    // drive the Android/iOS background handler for the on-device decrypt path.
    await this.postMessages([
      {
        to: target.pushToken,
        title: payload.title,
        body: payload.body,
        data: payload.data,
        channelId: CHAT_CHANNEL_ID,
        mutableContent: true,
        _contentAvailable: true,
        priority: 'high',
      },
    ]);
  }

  /**
   * POST one or more Expo messages, chunked to `EXPO_BATCH_MAX`. Fire-and-forget:
   * every network/HTTP failure is caught and logged (counts + ticket status only),
   * so a bad token or a down Expo endpoint can never throw into the chat path.
   */
  private async postMessages(messages: ExpoMessage[]): Promise<void> {
    for (const batch of chunk(messages, EXPO_BATCH_MAX)) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };
        if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

        const res = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify(batch),
        });

        if (!res.ok) {
          // Never log tokens/ct — only the count and HTTP status.
          logger.warn(ROUTE, 'expo push batch http error', {
            count: batch.length,
            status: res.status,
          });
          continue;
        }

        /*
         * Summarise the tickets, AND NAME THE FAILURES.
         *
         * This used to count `ok` and `error` and throw the rest away, which
         * made every push failure look identical in the log. Android delivery
         * was dead for a day behind `{ok:0,error:1}`, and the reason — Expo
         * holding no FCM credential for this app after the package rename —
         * only came out by hand-POSTing to Expo and reading the reply. That is
         * a diagnosis the log should have handed over.
         *
         * `details.error` is an enum from Expo (`InvalidCredentials`,
         * `DeviceNotRegistered`, `MessageTooBig`, `MessageRateExceeded`) and
         * `message` is its prose. NEITHER contains a token, a user, or any part
         * of the message — the ticket does not carry them — so this stays
         * inside the same rule the counts already obeyed.
         */
        const json = (await res.json().catch(() => null)) as {
          data?: Array<{
            status?: string;
            id?: string;
            message?: string;
            details?: { error?: string };
          }>;
        } | null;
        const tickets = Array.isArray(json?.data) ? json!.data : [];
        let ok = 0;
        const reasons: string[] = [];
        const receiptIds: string[] = [];
        for (const t of tickets) {
          if (t?.status === 'ok') {
            ok++;
            if (t.id) receiptIds.push(t.id);
            continue;
          }
          reasons.push(t?.details?.error ?? t?.message ?? 'unknown');
        }
        if (reasons.length > 0) {
          logger.warn(ROUTE, 'expo push batch rejected', {
            count: batch.length,
            ok,
            error: reasons.length,
            reasons: [...new Set(reasons)].join(','),
          });
        } else {
          logger.info(ROUTE, 'expo push batch sent', { count: batch.length, ok, error: 0 });
        }
        /*
         * An accepted ticket is a QUEUED message, not a delivered one. Expo
         * hands the real outcome back through a receipt, and everything that
         * goes wrong between Expo and FCM/APNs — an expired credential, a token
         * the device has since dropped — appears ONLY there. Without this the
         * server can watch every push it sends succeed while no phone rings.
         */
        void this.reportReceipts(receiptIds);
      } catch (err) {
        logger.warn(ROUTE, 'expo push batch failed', {
          count: batch.length,
          err: String(err),
        });
      }
    }
  }

  /**
   * Ask Expo what actually happened to the messages it accepted.
   *
   * Deliberately fire-and-forget and deliberately unawaited by the caller: a
   * receipt is diagnostics, and a chat message must not wait on it or fail
   * because of it. Receipts are not ready the instant a ticket is issued, so a
   * `pending` answer is normal and is not logged — only an error is.
   */
  private async reportReceipts(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await new Promise((r) => setTimeout(r, RECEIPT_DELAY_MS));
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

      for (const group of chunk(ids, EXPO_RECEIPT_MAX)) {
        const res = await fetch(EXPO_RECEIPT_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ids: group }),
        });
        if (!res.ok) continue;
        const json = (await res.json().catch(() => null)) as {
          data?: Record<string, { status?: string; message?: string; details?: { error?: string } }>;
        } | null;
        const reasons: string[] = [];
        for (const receipt of Object.values(json?.data ?? {})) {
          if (!receipt || receipt.status === 'ok') continue;
          reasons.push(receipt.details?.error ?? receipt.message ?? 'unknown');
        }
        if (reasons.length > 0) {
          logger.warn(ROUTE, 'expo push undelivered', {
            count: group.length,
            failed: reasons.length,
            reasons: [...new Set(reasons)].join(','),
          });
        }
      }
    } catch (err) {
      logger.warn(ROUTE, 'expo push receipt check failed', { err: String(err) });
    }
  }
}

/**
 * Resolve the configured push provider, or null when push is disabled. Push is
 * OFF by default (safe): it turns on only when `PUSH_MODE` is set (to
 * `content-free` or `ciphertext`), and a `PUSH_DISABLED` flag force-disables it
 * even if `PUSH_MODE` is set. Returning null (not a fake) keeps dispatch a clean
 * no-op — CLAUDE.md: no hardcoded fallbacks. `EXPO_ACCESS_TOKEN` is optional.
 */
export function getPushProvider(): PushProvider | null {
  const disabled = process.env.PUSH_DISABLED;
  if (disabled === '1' || disabled === 'true') return null;
  if (!process.env.PUSH_MODE) return null;
  const expo = new ExpoPushProvider(process.env.EXPO_ACCESS_TOKEN);
  /*
   * The removal is injected rather than imported into `fcmProvider`, which
   * knows about a wire format and nothing else. Fire-and-forget and swallowed:
   * a chat message must not fail because a dead registration could not be
   * tidied away, and the next send simply tries again.
   */
  const fcm = getFcmProvider((pushToken) => {
    void (async () => {
      try {
        const { db } = await import('@/lib/db');
        const { deleteTokenByValue } = await import('@/lib/pushStore');
        const removed = await deleteTokenByValue(db, pushToken);
        if (removed > 0) logger.info(ROUTE, 'removed a dead push token', { removed });
      } catch (err) {
        logger.warn(ROUTE, 'could not remove a dead push token', { err: String(err) });
      }
    })();
  });
  return fcm ? new PlatformSplitProvider(expo, fcm) : expo;
}

/**
 * iOS through Expo, Android straight to FCM.
 *
 * Not a preference — a correctness split. Design §13.2.1 requires Android to
 * receive a DATA message so the app handles it; through Expo's push service it
 * receives a notification message instead and Firebase displays it before the
 * app is asked. That kills the lock-screen preview (`OpenStoaMessagingService`
 * never runs) and per-room dismissal (a Firebase-built notification carries
 * none of the extras `expo-notifications` stamps).
 *
 * iOS is left alone: it works, Expo holds the APNs key, and it is the platform
 * with nothing to gain from the move.
 *
 * A device whose `platform` is neither goes to Expo, because that is what
 * shipped and an unrecognised platform is not a reason to drop a notification.
 */
export class PlatformSplitProvider implements PushProvider {
  constructor(
    private readonly ios: PushProvider,
    private readonly android: PushProvider,
  ) {}

  private pick(target: PushTarget): PushProvider {
    return target.platform === 'android' ? this.android : this.ios;
  }

  send(target: PushTarget, payload: DummyPushPayload | KeyNeededPushPayload): Promise<void> {
    return this.pick(target).send(target, payload);
  }

  /**
   * Optional on the interface, so a provider that does not implement it must
   * not become a crash — the Phase A path still delivers.
   */
  sendCiphertext(target: PushTarget, payload: CiphertextPushPayload): Promise<void> {
    const provider = this.pick(target);
    return provider.sendCiphertext
      ? provider.sendCiphertext(target, payload)
      : Promise.resolve();
  }
}
