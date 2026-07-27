/**
 * Push notifications — content-free (Phase A) + ciphertext (Phase B) dispatch
 * (design §13, D12/D13/D14, §13.4/§13.5). When a chat message is published the
 * server fires a push to every other member's device.
 *
 * Phase A (content-free): a constant "New message" with NO plaintext, NO
 * ciphertext, NO sender identity, NO topic title — only the topic id so the tap
 * handler can deep-link. The recipient then fetches `GET /chat?since=` and
 * decrypts locally.
 *
 * Phase B (ciphertext, design §13.5): the push additionally carries the OPAQUE
 * sealed ciphertext already stored for the message (the server NEVER decrypts —
 * the bytes are already E2EE), with `mutableContent` (iOS) / data-only
 * (Android) so an on-device NSE / FCM data handler can decrypt with the local
 * MLS keys and rewrite the lockscreen preview. If the encoded payload would
 * exceed the APNs ~4KB budget (`PUSH_MAX_PAYLOAD_BYTES`), the ciphertext is
 * DROPPED and the Phase A content-free dummy is sent instead so large messages
 * still notify. SI-1 for push is preserved in BOTH phases: Phase A carries no
 * content at all, and Phase B carries only the already-sealed ciphertext (the
 * server has no plaintext to leak). `ct` is never logged.
 *
 * The provider is an interface so tests inject a fake and the real Expo/APNs/FCM
 * adapter stays a thin, swappable edge. If no provider is configured (creds
 * absent) dispatch is a graceful no-op — the chat POST still returns 200.
 */
import { getTopicMemberTokens, type MemberPushTarget } from '@/lib/pushStore';
import { logger } from '@/lib/logger';

const ROUTE = 'push';

interface SqlExecutor {
  execute(query: unknown): Promise<unknown>;
}

/**
 * The ONLY payload shape the server ever sends. `data.topicId` is the sole
 * message-linked field — it lets the tapped app open the right topic. There is
 * deliberately no field for body text, sender, or ciphertext (SI-1 for push).
 */
export interface DummyPushPayload {
  title: string;
  body: string;
  data: { topicId: string };
}

/**
 * Phase B payload (design §13.5). Carries the message's OPAQUE sealed ciphertext
 * (`data.ct`, base64) so an on-device NSE / FCM data handler can decrypt with the
 * local MLS keys and preview on the lockscreen. `title`/`body` are the pre-decrypt
 * PLACEHOLDERS the NSE overwrites — identical to the Phase A dummy so a device
 * that can't decrypt still shows a content-free "New message". `mutableContent`
 * flips APNs `aps.mutable-content=1` (wakes the iOS NSE); `dataOnly` marks the
 * Android message as data-only (handled by the background FCM handler). SI-1:
 * `ct` is already-sealed bytes — the server never had the plaintext.
 */
export interface CiphertextPushPayload {
  title: string;
  body: string;
  data: { topicId: string; messageId: string; epoch: number; ct: string };
  /** iOS: set APNs `aps.mutable-content=1` so the NSE is invoked. */
  mutableContent: true;
  /** Android: deliver as a data-only message for the background handler. */
  dataOnly: true;
}

export interface PushTarget {
  pushToken: string;
  platform: 'ios' | 'android';
}

export interface PushProvider {
  /** Deliver one content-free payload to one device (Phase A). */
  send(target: PushTarget, payload: DummyPushPayload): Promise<void>;
  /**
   * Deliver one ciphertext-bearing payload to one device (Phase B). Optional:
   * a provider that can't carry `mutableContent`/data-only omits it, and the
   * dispatcher transparently falls back to the content-free `send`.
   */
  sendCiphertext?(target: PushTarget, payload: CiphertextPushPayload): Promise<void>;
}

/**
 * Encoded-payload budget (design §13.5). APNs caps a notification at ~4KB; we
 * stay under 4096 with headroom for APNs/FCM envelope framing the server can't
 * see. A Phase B payload whose JSON exceeds this drops the ciphertext and falls
 * back to the Phase A dummy so the recipient still gets a "New message".
 */
export const PUSH_MAX_PAYLOAD_BYTES = 3584;

/** Push delivery mode (design §13.4 vs §13.5). Default: content-free (Phase A). */
export type PushMode = 'content-free' | 'ciphertext';

/**
 * Resolve the push mode from `PUSH_MODE`. Anything other than the exact string
 * `ciphertext` (incl. unset) means content-free — Phase A is the safe default,
 * so a typo never silently starts shipping ciphertext in pushes.
 */
export function getPushMode(): PushMode {
  return process.env.PUSH_MODE === 'ciphertext' ? 'ciphertext' : 'content-free';
}

/** The fixed content-free payload for a topic. No message content, ever. */
export function buildDummyPayload(topicId: string): DummyPushPayload {
  return { title: 'OpenStoa', body: 'New message', data: { topicId } };
}

export interface CiphertextDispatchInput {
  topicId: string;
  senderUserId: string;
  messageId: string;
  /** Base64 of the ALREADY-SEALED ciphertext (same opaque bytes stored). */
  sealedCiphertextB64: string;
  epoch: number;
}

/** UTF-8 byte length of the JSON-encoded payload (what actually crosses the wire). */
function encodedSize(payload: CiphertextPushPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/**
 * Build the Phase B ciphertext payload, or return null to signal "fall back to
 * the Phase A dummy". Null is returned for hostile/degenerate input (missing or
 * empty ct, missing messageId, or a non-integer/negative epoch) AND when the
 * encoded payload exceeds `PUSH_MAX_PAYLOAD_BYTES` (size-cap → dummy). `ct` is
 * copied verbatim — the server never decodes or inspects it (SI-1).
 */
export function buildCiphertextPayload(
  input: Pick<CiphertextDispatchInput, 'topicId' | 'messageId' | 'sealedCiphertextB64' | 'epoch'>,
): CiphertextPushPayload | null {
  const { topicId, messageId, sealedCiphertextB64, epoch } = input;
  if (typeof sealedCiphertextB64 !== 'string' || sealedCiphertextB64.length === 0) return null;
  if (typeof messageId !== 'string' || messageId.length === 0) return null;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) return null;
  const payload: CiphertextPushPayload = {
    title: 'OpenStoa',
    body: 'New message',
    data: { topicId, messageId, epoch, ct: sealedCiphertextB64 },
    mutableContent: true,
    dataOnly: true,
  };
  if (encodedSize(payload) > PUSH_MAX_PAYLOAD_BYTES) return null;
  return payload;
}

/**
 * Look up the topic's members (EXCLUDING the sender and any non-member) and ask
 * the provider to send a content-free dummy to each device. Per-device send
 * failures are swallowed so one bad token can't abort the fan-out; a null/absent
 * provider is a clean no-op (push disabled). This is invoked fire-and-forget
 * from the chat POST route and must never throw back into the request path.
 */
export async function dispatchDummyForMessage(
  db: SqlExecutor,
  topicId: string,
  senderUserId: string,
  provider: PushProvider | null,
): Promise<void> {
  if (!provider) {
    logger.info(ROUTE, 'push disabled (no provider configured) — skipping dispatch', { topicId });
    return;
  }
  const targets: MemberPushTarget[] = await getTopicMemberTokens(
    db as Parameters<typeof getTopicMemberTokens>[0],
    topicId,
    senderUserId,
  );
  if (targets.length === 0) return;

  const payload = buildDummyPayload(topicId);
  await Promise.all(
    targets.map((t) =>
      provider
        .send({ pushToken: t.pushToken, platform: t.platform }, payload)
        .catch((err) =>
          logger.warn(ROUTE, 'push send failed for one device', {
            topicId,
            platform: t.platform,
            err: String(err),
          }),
        ),
    ),
  );
}

/**
 * Phase B fan-out (design §13.5). Same member set as the Phase A dummy (topic
 * members EXCLUDING the sender + all non-members — reuses getTopicMemberTokens),
 * but each device gets the ciphertext-bearing payload so its NSE / FCM handler
 * can preview on the lockscreen. Per device the choice is:
 *   - ciphertext payload  → when it's within the size budget AND the provider
 *                           can carry it (`sendCiphertext`),
 *   - content-free dummy  → otherwise (over budget, hostile/missing ct/epoch,
 *                           or a provider without ciphertext support).
 * Per-device failures are swallowed; a null provider is a clean no-op. Invoked
 * fire-and-forget from the chat POST — must never throw into the request path.
 * SI-1: only the opaque `ct` (already-sealed bytes) leaves the server; `ct` is
 * never logged.
 */
export async function dispatchCiphertextForMessage(
  db: SqlExecutor,
  input: CiphertextDispatchInput,
  provider: PushProvider | null,
): Promise<void> {
  const { topicId, senderUserId } = input;
  if (!provider) {
    logger.info(ROUTE, 'push disabled (no provider configured) — skipping dispatch', { topicId });
    return;
  }
  const targets: MemberPushTarget[] = await getTopicMemberTokens(
    db as Parameters<typeof getTopicMemberTokens>[0],
    topicId,
    senderUserId,
  );
  if (targets.length === 0) return;

  const ctPayload = buildCiphertextPayload(input);
  const dummy = buildDummyPayload(topicId);
  await Promise.all(
    targets.map((t) => {
      const target: PushTarget = { pushToken: t.pushToken, platform: t.platform };
      const send =
        ctPayload && provider.sendCiphertext
          ? provider.sendCiphertext(target, ctPayload)
          : provider.send(target, dummy);
      return send.catch((err) =>
        logger.warn(ROUTE, 'push send failed for one device', {
          topicId,
          platform: t.platform,
          mode: ctPayload && provider.sendCiphertext ? 'ciphertext' : 'content-free',
          err: String(err),
        }),
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Real Expo adapter (thin edge). Content-free by construction.
// ---------------------------------------------------------------------------

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Expo push adapter. Sends ONLY the content-free dummy — it never receives or
 * forwards message content. Credentials come from `EXPO_ACCESS_TOKEN`.
 */
class ExpoPushProvider implements PushProvider {
  constructor(private readonly accessToken: string) {}
  async send(target: PushTarget, payload: DummyPushPayload): Promise<void> {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      // Expo accepts ios/android Expo push tokens on the same endpoint. Only the
      // dummy title/body + topicId leave the server — no content.
      body: JSON.stringify({
        to: target.pushToken,
        title: payload.title,
        body: payload.body,
        data: payload.data,
      }),
    });
    if (!res.ok) {
      throw new Error(`Expo push failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
  }

  /**
   * Phase B (design §13.5). Sends the placeholder title/body plus the opaque
   * ciphertext in `data.ct`, with `mutableContent` so APNs sets
   * `aps.mutable-content=1` and the iOS NSE wakes to decrypt + rewrite the
   * preview. Only the already-sealed `ct` leaves the server (SI-1) — never
   * logged, never decoded here. Expo's HTTP API does not expose true Android
   * data-only delivery, so the Android background decrypt path lives in the
   * native FCM handler (proofport-app scaffold); on Expo/Android this still
   * delivers the ciphertext in `data` for the handler to consume.
   */
  async sendCiphertext(target: PushTarget, payload: CiphertextPushPayload): Promise<void> {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({
        to: target.pushToken,
        title: payload.title,
        body: payload.body,
        data: payload.data,
        mutableContent: payload.mutableContent,
        priority: 'high',
      }),
    });
    if (!res.ok) {
      throw new Error(`Expo push failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
  }
}

/**
 * Resolve the configured push provider, or null when push is not configured.
 * NOT a hardcoded fallback (CLAUDE.md): when `EXPO_ACCESS_TOKEN` is absent we
 * return null and dispatch no-ops — push is simply disabled, not faked.
 */
export function getPushProvider(): PushProvider | null {
  const token = process.env.EXPO_ACCESS_TOKEN;
  if (!token) return null;
  return new ExpoPushProvider(token);
}
