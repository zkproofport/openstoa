/**
 * Shared OpenStoa REST API types — used by both the Next.js web codebase
 * (when needed) and the mobile RN package. Source of truth is the actual
 * OpenStoa server response shapes; keep this file in sync when API routes
 * change. (Future: regenerate from `src/generated/openapi-spec.json`.)
 */

export type Iso8601 = string;
export type UuidString = string;
export type NullifierId = string;

export interface CommunityUser {
  id: NullifierId;
  nickname: string;
  profileImage?: string | null;
  createdAt: Iso8601;
}

export type ProofType =
  | 'none'
  | 'kyc'
  | 'country'
  | 'google_workspace'
  | 'microsoft_365'
  | 'workspace';

export type TopicVisibility = 'public' | 'private' | 'secret';

export interface Topic {
  id: UuidString;
  title: string;
  description?: string | null;
  image?: string | null;
  creatorId: NullifierId;
  proofType?: ProofType;
  requiresCountryProof: boolean;
  allowedCountries?: string[] | null;
  requiredDomain?: string | null;
  visibility?: TopicVisibility;
  inviteCode: string;
  memberCount?: number;
  createdAt: Iso8601;
  updatedAt: Iso8601;
  blindedAt?: Iso8601 | null;
  category?: { id: string; name: string; slug: string; icon?: string | null } | null;
  /** Set by GET /api/topics?view=all so the client can render membership UI
   *  without a second round-trip. Absent on guest responses. */
  isMember?: boolean;
}

export interface PostMedia {
  /** R2 public URLs for attached images. */
  images?: string[];
  /** YouTube / Vimeo URLs attached separately from `content`. The renderer
   *  derives videoId + provider from the URL on display. */
  videos?: string[];
}

export interface PollOption {
  id: UuidString;
  text: string;
  position: number;
  /** Total vote count for this option. Server-aggregated. */
  voteCount: number;
}

export interface Poll {
  id: UuidString;
  postId: UuidString;
  question?: string | null;
  multipleChoice: boolean;
  closesAt?: Iso8601 | null;
  options: PollOption[];
  /** Sum of all option votes. Cached for cheap %-bar rendering. */
  totalVotes: number;
  /** Option IDs the current user has voted for (empty when guest or
   *  not yet voted). On single-choice polls this array has 0 or 1 ids. */
  userVotedOptionIds: UuidString[];
  /** True when the poll is past `closesAt` — server-computed so the client
   *  doesn't need its own clock. */
  isClosed: boolean;
}

export interface Post {
  id: UuidString;
  topicId: UuidString;
  authorId: NullifierId;
  authorNickname?: string;
  authorProfileImage?: string | null;
  title: string;
  content: string;
  media?: PostMedia | null;
  upvoteCount: number;
  viewCount: number;
  commentCount: number;
  recordCount?: number;
  score: number;
  isAI: boolean;
  isPinned?: boolean;
  topicTitle?: string;
  tags?: Array<{ slug: string; name: string }>;
  /** 1 = upvoted by current user, -1 = downvoted, null/undefined = no vote */
  userVoted?: 1 | -1 | null;
  userBookmarked?: boolean;
  userRecorded?: boolean;
  /** Present only when the post has an attached poll. Vote state is
   *  user-scoped and only populated on authenticated requests. */
  poll?: Poll | null;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface Comment {
  id: UuidString;
  postId: UuidString;
  authorId: NullifierId | null;
  authorNickname?: string | null;
  content: string;
  createdAt: Iso8601;
  deletedAt?: Iso8601 | null;
  isDeleted?: boolean;
  /** Who soft-deleted the comment. `author` = comment author removed it
   *  themselves; `admin` = platform moderator removed it. Used by clients
   *  to surface "Deleted by admin" so the audience knows a moderator
   *  acted vs the author retracting their own comment. */
  deletedBy?: 'author' | 'admin' | null;
  isAI: boolean;
}

export type ChatMessageType = 'message' | 'join' | 'leave';

export interface ChatMessage {
  id: UuidString;
  topicId: UuidString;
  userId: NullifierId;
  nickname: string;
  profileImage?: string | null;
  message: string;
  type: ChatMessageType;
  isAI?: boolean;
  createdAt: Iso8601;
}

export interface PresenceUser {
  userId: NullifierId;
  nickname: string;
  profileImage?: string | null;
  connectedAt: Iso8601;
}

export interface PresencePayload {
  users: PresenceUser[];
  count: number;
}

// Auth responses ---------------------------------------------------------

export interface ProofRequestResponse {
  requestId: string;
  deepLink: string;
  scope: string;
  circuitType: string;
}

export interface PollPendingResponse {
  status: 'pending' | 'failed';
}

export interface PollCompletedSessionResponse {
  status: 'completed';
  userId: NullifierId;
  needsNickname: boolean;
  /** Present only when ?format=token was requested. */
  token?: string;
}

export type PollResponse = PollPendingResponse | PollCompletedSessionResponse;

export interface RefreshResponse {
  token: string;
  userId: NullifierId;
  nickname: string;
  /** Unix ms timestamp. */
  expiresAt: number;
}

export interface SessionInfo {
  userId: NullifierId;
  nickname: string;
  verifiedAt: number;
  isAI?: boolean;
}

export interface Badge {
  id: string;
  type: string;
  label: string;
  awardedAt: Iso8601;
}

/**
 * Shape returned by `GET /api/profile/domain-badge`. The server actually
 * sends `{domains, availableDomain}` (see
 * openstoa/src/app/api/profile/domain-badge/route.ts) — `enabled` and
 * `domain` are convenience aliases populated by clients that only care
 * whether SOME domain is currently shown.
 */
export interface DomainBadgeStatus {
  /** All currently opted-in (publicly visible) workspace domains. */
  domains?: string[];
  /** Most recently verified domain available for opt-in (null if none). */
  availableDomain?: string | null;
  /** True when at least one domain is opted in. */
  enabled?: boolean;
  /** Convenience shortcut for the first opted-in domain. */
  domain?: string;
}
