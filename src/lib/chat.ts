import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users, chatMessages } from '@/lib/db/schema';
import { logger } from '@/lib/logger';

const ROUTE = 'chat';
const CHANNEL_PREFIX = 'chat:topic:';
const PRESENCE_PREFIX = 'chat:presence:';
const PRESENCE_TTL_SECONDS = 300; // 5 minutes stale threshold

export interface SealedMessage {
  ciphertext: string; // base64-encoded sealed bytes
  epoch: number;
  takVersion?: number | null;
}

export interface ChatMessagePayload {
  id: string;
  topicId: string;
  userId: string;
  nickname: string;
  profileImage?: string | null;
  // System rows ('join' | 'leave') carry plaintext system text. User
  // messages leave this undefined and populate `sealed` instead — the
  // server routes the sealed body without ever seeing plaintext (SI-1).
  message?: string;
  sealed?: SealedMessage;
  type: 'message' | 'join' | 'leave';
  isAI?: boolean;
  createdAt: string;
}

interface PresenceEntry {
  nickname: string;
  profileImage?: string | null;
  connectedAt: string;
}

// Separate publisher client (lazy)
let _publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!_publisher) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL environment variable is required');
    _publisher = new Redis(url);
    _publisher.on('error', (err) => logger.error(ROUTE, 'Publisher error', { err: String(err) }));
  }
  return _publisher;
}

// Subscriber client — one shared instance for all subscriptions
let _subscriber: Redis | null = null;

function getSubscriber(): Redis {
  if (!_subscriber) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL environment variable is required');
    _subscriber = new Redis(url);
    _subscriber.on('error', (err) => logger.error(ROUTE, 'Subscriber error', { err: String(err) }));
  }
  return _subscriber;
}

function channelKey(topicId: string): string {
  return `${CHANNEL_PREFIX}${topicId}`;
}

function presenceKey(topicId: string): string {
  return `${PRESENCE_PREFIX}${topicId}`;
}

// Publish a chat message to a topic channel
export async function publishChatMessage(topicId: string, payload: ChatMessagePayload): Promise<void> {
  const pub = getPublisher();
  await pub.publish(channelKey(topicId), JSON.stringify(payload));
}

/**
 * Publish a membership-level system message — actual topic join or
 * removal, NOT an SSE connect/disconnect. Looks up the user's nickname
 * + profile image once, builds a `join` / `leave` payload, and
 * broadcasts it on the topic channel in the wrapped `{ event, data }`
 * shape the SSE subscriber expects.
 *
 * Use ONLY for true membership transitions. SSE transport events
 * (reconnect, app background, screen unmount) must leave the chat
 * stream untouched and update presence only.
 */
export async function broadcastMembershipSystemEvent(
  topicId: string,
  userId: string,
  type: 'join' | 'leave',
): Promise<void> {
  try {
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) {
      logger.warn(ROUTE, 'broadcastMembershipSystemEvent: user not found', { userId, topicId, type });
      return;
    }
    const nickname = user.nickname;
    const profileImage =
      (user as { profileImage?: string | null }).profileImage ?? null;
    const message = `${nickname} ${type === 'join' ? 'joined' : 'left'} the chat`;

    // Persist so the user (and anyone joining later) sees the system
    // message in chat history. Safe to persist now that we no longer
    // broadcast on every SSE connect/disconnect — only real membership
    // transitions create a row, so history stays clean.
    const [row] = await db
      .insert(chatMessages)
      .values({ topicId, userId, systemText: message, type })
      .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });

    const payload: ChatMessagePayload = {
      id: row?.id ?? `${type}-${Date.now()}-${userId}`,
      topicId,
      userId,
      nickname,
      profileImage,
      message,
      type,
      createdAt: row?.createdAt?.toISOString() ?? new Date().toISOString(),
    };
    const pub = getPublisher();
    await pub.publish(
      channelKey(topicId),
      JSON.stringify({ event: 'message', data: payload }),
    );
    logger.info(ROUTE, 'Membership system event broadcast', { topicId, userId, type, id: payload.id });
  } catch (err) {
    // The membership change has already committed by the time we get
    // here; a failed broadcast must never propagate back up and roll
    // it back. Log and continue.
    logger.warn(ROUTE, 'broadcastMembershipSystemEvent failed', {
      err: String(err),
      topicId,
      userId,
      type,
    });
  }
}

// Subscribe to a topic channel; returns an unsubscribe function
export function subscribeTopic(
  topicId: string,
  callback: (payload: ChatMessagePayload) => void,
): () => Promise<void> {
  const sub = getSubscriber();
  const channel = channelKey(topicId);

  sub.subscribe(channel, (err) => {
    if (err) logger.error(ROUTE, 'Subscribe failed', { channel, err: String(err) });
    else logger.info(ROUTE, 'Subscribed', { channel });
  });

  const handler = (ch: string, message: string) => {
    if (ch !== channel) return;
    try {
      const payload = JSON.parse(message) as ChatMessagePayload;
      callback(payload);
    } catch (err) {
      logger.error(ROUTE, 'Failed to parse message', { err: String(err) });
    }
  };

  sub.on('message', handler);

  return async () => {
    sub.off('message', handler);
    await sub.unsubscribe(channel);
    logger.info(ROUTE, 'Unsubscribed', { channel });
  };
}

// Add or update a user in the presence hash
export async function addPresence(
  topicId: string,
  userId: string,
  nickname: string,
  profileImage?: string | null,
): Promise<void> {
  const pub = getPublisher();
  const entry: PresenceEntry = { nickname, profileImage, connectedAt: new Date().toISOString() };
  await pub.hset(presenceKey(topicId), userId, JSON.stringify(entry));
}

// Remove a user from the presence hash
export async function removePresence(topicId: string, userId: string): Promise<void> {
  const pub = getPublisher();
  await pub.hdel(presenceKey(topicId), userId);
}

// Get all online users for a topic, pruning stale entries (> 5 minutes old)
export async function getPresence(
  topicId: string,
): Promise<Array<{ userId: string } & PresenceEntry>> {
  const pub = getPublisher();
  const key = presenceKey(topicId);
  const raw = await pub.hgetall(key);
  if (!raw) return [];

  const now = Date.now();
  const staleThreshold = PRESENCE_TTL_SECONDS * 1000;
  const staleUsers: string[] = [];
  const result: Array<{ userId: string } & PresenceEntry> = [];

  for (const [userId, value] of Object.entries(raw)) {
    try {
      const entry = JSON.parse(value) as PresenceEntry;
      const age = now - new Date(entry.connectedAt).getTime();
      if (age > staleThreshold) {
        staleUsers.push(userId);
      } else {
        result.push({ userId, ...entry });
      }
    } catch {
      staleUsers.push(userId);
    }
  }

  if (staleUsers.length > 0) {
    await pub.hdel(key, ...staleUsers);
    logger.info(ROUTE, 'Pruned stale presence entries', { topicId, count: staleUsers.length });
  }

  return result;
}

// Refresh connectedAt timestamp (heartbeat)
export async function refreshPresence(topicId: string, userId: string): Promise<void> {
  const pub = getPublisher();
  const key = presenceKey(topicId);
  const raw = await pub.hget(key, userId);
  if (!raw) return;
  try {
    const entry = JSON.parse(raw) as PresenceEntry;
    entry.connectedAt = new Date().toISOString();
    await pub.hset(key, userId, JSON.stringify(entry));
  } catch (err) {
    logger.error(ROUTE, 'Failed to refresh presence', { topicId, userId, err: String(err) });
  }
}
