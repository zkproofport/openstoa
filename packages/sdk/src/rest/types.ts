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

export interface CreateTopicInput {
  title: string;
  description?: string;
  visibility?: TopicVisibility;
  categoryId?: string;
  proofType?: string;
  allowedCountries?: string[];
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

export interface AiGrant {
  id: string;
  aiUserId?: string;
  cmd?: string[];
  historyGrant?: string;
  [k: string]: unknown;
}

export interface AiGrantSpecInput {
  aiUserId: string;
  cmd: string[];
  historyGrant: string;
  depth?: number;
  dpopJkt?: string | null;
  consentAnchor?: string | null;
}
