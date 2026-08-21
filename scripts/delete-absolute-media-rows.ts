/**
 * Gate 1 of `docs/design/media-bucket-flip-checklist.md`: remove every stored
 * ABSOLUTE media URL, so the bucket can stop serving anonymous reads without
 * leaving rows that silently 403.
 *
 * DELETION, NOT REWRITE — and that is a product decision, not a shortcut.
 * OpenStoa has not launched. There is no user data to preserve, so a row still
 * pointing at the old raw media host is deleted outright rather than migrated
 * to `/api/media/...`. `scripts/rewrite-media-urls.ts` remains in the tree for
 * the day there IS data worth keeping; do not reach for it now.
 *
 * WHAT COUNTS AS OFFENDING. Only an absolute URL shaped like one of OUR OWN
 * object keys, on any host:
 *
 *     <scheme>://<host>[/<bucket>]/topics/<id>/(posts|image)/<uuid>/<file>
 *     <scheme>://<host>[/<bucket>]/users/<id>/(profile|uploads)/<uuid>/<file>
 *
 * Three things this deliberately does NOT match, each of which the checklist's
 * looser query WOULD have hit:
 *
 *   - A link to a topic PAGE in prose (`https://openstoa.xyz/topics/<id>`).
 *     There is no `/(posts|image)/<uuid>/<filename>` tail, so it is left alone.
 *     The looser query `content ~ '(https?://[^"]*)(/topics/|/users/)'` matches
 *     it and would have deleted a post for quoting a link. Locally both queries
 *     happen to return the same 84 rows, so this cost nothing to get right —
 *     but staging is a different corpus and the difference is a deleted post.
 *   - A genuinely external image (YouTube thumbnail, `placehold.co` fixture).
 *     Different path shape; unaffected by the bucket's policy either way.
 *   - A RELATIVE `/api/media/...` value. That is the correct post-M-6 shape and
 *     the whole point of the exercise — the app serves it, the bucket's own
 *     access policy never enters into it.
 *
 * The `[/<bucket>]` optional segment is what makes this work against local dev
 * and against R2 with one pattern: MinIO is path-style
 * (`http://10.0.0.1:9000/openstoa-dev/topics/...`), while an R2 custom domain
 * is not (`https://media.zkproofport.app/topics/...`).
 *
 * WHAT "DELETE THE ROW" MEANS PER COLUMN — these are not the same action, and
 * the difference is deliberate:
 *
 *   - `posts.content` / `posts.media.images[]` → DELETE the post row. The image
 *     IS the post's content; a post whose picture is gone is not worth keeping.
 *   - `topics.image` → `SET image = NULL`. Deleting the topic row would cascade
 *     into its posts, members, and chat history — destroying an entire
 *     community over a stale cover-photo URL. The offending VALUE is removed;
 *     the topic keeps existing, with no cover.
 *   - `users.profile_image` → `SET profile_image = NULL`. Same reasoning, more
 *     so: deleting the user row would take the account and everything it
 *     authored. The avatar goes, the account stays.
 *
 * Both of those are still deletion of the offending data, not a backfill — no
 * URL is rewritten into a working one anywhere in this script. If you want the
 * topic/user rows deleted outright instead, that is a call for a human to make
 * explicitly; this script will not do it silently.
 *
 * FOREIGN KEYS. `comments.post_id` and `records.post_id` are `NO ACTION`, not
 * `CASCADE` — a bare `DELETE FROM posts` aborts on any post that has either.
 * They are removed first, in the same transaction. (`bookmarks`, `polls`,
 * `post_tags`, `reactions`, `votes` are all `CASCADE` and need no help;
 * `votes.comment_id` cascades from the comment delete.)
 *
 * ORPHANED OBJECTS. Deleting the row does not delete the object in R2/MinIO.
 * That is fine and intended: post-flip the bucket is private, so an object no
 * row references is unreachable to everyone. Reclaiming the bytes is the
 * unclaimed-media sweep's job, not this script's.
 *
 * Idempotent: a second run matches nothing and changes nothing.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/delete-absolute-media-rows.ts            # dry run
 *   DATABASE_URL=... npx tsx scripts/delete-absolute-media-rows.ts --apply    # writes
 *
 * Run it BEFORE removing the bucket's anonymous access, not after: doing it
 * after means those images are already 403ing while you work.
 */
import { Pool, type PoolClient } from 'pg';

/**
 * POSIX ERE (Postgres `~`), not a JS regex — the matching happens in the
 * database so a 2,500-row table never crosses the wire.
 *
 * `[^"'' <>]` excludes the delimiters an `<img src>` or a JSON string can end
 * on, so a match stops at the URL's real boundary instead of swallowing the
 * rest of the document. Doubled `''` is SQL string escaping, applied at the
 * call site; this constant holds a single quote.
 */
function absoluteMediaUrlRe(hostPattern: string): string {
  return (
    `https?://${hostPattern}/(topics/[^/"' <>]+/(posts|image)|users/[^/"' <>]+/(profile|uploads))/` +
    `[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[^"' <>]+`
  );
}

/**
 * Host-agnostic by default: `[^"' <>]*` spans the host and MinIO's optional
 * path-style bucket segment alike, so one invocation cleans any environment
 * without the operator having to know its media hostname.
 *
 * The cost of that generality is one narrow false positive: a genuinely
 * EXTERNAL url that happens to copy our key shape — `https://media.zkproofport
 * .app.evil.example/topics/<uuid>/posts/<uuid>/a.png` — matches, and the post
 * quoting it would be deleted. Vanishingly unlikely, and the safe direction to
 * err in for a pre-launch cleanup, but it is a real gap in the checklist's own
 * wording ("under our own (former) media host").
 *
 * MEDIA_HOST closes it. Set it to the environment's actual media host and only
 * that host matches:
 *
 *   MEDIA_HOST=media.zkproofport.app        # production R2 custom domain
 *   MEDIA_HOST='10.78.14.37:9000/openstoa-dev'  # local MinIO, incl. bucket
 *
 * The value is escaped as a literal, so `.` matches a dot and nothing else —
 * which is precisely what defeats the lookalike domain above.
 */
function resolveMediaUrlRe(): { re: string; scope: string } {
  const host = process.env.MEDIA_HOST?.trim();
  if (!host) return { re: absoluteMediaUrlRe(`[^"' <>]*`), scope: 'ANY host (set MEDIA_HOST to narrow)' };
  // Escape every POSIX ERE metacharacter, so the host is matched literally.
  const literal = host.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&');
  return { re: absoluteMediaUrlRe(literal), scope: `host=${host}` };
}

const { re: ABSOLUTE_MEDIA_URL_RE, scope: MATCH_SCOPE } = resolveMediaUrlRe();

/** Every column this script inspects, for the report. */
const COLUMNS = [
  { label: 'posts.content', sql: 'SELECT count(*)::int AS n FROM posts WHERE content ~ $1' },
  { label: 'posts.media.images[]', sql: 'SELECT count(*)::int AS n FROM posts WHERE media::text ~ $1' },
  { label: 'topics.image', sql: 'SELECT count(*)::int AS n FROM topics WHERE image ~ $1' },
  { label: 'users.profile_image', sql: 'SELECT count(*)::int AS n FROM users WHERE profile_image ~ $1' },
] as const;

async function report(client: PoolClient): Promise<void> {
  for (const col of COLUMNS) {
    const { rows } = await client.query<{ n: number }>(col.sql, [ABSOLUTE_MEDIA_URL_RE]);
    console.log(`  ${col.label.padEnd(22)} ${rows[0].n}`);
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL environment variable is required');

  const APPLY = process.argv.includes('--apply');
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    console.log(`[delete-absolute-media-rows] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} match=${MATCH_SCOPE}`);
    console.log('[delete-absolute-media-rows] offending rows BEFORE:');
    await report(client);

    // One transaction: either every offending row goes, or none does. Unlike
    // the rewrite script's row-by-row commits, a half-finished delete has no
    // self-healing property worth preserving — it just leaves an unknown
    // fraction of the exposure in place.
    await client.query('BEGIN');

    const { rows: targets } = await client.query<{ id: string }>(
      'SELECT id FROM posts WHERE content ~ $1 OR media::text ~ $1',
      [ABSOLUTE_MEDIA_URL_RE],
    );
    const postIds = targets.map((r) => r.id);
    console.log(`[delete-absolute-media-rows] posts to delete: ${postIds.length}`);

    let deletedComments = 0;
    let deletedRecords = 0;
    let deletedPosts = 0;
    if (postIds.length > 0) {
      // NO ACTION foreign keys — must go first or the post delete aborts.
      deletedComments = (await client.query('DELETE FROM comments WHERE post_id = ANY($1::uuid[])', [postIds]))
        .rowCount ?? 0;
      deletedRecords = (await client.query('DELETE FROM records WHERE post_id = ANY($1::uuid[])', [postIds]))
        .rowCount ?? 0;
      deletedPosts = (await client.query('DELETE FROM posts WHERE id = ANY($1::uuid[])', [postIds])).rowCount ?? 0;
    }
    console.log(
      `[delete-absolute-media-rows]   cascade-first: ${deletedComments} comments, ${deletedRecords} records`,
    );

    // Value-level deletion — see the header for why these two are not row deletes.
    const clearedTopics =
      (await client.query('UPDATE topics SET image = NULL WHERE image ~ $1', [ABSOLUTE_MEDIA_URL_RE])).rowCount ?? 0;
    const clearedUsers =
      (await client.query('UPDATE users SET profile_image = NULL WHERE profile_image ~ $1', [ABSOLUTE_MEDIA_URL_RE]))
        .rowCount ?? 0;
    console.log(`[delete-absolute-media-rows] topics.image cleared: ${clearedTopics}`);
    console.log(`[delete-absolute-media-rows] users.profile_image cleared: ${clearedUsers}`);

    if (APPLY) {
      await client.query('COMMIT');
      console.log(`[delete-absolute-media-rows] COMMITTED — ${deletedPosts} posts deleted`);
      console.log('[delete-absolute-media-rows] offending rows AFTER:');
      await report(client);
    } else {
      await client.query('ROLLBACK');
      console.log(`[delete-absolute-media-rows] DRY-RUN rolled back — would delete ${deletedPosts} posts.`);
      console.log('[delete-absolute-media-rows] pass --apply to write these changes.');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[delete-absolute-media-rows] failed:', err);
  process.exit(1);
});
