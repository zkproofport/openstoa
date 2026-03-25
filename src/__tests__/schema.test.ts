import { describe, it, expect } from 'vitest';
import * as schema from '@/lib/db/schema';
import { getTableName } from 'drizzle-orm';

describe('schema: exports', () => {
  it('should export all tables', () => {
    expect(schema.users).toBeDefined();
    expect(schema.topics).toBeDefined();
    expect(schema.topicMembers).toBeDefined();
    expect(schema.posts).toBeDefined();
    expect(schema.comments).toBeDefined();
    expect(schema.tags).toBeDefined();
    expect(schema.postTags).toBeDefined();
    expect(schema.bookmarks).toBeDefined();
    expect(schema.votes).toBeDefined();
  });
});

describe('schema: table names', () => {
  it('should have correct names for core tables', () => {
    expect(getTableName(schema.users)).toBe('users');
    expect(getTableName(schema.topics)).toBe('topics');
    expect(getTableName(schema.topicMembers)).toBe('topic_members');
    expect(getTableName(schema.posts)).toBe('posts');
    expect(getTableName(schema.comments)).toBe('comments');
  });

  it('should have correct names for SNS tables', () => {
    expect(getTableName(schema.tags)).toBe('tags');
    expect(getTableName(schema.postTags)).toBe('post_tags');
    expect(getTableName(schema.bookmarks)).toBe('bookmarks');
    expect(getTableName(schema.votes)).toBe('votes');
  });
});

describe('schema: posts table columns', () => {
  it('should have SNS engagement columns', () => {
    const cols = schema.posts;
    expect(cols.upvoteCount).toBeDefined();
    expect(cols.viewCount).toBeDefined();
    expect(cols.commentCount).toBeDefined();
    expect(cols.score).toBeDefined();
  });

  it('should have base post columns', () => {
    const cols = schema.posts;
    expect(cols.id).toBeDefined();
    expect(cols.topicId).toBeDefined();
    expect(cols.authorId).toBeDefined();
    expect(cols.title).toBeDefined();
    expect(cols.content).toBeDefined();
    expect(cols.createdAt).toBeDefined();
    expect(cols.updatedAt).toBeDefined();
  });
});

describe('schema: tags table columns', () => {
  it('should have name, slug, and postCount columns', () => {
    const cols = schema.tags;
    expect(cols.name).toBeDefined();
    expect(cols.slug).toBeDefined();
    expect(cols.postCount).toBeDefined();
  });
});

describe('schema: postTags table columns', () => {
  it('should have postId and tagId columns', () => {
    const cols = schema.postTags;
    expect(cols.postId).toBeDefined();
    expect(cols.tagId).toBeDefined();
  });
});

describe('schema: bookmarks table columns', () => {
  it('should have userId and postId columns', () => {
    const cols = schema.bookmarks;
    expect(cols.userId).toBeDefined();
    expect(cols.postId).toBeDefined();
  });
});

describe('schema: votes table columns', () => {
  it('should have userId, postId, commentId, and value columns', () => {
    const cols = schema.votes;
    expect(cols.userId).toBeDefined();
    expect(cols.postId).toBeDefined();
    expect(cols.commentId).toBeDefined();
    expect(cols.value).toBeDefined();
  });
});
