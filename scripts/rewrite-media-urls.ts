/**
 * One-time rewrite of stored plaintext image URLs from the OLD raw R2 domain
 * to the NEW gated `/api/media` route (M-5), so the R2 bucket's public access
 * can be removed without breaking every post, topic cover, and avatar minted
 * before the gate existed.
 *
 * Why this has to run BEFORE the bucket flip, not after: `uploadToR2` mints
 * URLs as `${R2_PUBLIC_URL}/${key}` (see `src/lib/r2.ts`) and needs NO code
 * change once `R2_PUBLIC_URL` itself points at the new route's base — but
 * that only fixes NEW uploads from that moment on. Every row written before
 * the flip still holds the OLD literal domain, in four places:
 *   - `posts.content`       — inline `<img src="OLD/topics/...">`
 *   - `posts.media`         — `{ images: ["OLD/topics/..."] }`
 *   - `topics.image`        — the topic's cover picture URL
 *   - `users.profile_image` — the user's avatar URL
 * This script replaces the OLD base with the NEW one, literally, everywhere
 * it appears in those four columns. It does NOT touch anything else (video
 * URLs, external image hosts, GIF-picker URLs) — those never had the OLD
 * prefix, so a literal string replace leaves them untouched by construction.
 *
 * Idempotent: a second run finds nothing left containing the OLD base and
 * changes zero rows.
 *
 * Ordering with the bucket flip:
 *   1. Deploy this route + the R2.ts helpers (already safe: R2_PUBLIC_URL is
 *      unchanged, so nothing behaves differently yet).
 *   2. Run this script with `--apply` against the target DB (staging, then
 *      production). Existing image URLs now point at `NEW_R2_PUBLIC_URL`,
 *      which — because the bucket is STILL public at this point — continues
 *      to work whether or not the new route is even deployed there yet.
 *   3. Flip `R2_PUBLIC_URL` to `NEW_R2_PUBLIC_URL` (so NEW uploads mint the
 *      same base) and remove the bucket's public access / R2.dev binding.
 * Steps 2 and 3 can be swapped in order for a bucket that is still public —
 * what must NOT happen is removing public access before step 2 completes.
 *
 * Usage:
 *   DATABASE_URL=... OLD_R2_PUBLIC_URL=https://media.zkproofport.app \
 *     NEW_R2_PUBLIC_URL=https://openstoa.xyz/api/media \
 *     npx tsx scripts/rewrite-media-urls.ts              # dry run, prints counts only
 *   ... --apply                                           # actually writes
 */
import { Pool } from 'pg';

/**
 * Only these two anchors follow `R2_PUBLIC_URL` in a URL this app ever minted
 * (`uploadObjectKey`'s two roots — see `src/lib/r2.ts`). Anchoring the match
 * on `oldBase + anchor` rather than on bare `oldBase` matters because these
 * columns hold user-authored text too (`posts.content`): a comment that
 * merely MENTIONS the CDN domain as prose, or a domain that happens to have
 * ours as a prefix (`media.zkproofport.app.evil.example`), must not be
 * rewritten into a broken URL. A real object URL is always
 * `${oldBase}/topics/…` or `${oldBase}/users/…`, so requiring the anchor is
 * exactly as permissive as it needs to be and no more.
 */
const KEY_ROOT_ANCHORS = ['/topics/', '/users/'] as const;

/** Literal (never regex) replace of `oldBase` with `newBase`, anchored — see above. */
export function rewriteUrl(value: string, oldBase: string, newBase: string): { next: string; count: number } {
  if (!oldBase) return { next: value, count: 0 };
  let next = value;
  let count = 0;
  for (const anchor of KEY_ROOT_ANCHORS) {
    const needle = oldBase + anchor;
    if (!next.includes(needle)) continue;
    const parts = next.split(needle);
    count += parts.length - 1;
    next = parts.join(newBase + anchor);
  }
  return { next, count };
}

export function rewriteMediaImages(
  images: readonly string[] | undefined,
  oldBase: string,
  newBase: string,
): { next: string[] | undefined; count: number } {
  if (!images || images.length === 0) return { next: images as string[] | undefined, count: 0 };
  let count = 0;
  const next = images.map((u) => {
    const r = rewriteUrl(u, oldBase, newBase);
    count += r.count;
    return r.next;
  });
  return { next, count };
}

interface PostMedia {
  images?: string[];
  videos?: string[];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL environment variable is required');
  const oldBase = process.env.OLD_R2_PUBLIC_URL;
  if (!oldBase) throw new Error('OLD_R2_PUBLIC_URL environment variable is required');
  const newBase = process.env.NEW_R2_PUBLIC_URL;
  if (!newBase) throw new Error('NEW_R2_PUBLIC_URL environment variable is required');
  if (oldBase === newBase) throw new Error('OLD_R2_PUBLIC_URL and NEW_R2_PUBLIC_URL must differ');

  const APPLY = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: url });
  try {
    console.log(`[rewrite-media-urls] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} old=${oldBase} new=${newBase}`);

    // --- posts.content + posts.media ---------------------------------
    const postRows = await pool.query<{ id: string; content: string; media: PostMedia | null }>(
      `SELECT id, content, media FROM posts WHERE content LIKE $1 OR media::text LIKE $1`,
      [`%${oldBase}%`],
    );
    let postsChanged = 0;
    let postHits = 0;
    for (const row of postRows.rows) {
      const contentR = rewriteUrl(row.content, oldBase, newBase);
      const mediaR = rewriteMediaImages(row.media?.images, oldBase, newBase);
      const hits = contentR.count + mediaR.count;
      if (hits === 0) continue;
      postsChanged++;
      postHits += hits;
      if (APPLY) {
        const nextMedia: PostMedia | null = row.media ? { ...row.media, images: mediaR.next } : row.media;
        await pool.query('UPDATE posts SET content = $1, media = $2 WHERE id = $3', [
          contentR.next,
          nextMedia ? JSON.stringify(nextMedia) : null,
          row.id,
        ]);
      }
    }
    console.log(`[rewrite-media-urls] posts: ${postsChanged} rows changed, ${postHits} URL occurrences`);

    // --- topics.image ---------------------------------------------------
    const topicRows = await pool.query<{ id: string; image: string }>(
      'SELECT id, image FROM topics WHERE image LIKE $1',
      [`%${oldBase}%`],
    );
    let topicsChanged = 0;
    for (const row of topicRows.rows) {
      const r = rewriteUrl(row.image, oldBase, newBase);
      if (r.count === 0) continue;
      topicsChanged++;
      if (APPLY) await pool.query('UPDATE topics SET image = $1 WHERE id = $2', [r.next, row.id]);
    }
    console.log(`[rewrite-media-urls] topics: ${topicsChanged} rows changed`);

    // --- users.profile_image ---------------------------------------------
    const userRows = await pool.query<{ id: string; profile_image: string }>(
      'SELECT id, profile_image FROM users WHERE profile_image LIKE $1',
      [`%${oldBase}%`],
    );
    let usersChanged = 0;
    for (const row of userRows.rows) {
      const r = rewriteUrl(row.profile_image, oldBase, newBase);
      if (r.count === 0) continue;
      usersChanged++;
      if (APPLY) await pool.query('UPDATE users SET profile_image = $1 WHERE id = $2', [r.next, row.id]);
    }
    console.log(`[rewrite-media-urls] users: ${usersChanged} rows changed`);

    if (!APPLY) {
      console.log('[rewrite-media-urls] DRY-RUN complete — pass --apply to write these changes.');
    }
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('rewrite-media-urls.ts')) {
  main().catch((err) => {
    console.error('[rewrite-media-urls] failed:', err);
    process.exit(1);
  });
}
