/**
 * Phase 6 push notifications — content-free dispatch (design §13, D12/D13/D14,
 * Phase A). When a chat message is published the server fires a DUMMY push to
 * every other member's device: a constant "New message" with NO plaintext, NO
 * ciphertext, NO sender identity, NO topic title — only the topic id so the tap
 * handler can deep-link. The recipient then fetches `GET /chat?since=` and
 * decrypts locally. SI-1 for push: the payload here can never carry content.
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

export interface PushTarget {
  pushToken: string;
  platform: 'ios' | 'android';
}

export interface PushProvider {
  /** Deliver one content-free payload to one device. */
  send(target: PushTarget, payload: DummyPushPayload): Promise<void>;
}

/** The fixed content-free payload for a topic. No message content, ever. */
export function buildDummyPayload(topicId: string): DummyPushPayload {
  return { title: 'OpenStoa', body: 'New message', data: { topicId } };
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
