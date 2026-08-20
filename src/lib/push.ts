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
 * MLS keys and rewrite the lockscreen preview. When the sender also supplied a
 * TAK-sealed copy of the body (`pushArchive` on POST /chat) the payload carries
 * it as `act`/`tv` — that is what the iOS NSE actually decrypts (design §13.6
 * strategy A), since opening the live MLS `ct` would consume a forward-secret
 * ratchet key and desync the app. If the encoded payload would
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
  data: {
    topicId: string;
    messageId: string;
    epoch: number;
    ct: string;
    /**
     * OPTIONAL TAK-sealed copy of the same body (design §13.6 strategy A), sent
     * by the client as `pushArchive.ct` on POST /chat. The iOS NSE decrypts THIS
     * — not `ct` — because opening the live MLS ciphertext would consume a
     * forward-secret ratchet key and desync the app, while the Topic Archive Key
     * is stable and consumes nothing. Absent → the NSE leaves the placeholder.
     */
    act?: string;
    /** TAK version `act` was sealed under (0 = public archive root, else epoch). */
    tv?: number;
  };
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
  /**
   * Deliver one content-free payload to one device (Phase A).
   *
   * Also carries the key-needed wake-up, which is the same shape with one extra
   * routing field — a separate provider method would be a second code path to
   * the same HTTP call for no gain.
   */
  send(target: PushTarget, payload: DummyPushPayload | KeyNeededPushPayload): Promise<void>;
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

/**
 * Ask someone to open the app so a waiting device can read the conversation.
 *
 * Meant to be SEEN and acted on, unlike the content-free "New message" dummy.
 * On the scoped tiers the server holds no key, so a device that just joined can
 * read nothing until a device that already has the keys hands them over — and
 * that device is usually not in the room. Its owner is the only one who can
 * unblock this, so they are the one asked.
 *
 * The two cases read differently to the person, so they are worded differently:
 * their own second device waiting is a chore they will want to finish, while
 * another member waiting is somebody else being kept out. Naming the wrong one
 * is the sort of small wrongness that makes a notification feel automated.
 *
 * No topic title and no nickname, matching every other push this server sends:
 * a lockscreen is a public surface, and the topic id is enough for the tap to
 * land in the right room.
 */
export interface KeyNeededPushPayload {
  title: string;
  body: string;
  /**
   * `kind` lets a client route this away from the message path. `topicId` is
   * what the tap handler opens — the right destination here, because opening
   * that room is itself what hands the keys over.
   */
  data: { topicId: string; kind: 'key-needed'; epoch: number };
}

export function buildKeyNeededPayload(
  topicId: string,
  epoch: number,
  /** True when the device waiting belongs to the person being notified. */
  ownDevice: boolean,
): KeyNeededPushPayload {
  return {
    title: ownDevice ? 'Your other device is waiting' : 'A new member is waiting',
    body: ownDevice
      ? 'Open OpenStoa here so your other device can catch up on this conversation.'
      : 'They joined a chat you are in. Open OpenStoa so they can read the conversation so far.',
    data: { topicId, kind: 'key-needed', epoch },
  };
}

/**
 * Send that request to every device of this account that is not already
 * listening on an account stream.
 *
 * Per-device failures are swallowed: one dead token must not stop the rest, and
 * the room's own retry still covers everyone this misses. A null provider —
 * push not configured — is a clean no-op, which is why the SSE half never
 * depends on push being set up.
 */
export async function dispatchKeyNeeded(
  db: SqlExecutor,
  topicId: string,
  epoch: number,
  /**
   * Per account, the routing handles that already hold an account stream.
   *
   * Filtering happens per DEVICE, not per account: the case this exists for is
   * a browser that is open while the phone holding the keys is asleep. Deciding
   * by account would call that reachable and send nothing, and the phone would
   * never grant.
   */
  streamingByUser: Map<string, Set<string>>,
  provider: PushProvider | null,
  /** Whose device joined — so the copy can say "yours" when it is theirs. */
  joinerUserId: string,
): Promise<void> {
  if (!provider || streamingByUser.size === 0) return;
  // `''` excludes nobody: here the recipient set is decided by which devices
  // are asleep, not by who sent something.
  const targets: MemberPushTarget[] = await getTopicMemberTokens(
    db as Parameters<typeof getTopicMemberTokens>[0],
    topicId,
    '',
  );
  const asleep = targets.filter((t) => {
    const streaming = streamingByUser.get(t.userId);
    // A device of an account we were not asked about is not ours to wake.
    if (!streaming) return false;
    return !streaming.has(t.routingHandle);
  });
  await Promise.all(
    asleep.map((t) =>
      provider
        .send(
          { pushToken: t.pushToken, platform: t.platform },
          buildKeyNeededPayload(topicId, epoch, t.userId === joinerUserId),
        )
        .catch((err) =>
          logger.warn(ROUTE, 'key-needed push failed for one device', {
            topicId,
            platform: t.platform,
            err: String(err),
          }),
        ),
    ),
  );
}

export interface CiphertextDispatchInput {
  topicId: string;
  senderUserId: string;
  messageId: string;
  /** Base64 of the ALREADY-SEALED ciphertext (same opaque bytes stored). */
  sealedCiphertextB64: string;
  epoch: number;
  /**
   * OPTIONAL base64 of the TAK-sealed copy of the same body, supplied by the
   * SENDER in the POST /chat body (`pushArchive.ct`). Opaque to the server — it
   * is copied verbatim into `data.act` (SI-1: the server holds no key for it).
   */
  archiveCiphertextB64?: string;
  /** TAK version `archiveCiphertextB64` was sealed under (0 = public root). */
  takVersion?: number;
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
  input: Pick<
    CiphertextDispatchInput,
    'topicId' | 'messageId' | 'sealedCiphertextB64' | 'epoch' | 'archiveCiphertextB64' | 'takVersion'
  >,
): CiphertextPushPayload | null {
  const { topicId, messageId, sealedCiphertextB64, epoch, archiveCiphertextB64, takVersion } = input;
  if (typeof sealedCiphertextB64 !== 'string' || sealedCiphertextB64.length === 0) return null;
  if (typeof messageId !== 'string' || messageId.length === 0) return null;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) return null;
  // The TAK copy is an OPTIONAL preview optimisation: a missing/degenerate one
  // degrades to a ct-only payload (the NSE then just keeps the placeholder), it
  // never sinks the whole notification.
  const withArchive =
    typeof archiveCiphertextB64 === 'string' &&
    archiveCiphertextB64.length > 0 &&
    typeof takVersion === 'number' &&
    Number.isSafeInteger(takVersion) &&
    takVersion >= 0;
  const base = { topicId, messageId, epoch, ct: sealedCiphertextB64 };
  const payload: CiphertextPushPayload = {
    title: 'OpenStoa',
    body: 'New message',
    data: withArchive ? { ...base, act: archiveCiphertextB64, tv: takVersion } : base,
    mutableContent: true,
    dataOnly: true,
  };
  if (encodedSize(payload) <= PUSH_MAX_PAYLOAD_BYTES) return payload;
  // Over budget. Shed the optional preview fields first — a ct-only push still
  // notifies (and still serves the strategy-B fallback) where dropping to the
  // content-free dummy would lose `ct` too.
  if (withArchive) {
    const ctOnly: CiphertextPushPayload = { ...payload, data: base };
    if (encodedSize(ctOnly) <= PUSH_MAX_PAYLOAD_BYTES) return ctOnly;
  }
  return null; // even ct alone is over the cap → caller falls back to the dummy
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

// The real Expo push adapter + `getPushProvider()` factory live in
// `@/lib/pushProvider` (the thin, swappable HTTP edge). Keeping the provider in a
// separate module lets the dispatch logic here stay provider-agnostic and lets
// the adapter be unit-tested against a mocked fetch without touching this file.
export { getPushProvider, ExpoPushProvider } from '@/lib/pushProvider';
