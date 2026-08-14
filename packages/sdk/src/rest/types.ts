/**
 * Wire types mirroring openstoa/src/app/api/** handler responses. Kept minimal
 * and additive — only the fields the agent chat/topic/post flows read today.
 */

export interface AuthResult {
  userId: string;
  nickname: string;
  token: string;
}

export interface RefreshResult {
  token: string;
  expiresAt: number;
}

export interface SessionPayload {
  userId: string;
  nickname: string;
  isAI?: boolean;
  [k: string]: unknown;
}

export type TopicVisibility = 'public' | 'private' | 'secret';

export interface Topic {
  id: string;
  title: string;
  description: string | null;
  visibility?: TopicVisibility;
  creatorId?: string;
  inviteCode?: string;
  createdAt?: string;
  [k: string]: unknown;
}

export interface TopicMember {
  userId: string;
  nickname?: string;
  joinedAt?: string;
  [k: string]: unknown;
}

/**
 * A 1:1 direct-message channel as returned by GET /api/dm. A DM is a hidden
 * 2-member topic; `topicId` drives the exact same chat/MLS/TAK endpoints as a
 * normal topic. SI-1: this carries ONLY routing metadata — never message content.
 */
export interface DmChannel {
  topicId: string;
  peer: { userId: string; nickname: string; profileImage: string | null };
  lastActivityAt: string | null;
}

export interface CreateTopicInput {
  title: string;
  description?: string;
  visibility?: TopicVisibility;
  categoryId?: string;
  proofType?: string;
  allowedCountries?: string[];
  /**
   * How long the topic keeps its encrypted chat archive, in days: 0 (the
   * default) forever, or 365 / 90 / 30. Anything else is refused with 400.
   * Set once, at creation — `topics.update` does not accept it, because
   * shortening a window deletes other members' history. A shorter window means
   * a member (or agent) who joins later reads less back from `/archive`.
   */
  chatArchiveRetentionDays?: 0 | 365 | 90 | 30;
  [k: string]: unknown;
}

export interface Post {
  id: string;
  topicId: string;
  authorId: string;
  title: string;
  content: string;
  media?: unknown;
  isAI?: boolean;
  createdAt?: string;
  [k: string]: unknown;
}

export interface CreatePostInput {
  title: string;
  content: string;
  media?: unknown;
  tags?: string[];
  [k: string]: unknown;
}

export interface Comment {
  id: string;
  postId: string;
  authorId: string;
  content: string;
  isAI?: boolean;
  createdAt?: string;
  [k: string]: unknown;
}

export interface Category {
  id: string;
  name?: string;
  [k: string]: unknown;
}

/** A sealed chat body as it appears on the wire (mirrors the chat route). */
export interface SealedWire {
  ciphertext: string; // base64 MLS mls_private_message
  epoch: number;
  takVersion: number | null;
}

/** A chat message row as returned by GET/POST /api/topics/{id}/chat. */
export interface ChatMessageRow {
  id: string;
  topicId: string;
  userId: string;
  nickname: string;
  profileImage: string | null;
  type: 'message' | 'join' | 'leave' | string;
  isAI: boolean;
  createdAt: string;
  /** System text for join/leave rows; null for user messages. */
  message: string | null;
  /** Sealed body for user messages; null for system rows. */
  sealed: SealedWire | null;
}

// --- MLS Delivery Service wire shapes (server is crypto-free) ---

export interface CommitLogEntryWire {
  epoch: number;
  commit: string;
  welcome: string | null;
}

export interface ArchiveEntryWire {
  messageId: string;
  takVersion: number;
  ciphertext: string;
  createdAt: string;
}

export interface TakBundleRowWire {
  id: string;
  bundle: string;
  scope: string;
  createdAt: string;
}

export interface ConsumedKeyPackageWire {
  id: string;
  deviceId: string;
  keyPackage: string;
  isLastResort: boolean;
}

/**
 * Durable, revocable API key (design §7 follow-up). An agent authenticates
 * with `Authorization: Bearer <rawKey>` instead of an interactive login — the
 * key IS the scoped credential; its `cmd`/`historyGrant` gate requests
 * directly. Metadata only — a key's raw value/hash is never returned except
 * once, in `ApiKeyCreateResult.rawKey`, at issuance.
 */
export interface ApiKeyMeta {
  id: string;
  name: string;
  /** First ~12 chars of the raw key, for display/identification only. */
  prefix: string;
  isAI: boolean;
  cmd: string[];
  historyGrant: string;
  createdAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}

export interface ApiKeyCreateInput {
  name: string;
  cmd: string[];
  historyGrant: string;
  isAI?: boolean;
}

/**
 * Re-scope an existing key in place, so an agent whose scope was too narrow
 * does not have to be re-issued (which would mean distributing a new secret).
 * Only the scope is editable — `name` and `isAI` are fixed at issuance.
 */
export interface ApiKeyUpdateInput {
  cmd: string[];
  historyGrant: string;
}

export interface ApiKeyCreateResult {
  /** The full secret key. Shown exactly once — store it now, it cannot be retrieved again. */
  rawKey: string;
  key: ApiKeyMeta;
}
