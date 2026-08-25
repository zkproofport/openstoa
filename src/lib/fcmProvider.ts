/**
 * Android push, sent straight to FCM as a DATA message.
 *
 * WHY NOT EXPO, for Android. Design §13.2.1 says Android must receive an "FCM
 * data message (암호문) — data message는 앱이 처리, Google이 내용 못 봄". Through
 * Expo's push service it does not: measured on a device, the message arrives as
 * an FCM *notification* message, so Firebase displays it itself and the app is
 * never asked. `expo-notifications`' `FirebaseMessagingDelegate.onMessageReceived`
 * does not log a single line even in a debug build, where its `DebugLogging`
 * fires unconditionally.
 *
 * Two features die there, and both are already written:
 *
 *   - `OpenStoaMessagingService` decrypts the archived copy and rewrites the
 *     body, which is the Android half of the lock-screen preview (§13.6). It
 *     cannot run if it is never called.
 *   - A notification Firebase built carries none of the extras
 *     `expo-notifications` stamps, so `getPresentedNotificationsAsync()` hands
 *     back a row with no topic on it and the app cannot dismiss the right ones
 *     when a room is opened.
 *
 * Sending the data message ourselves puts both back: FCM hands a data-only
 * message to the app in every state except force-stopped, our service decrypts
 * and delegates, and `expo-notifications` builds — and therefore owns — the
 * notification.
 *
 * PRIVACY. This is a net improvement, not a trade. Today the payload passes
 * through Expo's servers as well as Google's; sending direct removes one party
 * that sees the token, the timing and the size — the metadata §13.3 admits we
 * cannot hide from the transport, and which we were handing to two transports.
 * And because a data message has no `notification` block at all, the fixed
 * `title`/`body` strings Google could read today stop being sent.
 *
 * iOS is untouched and stays on Expo. It works there, Expo holds the APNs key,
 * and signing our own APNs JWTs would put a working platform at risk for no
 * present gain.
 */
import { logger } from '@/lib/logger';
import { apiFetch } from '@/lib/apiFetch';
import type { PushProvider, PushTarget, DummyPushPayload, CiphertextPushPayload } from '@/lib/push';

const ROUTE = 'fcm-provider';

/** Google's OAuth2 token endpoint, for the service-account assertion. */
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * The Android notification channel the app declares at push registration.
 *
 * Named here as well as in the payload so a channel rename cannot silently
 * half-apply: `expo-notifications` reads it off the data message when it builds
 * the notification, and a channel that does not exist puts the notification
 * back on Firebase's fallback — which is exactly the state this file exists to
 * leave behind.
 */
const CHAT_CHANNEL_ID = 'chat';

/** Refresh the access token this long before it actually expires. */
const TOKEN_SKEW_MS = 60_000;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

/**
 * Parse `FCM_SERVICE_ACCOUNT` once, and say plainly when it is unusable.
 *
 * BASE64 IS THE EXPECTED FORM, and the reason is not neatness. The raw
 * service-account JSON contains spaces and newlines, and the deploy passes env
 * vars to `gcloud run deploy --set-env-vars`; the first space ended the value
 * and gcloud read the rest of the private key as positional arguments, which
 * failed the deploy AND printed the key into the CI log. That key has been
 * revoked. Base64 has no character that any shell, delimiter or YAML layer
 * treats specially, so the problem cannot recur.
 *
 * Raw JSON is still accepted, for a local `.env` where nothing re-quotes it.
 *
 * No fallback and no default: a malformed credential must disable Android push
 * loudly rather than half-send. CLAUDE.md forbids the alternative.
 */
function readServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw) return null;
  const decoded = raw.trim().startsWith('{')
    ? raw
    : Buffer.from(raw, 'base64').toString('utf8');
  try {
    const parsed = JSON.parse(decoded) as Partial<ServiceAccount>;
    if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
      logger.warn(ROUTE, 'service account missing required fields', {
        hasEmail: !!parsed.client_email,
        hasKey: !!parsed.private_key,
        hasProject: !!parsed.project_id,
      });
      return null;
    }
    return parsed as ServiceAccount;
  } catch {
    logger.warn(ROUTE, 'service account is not valid JSON', {});
    return null;
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Mint a Google access token from the service account.
 *
 * A self-signed JWT exchanged at the token endpoint — the documented flow for a
 * server that holds a service-account key. Node's `crypto` signs it; no SDK, so
 * nothing else ships into the runtime for one RS256 signature.
 */
async function mintAccessToken(sa: ServiceAccount): Promise<{ token: string; expiresAt: number }> {
  const { createSign } = await import('node:crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(sa.private_key, 'base64url');
  const assertion = `${header}.${claims}.${signature}`;

  /*
   * The one call here that is NOT per-target: every android send waits on this
   * token. Without a deadline a slow answer from Google stalls the whole
   * dispatch batch rather than the one message it was refreshing for, which is
   * why this is the site that most needed one.
   */
  const res = await apiFetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`token endpoint ${res.status}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('token endpoint returned no access_token');
  return {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - TOKEN_SKEW_MS,
  };
}

/**
 * FCM V1 sender for Android devices.
 *
 * Every value in an FCM data payload must be a STRING — the wire format has no
 * other type — so anything structured is JSON-encoded on the way out and the
 * app parses it back. `tag` is included because `expo-notifications` uses
 * `data["tag"]` as the notification's identifier
 * (`FirebaseMessagingDelegate.getNotificationIdentifier`), which is what makes
 * `dismissNotificationAsync(topicId)` able to clear one room's notifications
 * without enumerating anything.
 */
export class FcmPushProvider implements PushProvider {
  private cached: { token: string; expiresAt: number } | null = null;

  /**
   * @param onDeadToken Called with a token FCM says it will never accept. This
   * class does not know about the database — the caller supplies the removal —
   * but something must act on the answer: without it a dead row is retried on
   * every fan-out forever, which is what staging was doing.
   */
  constructor(
    private readonly serviceAccount: ServiceAccount,
    private readonly onDeadToken?: (pushToken: string) => void,
  ) {}

  async send(target: PushTarget, payload: DummyPushPayload): Promise<void> {
    await this.post(target, {
      title: payload.title,
      message: payload.body,
      ...serialiseData(payload.data),
    });
  }

  async sendCiphertext(target: PushTarget, payload: CiphertextPushPayload): Promise<void> {
    await this.post(target, {
      title: payload.title,
      message: payload.body,
      ...serialiseData(payload.data),
    });
  }

  private async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.token;
    this.cached = await mintAccessToken(this.serviceAccount);
    return this.cached.token;
  }

  /**
   * One data-only message. Never throws: a chat message must not fail because a
   * notification could not be delivered.
   */
  private async post(target: PushTarget, data: Record<string, string>): Promise<void> {
    // The channel rides in `data` — see the note on `android` below for why it
    // cannot ride in `android.notification`.
    data.channelId = CHAT_CHANNEL_ID;
    try {
      const token = await this.accessToken();
      const url = `https://fcm.googleapis.com/v1/projects/${this.serviceAccount.project_id}/messages:send`;
      const res = await apiFetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: target.pushToken,
            // NO `notification` block. That is the whole point: with one, FCM
            // displays the message itself and the app never sees it.
            data,
            /*
             * `priority` and NOTHING ELSE under `android`.
             *
             * `android.notification` is a notification block, whatever it
             * carries. Firebase's own table is explicit: in the background a
             * message with one goes to the system tray and `onMessageReceived`
             * is never called, while a data-only message is handed to the app.
             * Setting `channel_id` there — which is only how the CHANNEL is
             * named — was enough to turn this back into the exact message shape
             * the whole file exists to stop sending, and it was measured doing
             * so: the tray showed `tag=FCM-Notification:...` and the app logged
             * nothing.
             *
             * The channel travels in `data` instead, where
             * `expo-notifications` reads it when IT builds the notification.
             */
            android: { priority: 'HIGH' },
          },
        }),
      });
      if (!res.ok) {
        // Never the token, never the payload — only what went wrong.
        const detail = await res.text().catch(() => '');
        const error = extractFcmError(detail);
        logger.warn(ROUTE, 'fcm send failed', { status: res.status, error });
        /*
         * TERMINAL, so stop carrying the row.
         *
         * `UNREGISTERED` is an uninstalled app or cleared data; an
         * `INVALID_ARGUMENT` naming `message.token` is a value FCM will never
         * accept. Neither is retryable, and leaving the row meant every later
         * fan-out bought the same refusal — measured on staging, the same row
         * id rejected on every send while the user's device showed as
         * registered. An `INVALID_ARGUMENT` about any OTHER field is OUR bug in
         * the payload and must not cost the user their registration.
         */
        if (isDeadToken(error, detail)) {
          logger.info(ROUTE, 'dropping a token fcm will not accept', { error });
          this.onDeadToken?.(target.pushToken);
        }
        return;
      }
      logger.info(ROUTE, 'fcm data message sent', { platform: target.platform });
    } catch (err) {
      logger.warn(ROUTE, 'fcm send threw', { err: String(err) });
    }
  }
}

/**
 * Whether FCM's answer means this token is finished.
 *
 * Deliberately narrow. `UNREGISTERED` and `SENDER_ID_MISMATCH` are about the
 * token itself. `INVALID_ARGUMENT` is not — it is also what a malformed payload
 * returns — so it only counts when the violation names `message.token`, which
 * is the difference between dropping a dead registration and dropping a live
 * one because we sent a bad field.
 */
export function isDeadToken(error: string, body: string): boolean {
  if (error === 'UNREGISTERED' || error === 'SENDER_ID_MISMATCH') return true;
  if (error !== 'INVALID_ARGUMENT') return false;
  return /"field"\s*:\s*"message\.token"/.test(body);
}

/**
 * FCM's error name, and nothing else.
 *
 * The body can echo the registration token back, so it is never logged whole —
 * `UNREGISTERED`, `INVALID_ARGUMENT` and friends are the part worth having.
 */
export function extractFcmError(body: string): string {
  const match = /"status"\s*:\s*"([A-Z_]+)"/.exec(body) ?? /"message"\s*:\s*"([^"]{0,80})"/.exec(body);
  return match?.[1] ?? 'unknown';
}

/**
 * Flatten a payload's `data` into FCM's string-only map.
 *
 * `tag` is set from `topicId` deliberately: `expo-notifications` reads
 * `data["tag"]` as the notification identifier, so this is what lets the app
 * dismiss one room's notifications by name. Without it the identifier falls
 * back to the FCM message id and the room has no way to name its own.
 */
export function serialiseData(data: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  const topicId = out.topicId;
  if (topicId) out.tag = topicId;
  return out;
}

/**
 * The Android sender, or null when this deployment has no FCM credential.
 *
 * Null is a real answer: without it Android falls back to the Expo path, which
 * delivers but cannot be dismissed. Degraded, not broken — and the caller logs
 * which one it took.
 */
export function getFcmProvider(
  onDeadToken?: (pushToken: string) => void,
): FcmPushProvider | null {
  const sa = readServiceAccount(process.env.FCM_SERVICE_ACCOUNT);
  return sa ? new FcmPushProvider(sa, onDeadToken) : null;
}
