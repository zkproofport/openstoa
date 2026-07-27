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
} from '@/lib/push';
import { logger } from '@/lib/logger';

const ROUTE = 'push-provider';

/** The one well-known Expo push endpoint (not a secret, not env-configurable). */
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Expo accepts up to 100 message objects per POST — we chunk to respect it. */
export const EXPO_BATCH_MAX = 100;

/** Shape of a single Expo push message object (only the fields we send). */
interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
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

        // Summarise Expo tickets by status ('ok' vs 'error') — never the tickets'
        // ids or any payload content.
        const json = (await res.json().catch(() => null)) as {
          data?: Array<{ status?: string }>;
        } | null;
        const tickets = Array.isArray(json?.data) ? json!.data : [];
        let ok = 0;
        let error = 0;
        for (const t of tickets) {
          if (t?.status === 'ok') ok++;
          else error++;
        }
        logger.info(ROUTE, 'expo push batch sent', { count: batch.length, ok, error });
      } catch (err) {
        logger.warn(ROUTE, 'expo push batch failed', {
          count: batch.length,
          err: String(err),
        });
      }
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
  return new ExpoPushProvider(process.env.EXPO_ACCESS_TOKEN);
}
