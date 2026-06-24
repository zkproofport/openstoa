import { pgTable, text, uuid, boolean, timestamp, primaryKey, integer, real, varchar, uniqueIndex, index, jsonb, bigint, customType } from 'drizzle-orm/pg-core';

// Postgres `bytea` — drizzle-orm has no first-class bytea, so we declare a
// custom type that maps to a Node Buffer. Used for E2EE chat ciphertext: the
// server stores opaque encrypted bytes and never sees plaintext (SI-1).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const users = pgTable('users', {
  id: text('id').primaryKey(), // nullifier from publicInputs
  nickname: text('nickname').unique().notNull(),
  profileImage: text('profile_image'), // URL to R2 uploaded image
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  totalRecorded: integer('total_recorded').notNull().default(0),
  role: varchar('role', { length: 10 }).notNull().default('user'), // 'user' | 'admin'
});

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  description: text('description'),
  icon: varchar('icon', { length: 10 }), // emoji icon
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const topics = pgTable('topics', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  description: text('description'),
  image: text('image'),
  creatorId: text('creator_id').references(() => users.id).notNull(),
  categoryId: uuid('category_id').references(() => categories.id),
  requiresCountryProof: boolean('requires_country_proof').default(false),
  allowedCountries: text('allowed_countries').array(),
  proofType: varchar('proof_type', { length: 30 }).notNull().default('none'), // 'none' | 'kyc' | 'country' | 'google_workspace' | 'microsoft_365' | 'workspace'
  requiredDomain: text('required_domain'), // e.g., 'company.com' for workspace/MS 365 gating
  inviteCode: text('invite_code').unique().notNull(),
  visibility: varchar('visibility', { length: 10 }).notNull().default('public'), // 'public' | 'private' | 'secret'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  score: real('score').notNull().default(0),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow(),
  blindedAt: timestamp('blinded_at', { withTimezone: true }),
  blindedBy: varchar('blinded_by', { length: 10 }), // 'owner' | 'admin'
});

export const topicMembers = pgTable('topic_members', {
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  userId: text('user_id').references(() => users.id).notNull(),
  role: varchar('role', { length: 10 }).notNull().default('member'), // 'owner' | 'admin' | 'member'
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.topicId, table.userId] }),
}));

export const joinRequests = pgTable('join_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  userId: text('user_id').references(() => users.id).notNull(),
  status: varchar('status', { length: 10 }).notNull().default('pending'), // 'pending' | 'approved' | 'rejected'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  reviewedBy: text('reviewed_by').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
}, (table) => ({
  uniqueRequest: uniqueIndex('join_request_topic_user_idx').on(table.topicId, table.userId),
}));

export const posts = pgTable('posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  authorId: text('author_id').references(() => users.id).notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  media: jsonb('media').$type<{ images?: string[]; videos?: string[] }>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  upvoteCount: integer('upvote_count').notNull().default(0),
  viewCount: integer('view_count').notNull().default(0),
  commentCount: integer('comment_count').notNull().default(0),
  score: real('score').notNull().default(0),
  isPinned: boolean('is_pinned').notNull().default(false),
  recordCount: integer('record_count').notNull().default(0),
  isAI: boolean('is_ai').notNull().default(false),
  // Activity timestamp used by sort=active. Bumped on comment/vote/reaction.
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow(),
  // Soft delete — author can wipe title/content/media but the row is kept
  // so on-chain records and comments still resolve. Mirrors comments.deletedAt.
  isDeleted: boolean('is_deleted').notNull().default(false),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// ──────────────────────────────────────────────────────────────────────
// Polls — Twitter/X-style multiple-choice attached to a post. Each post
// gets at most one poll. Options live in a sibling table to keep the
// row count predictable for analytics and to enforce per-option uniqueness
// of votes. Votes carry the (poll, option, user) triple; single-choice vs
// multi-choice is enforced at write time, not at the DB layer, because the
// uniqueness constraint changes between the two modes.
// ──────────────────────────────────────────────────────────────────────
export const polls = pgTable('polls', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }).notNull().unique(),
  question: text('question'),
  multipleChoice: boolean('multiple_choice').notNull().default(false),
  closesAt: timestamp('closes_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const pollOptions = pgTable('poll_options', {
  id: uuid('id').primaryKey().defaultRandom(),
  pollId: uuid('poll_id').references(() => polls.id, { onDelete: 'cascade' }).notNull(),
  text: text('text').notNull(),
  position: integer('position').notNull(),
});

export const pollVotes = pgTable('poll_votes', {
  id: uuid('id').primaryKey().defaultRandom(),
  pollId: uuid('poll_id').references(() => polls.id, { onDelete: 'cascade' }).notNull(),
  optionId: uuid('option_id').references(() => pollOptions.id, { onDelete: 'cascade' }).notNull(),
  userId: text('user_id').references(() => users.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  // One row per (poll, option, user) — both single- and multi-choice modes
  // disallow voting for the same option twice. Single-choice further caps
  // at one row per (poll, user), enforced application-side.
  uniqueVote: uniqueIndex('poll_vote_unique').on(table.pollId, table.optionId, table.userId),
}));

export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id').references(() => posts.id).notNull(),
  authorId: text('author_id').references(() => users.id).notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: varchar('deleted_by', { length: 10 }), // 'author' | 'admin' | null
  isAI: boolean('is_ai').notNull().default(false),
});

export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 50 }).notNull().unique(),
  slug: varchar('slug', { length: 50 }).notNull().unique(),
  postCount: integer('post_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const postTags = pgTable('post_tags', {
  postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }).notNull(),
  tagId: uuid('tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.postId, table.tagId] }),
}));

export const bookmarks = pgTable('bookmarks', {
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.postId] }),
}));

export const reactions = pgTable('reactions', {
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }).notNull(),
  emoji: varchar('emoji', { length: 10 }).notNull(), // e.g. '👍', '❤️', '🔥', '😂', '🎉', '😮'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.postId, table.emoji] }),
}));

export const votes = pgTable('votes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }),
  commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
  value: integer('value').notNull(), // +1 or -1
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  userPostVote: uniqueIndex('vote_user_post_idx').on(table.userId, table.postId),
  userCommentVote: uniqueIndex('vote_user_comment_idx').on(table.userId, table.commentId),
}));

export const records = pgTable('records', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id').references(() => posts.id).notNull(),
  recorderNullifier: text('recorder_nullifier').references(() => users.id).notNull(),
  contentHash: text('content_hash').notNull(), // keccak256 of post content at time of recording
  txHash: text('tx_hash'), // Base TX hash (null while pending)
  method: varchar('method', { length: 10 }).notNull().default('service'), // 'service' | 'direct'
  status: varchar('status', { length: 10 }).notNull().default('pending'), // 'pending' | 'confirmed' | 'failed'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  uniqueRecord: uniqueIndex('record_post_recorder_idx').on(table.postId, table.recorderNullifier),
  postIdx: index('record_post_idx').on(table.postId),
}));

export const recordLimits = pgTable('record_limits', {
  userId: text('user_id').references(() => users.id).notNull(),
  date: text('date').notNull(), // YYYY-MM-DD format
  count: integer('count').notNull().default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.date] }),
}));

export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  userId: text('user_id').references(() => users.id).notNull(),
  // E2EE migration complete (Phase 2, P2-22): the legacy plaintext `message`
  // column is gone. `system_text` is nullable and reserved for system rows
  // (`type` = 'join' | 'leave') which only carry public nicknames; user
  // messages (`type` = 'message') leave `system_text` NULL and store opaque
  // `ciphertext` instead. The server never sees user chat plaintext (SI-1) —
  // there is no longer any column a user body could land in except encrypted
  // `ciphertext`.
  systemText: text('system_text'),
  ciphertext: bytea('ciphertext'), // sealed message bytes; NULL for system rows
  epoch: bigint('epoch', { mode: 'number' }), // group epoch the ciphertext was sealed under
  takVersion: integer('tak_version'), // Topic Archive Key version (Phase 3); NULL pre-archive
  type: varchar('type', { length: 10 }).notNull().default('message'), // 'message' | 'join' | 'leave'
  isAI: boolean('is_ai').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  topicIdx: index('chat_msg_topic_idx').on(table.topicId),
  topicCreatedIdx: index('chat_msg_topic_created_idx').on(table.topicId, table.createdAt),
}));

// MLS group state — the server stores PUBLIC state only (no secrets, no
// plaintext). One row per topic: the topic IS the MLS group. `current_epoch`
// is the authoritative counter the Delivery Service advances via epoch-CAS
// (SI-2, one Commit per epoch). The server runs NO MLS crypto (C1) — it routes
// ciphertext and parses Commit framing (crypto-free) to enforce consistency.
export const mlsGroups = pgTable('mls_groups', {
  topicId: uuid('topic_id').primaryKey().references(() => topics.id),
  groupId: bytea('group_id').notNull(), // MLS group_id (public)
  currentEpoch: bigint('current_epoch', { mode: 'number' }).notNull(),
  ciphersuite: text('ciphersuite').notNull(), // MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 (0x0001)
  groupInfo: bytea('group_info'), // public GroupInfo for External Commit; NULL until first published
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Per-device KeyPackage directory (RFC 9420 §10) — PUBLIC keys only. A device
// publishes KeyPackages here; an existing member consumes exactly one (atomic,
// SI-3) to MLS-Add that device to a group. `consumed_at` enforces single-use;
// `is_last_resort` packages are reusable fallbacks (always-on AI members).
export const deviceKeyPackages = pgTable('device_key_packages', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').references(() => users.id).notNull(), // nullifier
  deviceId: text('device_id').notNull(),
  keyPackage: bytea('key_package').notNull(), // public KeyPackage bytes
  isAI: boolean('is_ai').notNull().default(false),
  isLastResort: boolean('is_last_resort').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }), // NULL = available
}, (table) => ({
  // Supports the atomic consume query (find one unconsumed package per user).
  userConsumedIdx: index('device_kp_user_consumed_idx').on(table.userId, table.consumedAt),
}));

// MLS handshake log (Delivery Service catch-up). The server stores every Commit
// + its Welcome per epoch so (a) members offline during a Commit re-sync by
// pulling missed epochs (GET ?sinceEpoch), and (b) newly-added members fetch
// their Welcome. Public ciphertext only — no secrets (C1/SI-1). `epoch` is the
// NEW epoch the Commit produced (asserted epoch + 1). The (topic_id, epoch)
// primary key also makes two commits for the same new epoch impossible at the
// storage layer — a belt-and-suspenders backstop to the epoch-CAS (SI-2).
export const mlsCommits = pgTable('mls_commits', {
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  epoch: bigint('epoch', { mode: 'number' }).notNull(), // new epoch produced by this commit
  commit: bytea('commit').notNull(), // the Commit MLSMessage bytes
  welcome: bytea('welcome'), // Welcome for added members; NULL when none added
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.topicId, table.epoch] }),
  topicEpochIdx: index('mls_commits_topic_epoch_idx').on(table.topicId, table.epoch),
}));

// TAK (Topic Archive Key) bundles — encrypted history keys delivered to a new
// member/device so it can read messages from before it joined (Phase 3, D5
// to-device). The server stores ONLY the HPKE-wrapped ciphertext bundle
// (C1/SI-1): it never sees a TAK in the clear, and never unwraps. A bundle is
// wrapped to ONE recipient device's public key; `scope` records the granted
// history range, tier-differentiated (full | since_epoch:N | 30d | 100 | none).
// The CVE-2024-47080/-47824 device-identity check (§5.5) is performed by the
// SENDER client before wrapping; the server additionally enforces the envelope
// (recipient is a current member with a published device package, SI-4 caps).
export const takBundles = pgTable('tak_bundles', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  recipientUserId: text('recipient_user_id').references(() => users.id).notNull(), // nullifier
  recipientDeviceId: text('recipient_device_id').notNull(),
  ciphertext: bytea('ciphertext').notNull(), // HPKE-wrapped TAK bundle (server never unwraps)
  scope: text('scope').notNull(), // full | since_epoch:N | 30d | 100 | none
  deliveredAt: timestamp('delivered_at', { withTimezone: true }), // NULL = not yet fetched by recipient
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  // The recipient device polls its own undelivered bundles for a topic.
  recipientIdx: index('tak_bundles_recipient_idx').on(table.topicId, table.recipientUserId, table.recipientDeviceId),
}));

// archive-holder succession state (Phase 3, SI-6) — PUBLIC topics ONLY. The
// designated holder forward-rewraps the public seed chain on every membership
// change so any single current member can derive every archived epoch's TAK.
// On holder inactivity (`holder_lease_expires_at` past) the next succession_rank
// member takes over; the lease makes succession single-winner so the seed chain
// never forks. private/secret/AI topics have NO row here (SI-6b: no standing
// custodian — a forward-rewrap custodian would be a member-held escrow that
// defeats the per-epoch revocability those tiers depend on).
export const archiveHolders = pgTable('archive_holders', {
  topicId: uuid('topic_id').primaryKey().references(() => topics.id),
  holderUserId: text('holder_user_id').references(() => users.id).notNull(),
  holderDeviceId: text('holder_device_id').notNull(),
  epochCovered: bigint('epoch_covered', { mode: 'number' }).notNull(), // highest epoch this holder has forward-rewrapped
  successionRank: integer('succession_rank').notNull().default(0), // owner=0, admin=1, ... (succession order)
  holderLeaseExpiresAt: timestamp('holder_lease_expires_at', { withTimezone: true }), // inactivity → single-winner succession
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// archive store (Phase 3) — past messages re-encrypted under a TAK so a newly
// joined member can read history that MLS forward secrecy would otherwise lock
// out. The CLIENT (never the server — SI-1) re-encrypts the plaintext under the
// current TAK and uploads the ciphertext; the server stores opaque bytes keyed
// by the original message and the TAK version used. One archive row per
// message (unique topic_id+message_id); `since` pagination is by created order.
export const chatArchive = pgTable('chat_archive', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  messageId: uuid('message_id').notNull(), // original chat_messages.id
  takVersion: integer('tak_version').notNull(), // which TAK encrypted this row
  ciphertext: bytea('ciphertext').notNull(), // TAK-encrypted body (server never unwraps)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  topicMsgIdx: uniqueIndex('chat_archive_topic_msg_idx').on(table.topicId, table.messageId),
  topicCreatedIdx: index('chat_archive_topic_created_idx').on(table.topicId, table.createdAt),
}));

export const userVerifications = pgTable('user_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  proofType: varchar('proof_type', { length: 30 }).notNull(), // 'kyc' | 'country' | 'google_workspace' | 'microsoft_365'
  domain: text('domain'), // extracted domain for workspace/ms365
  country: text('country'), // extracted country ISO code for country proof
  verifiedAt: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  proof: text('proof'), // proof hex (for re-verification)
  publicInputs: text('public_inputs'), // public inputs JSON
}, (table) => ({
  userProofType: uniqueIndex('user_verification_user_proof_idx').on(table.userId, table.proofType),
  userIdx: index('user_verification_user_idx').on(table.userId),
}));

export const inviteTokens = pgTable('invite_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'cascade' }).notNull(),
  token: text('token').unique().notNull(), // random 16-char hex
  createdBy: text('created_by').references(() => users.id).notNull(),
  usedBy: text('used_by').references(() => users.id), // null until used
  usedAt: timestamp('used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tokenIdx: uniqueIndex('invite_token_idx').on(table.token),
}));
