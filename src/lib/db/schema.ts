import { pgTable, text, uuid, boolean, timestamp, primaryKey, integer, real, varchar, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const users = pgTable('community_users', {
  id: text('id').primaryKey(), // nullifier from publicInputs
  nickname: text('nickname').unique().notNull(),
  profileImage: text('profile_image'), // URL to R2 uploaded image
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  totalRecorded: integer('total_recorded').notNull().default(0),
});

export const categories = pgTable('community_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  description: text('description'),
  icon: varchar('icon', { length: 10 }), // emoji icon
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const topics = pgTable('community_topics', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  description: text('description'),
  image: text('image'),
  creatorId: text('creator_id').references(() => users.id).notNull(),
  categoryId: uuid('category_id').references(() => categories.id),
  requiresCountryProof: boolean('requires_country_proof').default(false),
  allowedCountries: text('allowed_countries').array(),
  inviteCode: text('invite_code').unique().notNull(),
  visibility: varchar('visibility', { length: 10 }).notNull().default('public'), // 'public' | 'private' | 'secret'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  score: real('score').notNull().default(0),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow(),
});

export const topicMembers = pgTable('community_topic_members', {
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  userId: text('user_id').references(() => users.id).notNull(),
  role: varchar('role', { length: 10 }).notNull().default('member'), // 'owner' | 'admin' | 'member'
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.topicId, table.userId] }),
}));

export const joinRequests = pgTable('community_join_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  userId: text('user_id').references(() => users.id).notNull(),
  status: varchar('status', { length: 10 }).notNull().default('pending'), // 'pending' | 'approved' | 'rejected'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  reviewedBy: text('reviewed_by').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
}, (table) => ({
  uniqueRequest: uniqueIndex('community_join_request_topic_user_idx').on(table.topicId, table.userId),
}));

export const posts = pgTable('community_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  authorId: text('author_id').references(() => users.id).notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  upvoteCount: integer('upvote_count').notNull().default(0),
  viewCount: integer('view_count').notNull().default(0),
  commentCount: integer('comment_count').notNull().default(0),
  score: real('score').notNull().default(0),
  isPinned: boolean('is_pinned').notNull().default(false),
  recordCount: integer('record_count').notNull().default(0),
});

export const comments = pgTable('community_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id').references(() => posts.id).notNull(),
  authorId: text('author_id').references(() => users.id).notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const tags = pgTable('community_tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 50 }).notNull().unique(),
  slug: varchar('slug', { length: 50 }).notNull().unique(),
  postCount: integer('post_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const postTags = pgTable('community_post_tags', {
  postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }).notNull(),
  tagId: uuid('tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.postId, table.tagId] }),
}));

export const bookmarks = pgTable('community_bookmarks', {
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.postId] }),
}));

export const reactions = pgTable('community_reactions', {
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }).notNull(),
  emoji: varchar('emoji', { length: 10 }).notNull(), // e.g. '👍', '❤️', '🔥', '😂', '🎉', '😮'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.postId, table.emoji] }),
}));

export const votes = pgTable('community_votes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }),
  commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
  value: integer('value').notNull(), // +1 or -1
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  userPostVote: uniqueIndex('community_vote_user_post_idx').on(table.userId, table.postId),
  userCommentVote: uniqueIndex('community_vote_user_comment_idx').on(table.userId, table.commentId),
}));

export const records = pgTable('community_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id').references(() => posts.id).notNull(),
  recorderNullifier: text('recorder_nullifier').references(() => users.id).notNull(),
  contentHash: text('content_hash').notNull(), // keccak256 of post content at time of recording
  txHash: text('tx_hash'), // Base TX hash (null while pending)
  method: varchar('method', { length: 10 }).notNull().default('service'), // 'service' | 'direct'
  status: varchar('status', { length: 10 }).notNull().default('pending'), // 'pending' | 'confirmed' | 'failed'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  uniqueRecord: uniqueIndex('community_record_post_recorder_idx').on(table.postId, table.recorderNullifier),
  postIdx: index('community_record_post_idx').on(table.postId),
}));

export const recordLimits = pgTable('community_record_limits', {
  userId: text('user_id').references(() => users.id).notNull(),
  date: text('date').notNull(), // YYYY-MM-DD format
  count: integer('count').notNull().default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.date] }),
}));

export const chatMessages = pgTable('community_chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').references(() => topics.id).notNull(),
  userId: text('user_id').references(() => users.id).notNull(),
  message: text('message').notNull(),
  type: varchar('type', { length: 10 }).notNull().default('message'), // 'message' | 'join' | 'leave'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  topicIdx: index('community_chat_msg_topic_idx').on(table.topicId),
  topicCreatedIdx: index('community_chat_msg_topic_created_idx').on(table.topicId, table.createdAt),
}));
