/**
 * Deleting an account has to finish, or leave nothing behind.
 *
 * In production on 2026-08-29 it did neither. The handler deleted the person's
 * membership row, then tried to delete their personal space, and the space
 * refused to go because chat rows still pointed at it. Nothing was wrapped in a
 * transaction, so the membership stayed deleted: the account owned a space it
 * was not a member of, every retry failed the same way, and the person could
 * not leave.
 *
 * Two separate defects, so two separate things are pinned here:
 *
 *   - the space's own rows are cleared before the space, using the SAME order
 *     as topic deletion, because keeping two copies of that order is what broke
 *     this in the first place;
 *   - and the whole thing is one transaction, so a failure anywhere leaves the
 *     account exactly as it was.
 *
 * The third test is the one that survives the next schema change: it reads the
 * foreign keys out of the schema file and fails when a table starts pointing at
 * `topics` without cascading and without being listed in the shared order. That
 * is the actual failure mode — twice now — and no amount of care at the call
 * sites prevents it.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { deleteTopicRows, type TopicRowDeleter } from '@/lib/deleteTopicRows';

/** Records which tables were deleted from, in order. */
function recordingTx(opts: { posts?: Array<{ id: string }>; failOn?: string } = {}) {
  const order: string[] = [];
  const nameOf = (table: unknown): string => {
    const sym = Object.getOwnPropertySymbols(table as object)
      .find((s) => String(s).includes('Name') || String(s).includes('OriginalName'));
    const raw = sym ? (table as Record<symbol, unknown>)[sym] : undefined;
    return typeof raw === 'string' ? raw : 'unknown';
  };
  const tx: TopicRowDeleter = {
    delete: (table: unknown) => {
      const name = nameOf(table);
      return {
        where: async () => {
          order.push(name);
          if (opts.failOn === name) throw new Error(`foreign key violation on ${name}`);
          return undefined;
        },
      };
    },
    select: () => ({
      from: () => ({ where: async () => opts.posts ?? [] }),
    }),
  };
  return { tx, order };
}

describe('deleting an account must not half-dismantle it', () => {
  it('clears the chat rows that hold a topic down, not just the members', async () => {
    const { tx, order } = recordingTx();
    await deleteTopicRows(tx, 'space-1');

    /*
     * These are the tables that reference `topics` with NO ACTION. Any one of
     * them left behind makes `delete(topics)` fail with a foreign-key
     * violation, which is exactly what happened in production.
     */
    for (const table of [
      'chat_messages',
      'chat_media',
      'chat_archive',
      'archive_holders',
      'tak_bundles',
      'key_requests',
      'mls_commits',
      'mls_groups',
      'join_requests',
      'topic_members',
    ]) {
      expect(order, `${table} was never cleared`).toContain(table);
    }
  });

  it('clears a commit before the group it advanced, and posts before nothing points at them', async () => {
    const { tx, order } = recordingTx({ posts: [{ id: 'p1' }] });
    await deleteTopicRows(tx, 'space-1');

    expect(order.indexOf('mls_commits')).toBeLessThan(order.indexOf('mls_groups'));
    expect(order.indexOf('comments')).toBeLessThan(order.indexOf('posts'));
    expect(order.indexOf('records')).toBeLessThan(order.indexOf('posts'));
  });

  it('does not touch posts when the room has none', async () => {
    const { tx, order } = recordingTx({ posts: [] });
    await deleteTopicRows(tx, 'space-1');
    expect(order).not.toContain('posts');
    expect(order).not.toContain('comments');
  });

  it('lets a failure escape so the caller\'s transaction can roll back', async () => {
    const { tx } = recordingTx({ failOn: 'mls_groups' });
    await expect(deleteTopicRows(tx, 'space-1')).rejects.toThrow(/foreign key violation/);
  });

  it('every non-cascading foreign key into topics is in the shared order', () => {
    const schema = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/db/schema.ts'),
      'utf8',
    );
    const shared = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/deleteTopicRows.ts'),
      'utf8',
    );

    /*
     * Every `.references(() => topics.id ...)` in the schema, with whatever
     * followed it on the same call — `onDelete: 'cascade'` or nothing. A table
     * that cascades needs no entry; one that does not must appear in the shared
     * order or the delete will fail at runtime.
     */
    const refs = [...schema.matchAll(
      /(\w+):[^\n]*\.references\(\(\) => topics\.id([^)]*)\)/g,
    )];
    expect(refs.length, 'no references to topics found — the pattern went stale')
      .toBeGreaterThan(5);

    // Which drizzle table object each column belongs to, by walking backwards
    // to the nearest `export const x = pgTable('name'`.
    const tableAt = (index: number): string => {
      const before = schema.slice(0, index);
      const m = [...before.matchAll(/pgTable\(\s*'([a-z_]+)'/g)].pop();
      return m ? m[1] : 'unknown';
    };

    const missing: string[] = [];
    for (const ref of refs) {
      const cascades = /onDelete:\s*'cascade'/.test(ref[2] ?? '');
      if (cascades) continue;
      const table = tableAt(ref.index ?? 0);
      if (table === 'unknown') continue;
      // The shared order names tables through their drizzle identifiers, so
      // look for the snake_case table name in its comment-free body OR the
      // camelCase identifier. Both appear; either is proof it is handled.
      const camel = table.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (!shared.includes(camel) && !shared.includes(table)) missing.push(table);
    }

    expect(
      missing,
      `these tables point at topics without cascading and are not cleared in deleteTopicRows: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
