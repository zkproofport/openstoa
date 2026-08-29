import { sql } from 'drizzle-orm';
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
  creatorId: text('creator_id').references(() => users.id, { onUpdate: 'cascade' }).notNull(),
  categoryId: uuid('category_id').references(() => categories.id),
  requiresCountryProof: boolean('requires_country_proof').default(false),
  allowedCountries: text('allowed_countries').array(),
  proofType: varchar('proof_type', { length: 30 }).notNull().default('none'), // 'none' | 'kyc' | 'country' | 'google_workspace' | 'microsoft_365' | 'workspace'
  requiredDomain: text('required_domain'), // e.g., 'company.com' for workspace/MS 365 gating
  inviteCode: text('invite_code').unique().notNull(),
  visibility: varchar('visibility', { length: 10 }).notNull().default('public'), // 'public' | 'private' | 'secret'
  // A DM (1:1 direct chat) is modeled as a hidden 2-member topic so it reuses the
  // whole E2EE chat/MLS/TAK stack unchanged (P-D). `kind='dm'` topics are excluded
  // from every public/topic listing (GET /api/topics, feed, search); a normal
  // community topic keeps the default `'topic'`.
  kind: varchar('kind', { length: 10 }).notNull().default('topic'), // 'topic' | 'dm'
  // Canonical-ordered participant pair `min(a,b)|max(a,b)` for `kind='dm'` rows,
  // NULL for normal topics. The unique index below makes `POST /api/dm` idempotent
  // (either order of the pair maps to the same row) at the storage layer.
  dmPair: text('dm_pair'),
  // Identity of the PUBLIC archive root this topic's history is sealed under:
  // base64(HKDF(root, "openstoa-archive-root-id/v1", 16)). Opaque bytes to the
  // server — it never derives or verifies this (C1: crypto-free DS); clients
  // compute it from the root they hold and compare. NULL means "no root has
  // been claimed yet", which is NOT the same as "this topic has no root": a
  // topic that predates this column has archive rows and a null fingerprint.
  // WRITE-ONCE: only ever set from NULL (compare-and-set), so two devices racing
  // to create the first root cannot both win — the loser adopts the winner's
  // root instead of overwriting the archive's identity.
  //
  // DM tier, NOT public. This said the opposite — "public tier only; DM topics
  // leave this NULL forever" — and it was the shape of the whole DM bug: a DM
  // is `topic-root` with `serverHoldsKey: false` (`chatTierPolicy`), so it is
  // the one tier with a root and no server to arbitrate it, and this column is
  // how its two devices agree on one. A public topic settles its root through
  // `GET/PUT /archive/root` instead and does not need this. `private`/`secret`
  // are per-epoch (§5.2) and do leave it NULL forever.
  //
  // Load-bearing beyond the crypto: because a row can only be sealed under a
  // root AFTER that root's fingerprint is published (`claimRoot` publishes
  // first, and `currentArchiveKey` seals only on `verified`), NULL here PROVES
  // no row on this topic was sealed under a root. `scripts/delete-dm-chat-archive.ts`
  // is that inference used as a deletion scope, so weakening this column's
  // write-once/published-first properties would silently widen what it deletes.
  archiveRootFingerprint: text('archive_root_fingerprint'),
  // How long this topic's chat ARCHIVE (`chat_archive.ciphertext`) is kept, in
  // days — 0 means "kept indefinitely". Chosen by the admin when the topic is
  // created and not editable afterwards, because shortening a window is a
  // destructive act on other members' history, not a preference.
  //
  // The allowed values are a closed set (`src/lib/archiveRetention.ts`), and 0
  // is the default so every row that predates this column keeps exactly the
  // behaviour it had. It matters most for `public`: that is the one tier where
  // the server also holds the archive root, so an unbounded window there means
  // operator-readable data accumulating with no end date.
  //
  // NOT the delivery queue: `chat_messages.ciphertext` has its own, separate
  // rule (drop on delivery) and is untouched by this column.
  chatArchiveRetentionDays: integer('chat_archive_retention_days').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  score: real('score').notNull().default(0),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow(),
  blindedAt: timestamp('blinded_at', { withTimezone: true }),
  blindedBy: varchar('blinded_by', { length: 10 }), // 'owner' | 'admin'
  /**
   * The owner's OWN space — one per account, made when the account is.
   *
   * It is an ordinary secret topic in every other respect: it sits in the
   * owner's topic list, takes posts, and has the same E2EE chat. That is the
   * point, and it is why this is a FLAG rather than a `kind`: the listings
   * filter on `kind = 'topic'`, so a personal topic given its own kind would
   * vanish from the one list it has to appear in.
   *
   * What the flag changes is only who can ever be in it — no invite, no code,
   * no request, no direct join. A space that can be shared by accident is not
   * the thing being offered, so the refusals live at the routes: a client that
   * forgets to hide a button must not be able to open the room to someone.
   */
  personal: boolean('personal').notNull().default(false),
}, (table) => ({
  // Postgres treats NULLs as distinct, so normal topics (dm_pair = NULL) never
  // collide here; only DM rows are constrained to one per canonical pair.
  dmPairIdx: uniqueIndex('topics_dm_pair_idx').on(table.dmPair),
  /*
   * ONE personal topic per account, enforced by the database.
   *
   * Two sign-ins racing is ordinary, not exotic — a phone and an agent can
   * arrive on the same second. A check-then-insert would hand that account two
   * private spaces with its posts split between them, and nothing would ever
   * tell the person which one they were looking at.
   */
  personalOwnerIdx: uniqueIndex('topics_personal_owner_idx')
    .on(table.creatorId)
    .where(sql`personal`),
}));

export const topicMembers = pgTable('topic_members', {
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  userId: text('user_id').references(() => users.id, { onUpdate: 'cascade' }).notNull(),
  role: varchar('role', { length: 10 }).notNull().default('member'), // 'owner' | 'admin' | 'member'
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.topicId, table.userId] }),
}));

export const joinRequests = pgTable('join_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  userId: text('user_id').references(() => users.id, { onUpdate: 'cascade' }).notNull(),
  status: varchar('status', { length: 10 }).notNull().default('pending'), // 'pending' | 'approved' | 'rejected'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  reviewedBy: text('reviewed_by').references(() => users.id, { onUpdate: 'cascade' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
}, (table) => ({
  uniqueRequest: uniqueIndex('join_request_topic_user_idx').on(table.topicId, table.userId),
}));

export const posts = pgTable('posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  authorId: text('author_id').references(() => users.id, { onUpdate: 'cascade' }).notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  /*
   * `imageAlts` maps a picture's URL to the author's own description of it.
   *
   * A SEPARATE MAP RATHER THAN A FIELD ON EACH PICTURE, for one reason worth
   * writing down: the galleries that draw these already take exactly this shape
   * (`imageAlts?: Record<string, string>`), and every client already installed
   * reads `images` as a list of URLs. Turning that list into objects would show
   * an empty post on every phone running the build people have now.
   *
   * A key with no matching entry in `images` is dropped when the post is saved,
   * so removing a picture cannot leave its description behind.
   */
  media: jsonb('media').$type<{
    images?: string[];
    videos?: string[];
    imageAlts?: Record<string, string>;
  }>(),
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
  userId: text('user_id').references(() => users.id, { onUpdate: 'cascade' }).notNull(),
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
  authorId: text('author_id').references(() => users.id, { onUpdate: 'cascade' }).notNull(),
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
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }).notNull(),
  postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.postId] }),
}));

export const reactions = pgTable('reactions', {
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }).notNull(),
  postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }).notNull(),
  emoji: varchar('emoji', { length: 10 }).notNull(), // e.g. '👍', '❤️', '🔥', '😂', '🎉', '😮'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.postId, table.emoji] }),
}));

export const votes = pgTable('votes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }).notNull(),
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
  recorderNullifier: text('recorder_nullifier').references(() => users.id, { onUpdate: 'cascade' }).notNull(),
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
  userId: text('user_id').references(() => users.id, { onUpdate: 'cascade' }).notNull(),
  date: text('date').notNull(), // YYYY-MM-DD format
  count: integer('count').notNull().default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.date] }),
}));

export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  userId: text('user_id').references(() => users.id, { onUpdate: 'cascade' }).notNull(),
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
  // 'message' | 'join' | 'leave' | 'notice'.
  //
  // `notice` is the odd one and the reason this comment grew: it is SEALED like
  // a message (its body is `ciphertext`, never `system_text` — see SI-1 above)
  // but it is not FROM the person whose token filed it. The client draws it as a
  // received bubble so a system message does not masquerade as something the
  // reader wrote to themselves, while keeping the tap-to-copy an ordinary
  // message has. Only a person's own space accepts one.
  type: varchar('type', { length: 10 }).notNull().default('message'),
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
/**
 * The signing key that proves an install is the same one as last time.
 *
 * NOT `device_key_packages` below, which holds MLS KeyPackages — those are
 * consumed on use, one per join, and say nothing about continuity. This is one
 * long-lived Ed25519 public key per device, and the private half never leaves
 * the phone.
 *
 * WHY IT EXISTS. `deviceId` used to be a random string the client made up and
 * sent in a header; the server stored it and believed it, having nothing else.
 * Lose the string and the phone becomes a stranger to itself — staging held one
 * account on one phone with 48 distinct ids across epochs 1→58 in one room, each
 * a leaf that left the epochs before it unreadable. Learn the string and anyone
 * can claim to be that device from anywhere. A name can be lost and a name can
 * be copied; holding a private key is neither.
 *
 * `device_id` stays as the human-facing handle ("your other phone"), but it is
 * no longer what decides. The public key is.
 */
export const deviceSigningKeys = pgTable('device_signing_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').references(() => users.id, { onUpdate: 'cascade' }).notNull(),
  /** Matches the id the client already sends; one key per device per account. */
  deviceId: text('device_id').notNull(),
  /** Ed25519 public key, base64. The suite MLS already uses — no new primitive. */
  publicKey: text('public_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  /** Last successful challenge. Answers "when did this device last prove itself". */
  lastProvedAt: timestamp('last_proved_at', { withTimezone: true }),
}, (table) => ({
  /*
   * One key per (account, device). A device that re-registers is either the same
   * key — a no-op — or a genuinely new install that lost its private half, and
   * the second case has to be visible rather than silently appended: appending
   * is how one phone became forty-eight rows.
   */
  userDeviceIdx: uniqueIndex('device_signing_user_device_idx').on(table.userId, table.deviceId),
}));

export const deviceKeyPackages = pgTable('device_key_packages', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').references(() => users.id, { onUpdate: 'cascade' }).notNull(), // nullifier
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
/**
 * "Please unlock the history for me" — one row per asking device.
 *
 * WHY IT NEEDS A TABLE AT ALL. After a recovery on a new phone, private, secret
 * and DM rooms open only as far as the OLD phone's last backup: epochs that
 * advanced while it was off were never in that device's keychain, so they were
 * never in the blob. The one place those keys still exist is another member's
 * device. Somebody has to be ASKED, and the asking has to survive the moment —
 * the member who can grant is usually not looking at their phone right now.
 *
 * WHAT THE SERVER LEARNS, and it is deliberately little: that a device would
 * like keys for a topic. Not which messages, not the keys themselves — the
 * grant travels as an HPKE-sealed `tak_bundles` row the server cannot open, the
 * same as every other key delivery.
 *
 * NO FK ON THE IDS, matching `tak_bundles` directly above and for the same
 * reason: the MLS leaf credential carries a device id, not a user nullifier, so
 * a row here names what the requesting client believes about itself. The grant
 * is addressed by leaf regardless, so a lie buys nothing.
 */
export const keyRequests = pgTable('key_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  requesterUserId: text('requester_user_id').notNull(),
  /** Which leaf to seal the grant to — the same address `tak_bundles` uses. */
  requesterDeviceId: text('requester_device_id').notNull(),
  /**
   * The oldest epoch the requester can already read, or null when it can read
   * none. A grant only has to cover what is BELOW this, so a member handing
   * keys over does not re-send what the asker already holds.
   */
  haveFromEpoch: integer('have_from_epoch'),
  /**
   * Set when a member grants. Kept rather than deleted so a second device does
   * not re-ask for something already answered, and so "asked and never
   * answered" is distinguishable from "never asked".
   */
  grantedAt: timestamp('granted_at', { withTimezone: true }),
  /** Who granted. Informational — the bundle itself is the real artefact. */
  grantedByUserId: text('granted_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  // Members of a topic list the OPEN requests they could answer.
  topicIdx: index('key_requests_topic_idx').on(table.topicId, table.grantedAt),
  /*
   * One open request per device per topic. Without this, a screen that retries
   * on every mount turns one person's tap into a queue nobody will read to the
   * end — and the second row would tell a granting member nothing the first did
   * not already say.
   */
  oneOpenPerDevice: uniqueIndex('key_requests_one_open_idx').on(
    table.topicId,
    table.requesterDeviceId,
  ),
}));

export const takBundles = pgTable('tak_bundles', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  // Informational only (no FK): the MLS leaf credential is a device id, not the
  // user nullifier, so a sender can't supply the recipient's real user id.
  // Bundles are addressed and HPKE-sealed by `recipientDeviceId` (leaf-derived).
  recipientUserId: text('recipient_user_id').notNull(),
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
/**
 * The archive root this server holds — PUBLIC topics only.
 *
 * A public topic can be joined by anyone, so its history is not secret from the
 * public, only from the operator. Paying for that with "history is unreadable
 * unless another member is online AND has this chat room open" is a bad trade,
 * and it is the failure that was reported: with every holder offline, a new
 * member's history never arrived at all.
 *
 * Nothing about storage changes — the archive stays sealed exactly as before.
 * What changes is that a copy of the key lives here, so a later joiner reads
 * history at once.
 *
 * private, secret and DM have no row here. Their root never leaves members'
 * devices, which is what keeps "the server cannot read this" true where the
 * product says it, and they accept the documented limit (design SI-6/SI-6b):
 * with every holder gone, that archive is unreadable by anyone.
 */
export const topicArchiveRoots = pgTable('topic_archive_roots', {
  topicId: uuid('topic_id').primaryKey().references(() => topics.id, { onDelete: 'cascade' }),
  rootKey: text('root_key').notNull(), // base64 archive root — PUBLIC topics only
  depositedBy: text('deposited_by').references(() => users.id, { onUpdate: 'cascade' }).notNull(), // audit only
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const archiveHolders = pgTable('archive_holders', {
  topicId: uuid('topic_id').primaryKey().references(() => topics.id),
  holderUserId: text('holder_user_id').references(() => users.id, { onUpdate: 'cascade' }).notNull(),
  holderDeviceId: text('holder_device_id').notNull(),
  epochCovered: bigint('epoch_covered', { mode: 'number' }).notNull(), // highest epoch this holder has forward-rewrapped
  successionRank: integer('succession_rank').notNull().default(0), // owner=0, admin=1, ... (succession order)
  holderLeaseExpiresAt: timestamp('holder_lease_expires_at', { withTimezone: true }), // inactivity → single-winner succession
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/**
 * When a device JOINED a topic, and which account owns it (D-1).
 *
 * The server has no other way to know either. The ratchet tree is client-side
 * and the server runs no MLS crypto, so before this table a device only became
 * visible when it first acknowledged delivery — which is too late for two
 * things: a device added and not yet opened is owed messages it will not be
 * credited for, and an abandoned leaf cannot be told from a quiet one.
 *
 * Written from the External Commit that performs the join, which the server
 * already stores. That commit is a PublicMessage whose content is not
 * encrypted, so this is a structural read of bytes already on disk — no crypto,
 * and nothing a member can forge: the commit IS the act of joining, so claiming
 * a device joined means actually adding it. See
 * `docs/design/device-join-signal.md`.
 *
 * `leaf_identity` is the credential verbatim; `user_id` is the account derived
 * from it, and is NULL when the credential does not name one (an agent leaf
 * minted as a bare `sdk-<uuid>` before that convention). A null therefore means
 * "nobody could name this leaf", never "not looked up yet" — the distinction an
 * eviction path depends on, since guessing an owner would remove an innocent
 * member.
 *
 * Keyed by (topic, device). A device that clears its storage and re-joins mints
 * a NEW leaf key and so takes a new row rather than colliding — measured, not
 * assumed, because a collision in a fire-and-forget insert would fail silently.
 */
export const mlsDeviceJoins = pgTable('mls_device_joins', {
  topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'cascade' }).notNull(),
  deviceId: text('device_id').notNull(), // base64 leaf HPKE key — same id the cursor uses
  leafIdentity: text('leaf_identity'), // credential verbatim; NULL if unreadable
  userId: text('user_id'), // derived; NULL = unattributable, deliberately no FK
  joinedEpoch: bigint('joined_epoch', { mode: 'number' }).notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.topicId, table.deviceId] }),
  topicIdx: index('mls_device_joins_topic_idx').on(table.topicId),
}));

/**
 * Per-DEVICE delivery high-water mark, so the live copy can stop being storage.
 *
 * `chat_messages.ciphertext` is a delivery QUEUE — every mainstream messenger
 * deletes a message's ciphertext once it has been delivered — and this table is
 * what makes "delivered" answerable. One row per (topic, device), holding the
 * newest message that device has fetched.
 *
 * Per DEVICE and not per user, because a user acking on the web must not
 * release a message their phone has never seen. Chrome, Safari and the app are
 * three separate leaves with three separate key stores even on one machine, and
 * a message dropped before the phone syncs is dropped for the phone.
 *
 * `first_seen_at` is what makes a LATER joiner not owed the live copy: MLS gives
 * a newly-added leaf no past-epoch secrets, so those rows are undecryptable to
 * it whether or not the server still holds them — it reads them from
 * `chat_archive` instead. `last_seen_at` is the staleness input: a device whose
 * user cleared their browser data abandons a leaf that never acks again, and
 * without a way to stop counting it "everyone has it" would never be true and
 * nothing would ever be purged.
 *
 * `user_id` binds a device id to the account that first claimed it. The id is
 * client-supplied (it is the MLS leaf id), so without the binding one member
 * could ack on behalf of another member's device and hurry a purge along.
 */
export const chatDeliveryCursors = pgTable('chat_delivery_cursors', {
  topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'cascade' }).notNull(),
  deviceId: text('device_id').notNull(), // MLS leaf id — NOT a user id
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }).notNull(),
  // Newest message this device has fetched. INCLUSIVE: a message at exactly
  // this instant is delivered.
  deliveredThrough: timestamp('delivered_through', { withTimezone: true }).notNull(),
  // When this device first appeared in the topic. A message older than this was
  // never owed to it.
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.topicId, table.deviceId] }),
  // Supports the purge's per-topic scan over every device owed a message.
  topicIdx: index('chat_delivery_topic_idx').on(table.topicId),
}));

/**
 * How far each MEMBER has READ each conversation — an ACCOUNT-level fact.
 *
 * Distinct from `chat_delivery_cursors` above, and the two are easy to confuse
 * because both are "a high-water mark over `chat_messages.created_at`":
 *
 *   - DELIVERY is per DEVICE and answers "may the server drop its live copy".
 *     A user acking on the web must NOT release a message their phone has never
 *     fetched, so it can never be collapsed to the account.
 *   - READ is per USER and answers "does the list show a badge". Reading on the
 *     phone MUST clear the badge on the web — that is the entire point. A
 *     per-device read cursor would re-badge every other device for messages the
 *     person has already read, which is the defect this table exists to end.
 *
 * Before this table the read mark was an in-process `Map` in the mini-app
 * (`packages/mobile/src/lib/chatReadCursor.ts`), so it died on restart and never
 * crossed devices: a cold start re-badged every room not yet opened in that
 * process, and the web never had a mark at all.
 *
 * `last_read_at` is the authoritative ordering key — every count and every
 * comparison is against it. `last_read_message_id` is carried alongside so a
 * client can reproduce its own walk exactly (stop AT the recorded row, not
 * merely at its instant) when a burst shares a millisecond. It is deliberately
 * NOT a foreign key: a message can be removed, and losing the read mark because
 * the row it named is gone would resurrect a badge the user had cleared.
 *
 * SI-1: every column is metadata the server already holds. No ciphertext, no
 * plaintext, no key material — a read mark says only "this account was in this
 * room at least this far", which the delivery cursor already implies per device.
 */
export const chatReads = pgTable('chat_reads', {
  topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'cascade' }).notNull(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }).notNull(),
  // The newest row the account has seen, by server id. Informational — the
  // ordering key is `last_read_at`.
  lastReadMessageId: uuid('last_read_message_id').notNull(),
  // INCLUSIVE: a message at exactly this instant has been read.
  lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.topicId, table.userId] }),
  // The list asks "every cursor this user holds" once per page load; the PK is
  // topic-first and cannot serve it.
  userIdx: index('chat_reads_user_idx').on(table.userId),
}));

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

/**
 * INDEX of encrypted chat attachments (R-3) — the server's only handle on them.
 *
 * An attachment's object key lives inside the MLS-sealed message body, so the
 * server cannot read which object a message named. Without this table nothing
 * can ever find an attachment again: retention purges `chat_archive` rows and
 * leaves the pictures in storage forever (a deletion guarantee that is not
 * one), and an upload whose message POST never landed is stranded with nothing
 * referencing it.
 *
 * SI-1: every column here is bookkeeping the server ALREADY has. There is no
 * key material, no plaintext, no filename, no mime type, no size, and — by
 * deliberate omission — NO message id. Linking an object to the message that
 * carries it would hand the operator a map of which messages contain pictures,
 * which is exactly the metadata the sealed envelope exists to withhold. The
 * lifecycle is driven by `claimed_at` instead, which says only "the client that
 * uploaded this went on to send something".
 *
 * `uploader_id` is already the third segment of `object_key` (see
 * `chatMediaObjectKey`), so storing it adds nothing the row did not already
 * contain, and it makes the delete-authorization check a column comparison
 * rather than string surgery.
 */
export const chatMedia = pgTable('chat_media', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  // R2 object key: `chat/{topicId}/{uploaderId}/{mediaId}.bin`. Unique because
  // one object is one row — a second insert for the same key is a bug, not a
  // second attachment.
  objectKey: text('object_key').notNull(),
  uploaderId: text('uploader_id').references(() => users.id, { onUpdate: 'cascade' }).notNull(),
  // Set once the uploader's message actually went out. NULL means the upload
  // may be stranded, and after a grace window the collector takes it.
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  objectKeyIdx: uniqueIndex('chat_media_object_key_idx').on(table.objectKey),
  // Both sweeps read (topic, created_at): retention by the topic's window, and
  // the unclaimed collector by the grace window.
  topicCreatedIdx: index('chat_media_topic_created_idx').on(table.topicId, table.createdAt),
}));

// RETIRED (2026-07-30, design §7 consolidation onto API keys) — account-wide AI
// capability grant. Originally: one row per user, `cmd` (ability allowlist) +
// `history_grant` (TAK back-fill scope) applying to every `isAI` session on
// that account. Replaced by per-key scope (`api_keys.cmd`/`api_keys.history_grant`
// below) — a credential's OWN scope is now the only authority, GitHub-PAT style.
//
// This table is NO LONGER READ for authorization: `requireAiCapability` in
// `src/lib/aiPermissions.ts` consults only `session.apiKeyCmd`, and
// `PUT /api/profile/ai-permissions` has been retired to 410 (writes rejected —
// see `src/app/api/profile/ai-permissions/route.ts`). Left in place
// (deliberately not dropped) purely to preserve the historical record of what
// was configured pre-migration; nothing in the app queries it any more. Safe to
// drop in a future migration once that history is no longer needed.
export const aiPermissions = pgTable('ai_permissions', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  cmd: text('cmd').array().notNull().default([]), // ability allowlist (subset of ALLOWED_CMDS); [] = no capabilities
  historyGrant: text('history_grant').notNull().default('none'), // TAK scope: none | Nd | since_epoch:N | full (isValidTakScope)
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Durable, revocable API keys (design §7 follow-up). An agent authenticates with
// `Authorization: Bearer <rawKey>` instead of an interactive login — the key IS
// the scoped credential: its OWN `cmd`/`history_grant` gate requests directly
// (never a fresh ai_permissions profile lookup, per src/lib/session.ts +
// src/lib/aiPermissions.ts requireAiCapability). Only the SHA-256 hash of the
// raw key is ever stored (SI-1/SI-4: a DB dump never yields a usable key); the
// raw key is returned to the caller exactly once, at issuance, and is never
// logged. `key_hash` is UNIQUE so auth is a single indexed lookup, not a scan.
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }).notNull(),
  name: text('name').notNull(), // user-chosen label, e.g. "laptop CLI"
  keyHash: text('key_hash').notNull().unique(), // sha256(rawKey) hex digest — NEVER the raw key
  prefix: varchar('prefix', { length: 16 }).notNull(), // first ~12 chars of the raw key, display only
  isAI: boolean('is_ai').notNull().default(true), // sets session.isAI when authenticating with this key
  cmd: text('cmd').array().notNull().default([]), // capability allowlist bound to THIS key (subset of ALLOWED_CMDS)
  historyGrant: text('history_grant').notNull().default('none'), // TAK scope bound to this key
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }), // best-effort, bumped on successful auth
  revokedAt: timestamp('revoked_at', { withTimezone: true }), // null = active
}, (table) => ({
  userIdx: index('api_keys_user_idx').on(table.userId),
}));

export const userVerifications = pgTable('user_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }).notNull(),
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
  createdBy: text('created_by').references(() => users.id, { onUpdate: 'cascade' }).notNull(),
  usedBy: text('used_by').references(() => users.id, { onUpdate: 'cascade' }), // null until used
  usedAt: timestamp('used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tokenIdx: uniqueIndex('invite_token_idx').on(table.token),
}));

// Phase 4 key recovery (design §6.4, SI-5/SI-8). Every column here holds ONLY
// wrapped ciphertext: the server stores neither the WebAuthn PRF key nor the
// recovery code and never runs the unwrap crypto, so a DB dump yields nothing
// decryptable (SI-8 no escrow). All rows cascade-delete with the user account.

// One recovery-code-wrapped master_key per user (design §6.4.1). wrapped_master
// = AEAD(HKDF(recovery_code), master_key); recovery_code is client-CSPRNG ≥128-bit
// (SI-5) and lives only with the user.
export const keyBackups = pgTable('key_backups', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  wrappedMaster: bytea('wrapped_master').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// N passkeys per user — one prf_wrapped master_key per registered WebAuthn
// credential (design §9.5 multi-passkey; dev-plan M3 child-table split so a
// single prf_wrapped column no longer caps the user at one passkey).
export const keyBackupPasskeys = pgTable('key_backup_passkeys', {
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }).notNull(),
  credentialId: text('credential_id').notNull(),
  prfWrapped: bytea('prf_wrapped').notNull(), // AEAD(HKDF(passkey PRF output), master_key)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.credentialId] }),
}));

// The user's TAK keychain (every topic's archive root + epoch keys this user
// holds) encrypted under HKDF(master_key, "openstoa-tak-backup/v1"). Lets a
// recovered master_key re-read all archived history with no other member online
// (Option 1, design §6.4.1) — history recovery no longer depends on a live member
// re-granting TAK bundles. Server never unwraps (SI-8). One snapshot row per user.
export const takKeyBackups = pgTable('tak_key_backups', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  ciphertext: bytea('ciphertext').notNull(), // AEAD(deriveTakBackupKey(master_key), TAK-keychain JSON)
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Phase 6 push notifications — Phase A (design §13, D12/D13/D14). The server is a
// near-blind push gateway: it maps an opaque, client-generated `routing_handle`
// → OS `push_token` and NEVER puts message content in a push payload (SI-1 for
// push — the dummy body is a constant "New message"). This table holds tokens
// ONLY: no keys, no plaintext, no ciphertext. `routing_handle` is a simple
// opaque handle with NO rotation in Phase A (PRF-rotating handles + dummy
// traffic are Phase 8, §13.3). Unique on (user_id, routing_handle) so a device
// re-registering the same handle rotates its token via upsert instead of
// duplicating. Rows cascade-delete with the user account.
export const pushTokens = pgTable('push_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }).notNull(), // nullifier
  routingHandle: text('routing_handle').notNull(), // opaque, client-generated, no rotation (Phase A)
  pushToken: text('push_token').notNull(), // OS/Expo push token (no message content ever stored here)
  platform: varchar('platform', { length: 10 }).notNull(), // 'ios' | 'android'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  userHandleIdx: uniqueIndex('push_tokens_user_handle_idx').on(table.userId, table.routingHandle),
  // Supports the topic-member fan-out join (push_tokens.user_id = topic_members.user_id).
  userIdx: index('push_tokens_user_idx').on(table.userId),
}));

// Per-user GLOBAL push switch (P-M). Row-ABSENT means "notifications enabled" —
// the default is opt-OUT, so every existing user keeps receiving pushes with no
// backfill, and a row only appears once the user actually touches the setting.
// `enabled` is a preference, NOT an OS permission: the device may still be
// denied at the OS level (the client reconciles the two and offers to open the
// system settings). One row per user; cascade-deletes with the account.
export const pushPrefs = pgTable('push_prefs', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }), // nullifier
  enabled: boolean('enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Per-(user, topic) MUTE (P-S). Row-PRESENT means "this user does not want push
// for this topic" — again absence is the permissive default, so joining a topic
// never needs a preference row written. Muting is idempotent (INSERT ... ON
// CONFLICT DO NOTHING) and unmuting is a DELETE, so double-taps and concurrent
// toggles converge instead of erroring or duplicating. Rows cascade-delete with
// both the user and the topic, so a deleted topic leaves no orphan mute.
export const pushTopicMutes = pgTable('push_topic_mutes', {
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }).notNull(), // nullifier
  topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.topicId] }),
  // Supports "list every topic this user muted" (the settings/list read).
  userIdx: index('push_topic_mutes_user_idx').on(table.userId),
  // Supports the dispatch-side "is anyone in this candidate set muted here" scan.
  topicIdx: index('push_topic_mutes_topic_idx').on(table.topicId),
}));
