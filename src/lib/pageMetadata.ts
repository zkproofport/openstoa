/**
 * Per-post and per-topic Open Graph / Twitter Card metadata.
 *
 * Split into PURE builders (`metadataFromPostRow`, `metadataFromTopicRow`,
 * `genericMetadata`, and the text helpers below) and thin DB-touching
 * wrappers (`buildPostMetadata`, `buildTopicMetadata`) on purpose: the pure
 * half is unit-testable with plain objects and zero mocking, which this
 * codebase prefers (`CLAUDE.md`: a lenient DB mock is worse than no mock).
 * The DB half is exercised for real by the E2E suite
 * (`src/__tests__/e2e/page-metadata.test.ts`), which is the only place a
 * mocked Postgres row would matter anyway.
 *
 * SECURITY POSTURE — never distinguish "doesn't exist" from "exists but you
 * can't see it" in the response. `genericMetadata` is the single fallback for
 * every non-public case (not found, invalid id, private/secret post, secret
 * topic, soft-deleted post, a DB error mid-lookup) so a crawler — which is
 * always treated as a signed-out guest, session or not — can never use
 * metadata text to enumerate which UUIDs exist. This mirrors
 * `GET /api/posts/{postId}`'s own guest branch (only `topicVisibility ===
 * 'public'` is served) and `GET /api/topics/{topicId}`'s guest branch (secret
 * → 404, private/public → real data) — metadata never shows a crawler more
 * than the corresponding API already would.
 */
import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { posts, topics } from '@/lib/db/schema';
import { isValidUUID } from '@/lib/uuid';
import { collectPostMedia } from '@/lib/postMedia';
import { logger } from '@/lib/logger';

const MODULE = 'lib/pageMetadata';

export const SITE_NAME = 'OpenStoa';
const SITE_DESCRIPTION =
  'ZK-gated community where humans and AI agents coexist. Prove your identity via zero-knowledge proofs — without revealing personal information.';
/** Same asset `layout.tsx` uses for the site-wide default — kept relative
 *  here too and absolutized against the REQUEST's origin, not `metadataBase`,
 *  so it resolves correctly on whichever of the two live hosts served it. */
const DEFAULT_IMAGE_PATH = '/images/openstoa-logo-transparent-640.png';

/** Grapheme, not code-unit, ceilings — see `truncateGraphemes`. Chosen to sit
 *  comfortably inside what Facebook/Twitter/Slack unfurlers actually render
 *  before clipping their own card, with headroom for the `%s | OpenStoa`
 *  title template appended by the root layout. */
const MAX_TITLE_GRAPHEMES = 100;
const MAX_DESCRIPTION_GRAPHEMES = 200;

// ─── Text helpers ───────────────────────────────────────────────────────────

/**
 * Truncate by GRAPHEME CLUSTER, not `.slice()` — `.slice(0, n)` on a string
 * containing a multi-code-unit emoji (e.g. a ZWJ family emoji) or certain
 * combining sequences can split it mid-cluster, producing a mangled trailing
 * character. `Intl.Segmenter` (Node 22, this app's runtime — see the
 * Dockerfile) is grapheme-aware; the `Array.from` fallback is at least
 * code-point-safe (never splits a surrogate pair) if `Segmenter` is ever
 * unavailable in a test runner.
 */
export function truncateGraphemes(text: string, maxLength: number, ellipsis = '…'): string {
  if (!text) return text;
  const SegmenterCtor = (Intl as unknown as { Segmenter?: new (locale: string, opts: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  const units: string[] = SegmenterCtor
    ? Array.from(new SegmenterCtor('en', { granularity: 'grapheme' }).segment(text), (s) => s.segment)
    : Array.from(text);
  if (units.length <= maxLength) return text;
  return units.slice(0, maxLength).join('') + ellipsis;
}

/** Strips control characters (including NUL — see `hasNulByte`'s reasoning
 *  in `textGuard.ts`; a meta tag has even less business holding one than a
 *  DB row does) and collapses all whitespace runs, including newlines, to a
 *  single space — a multi-line body must not produce a multi-line preview
 *  card description. */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g;

export function sanitizeForMeta(text: string): string {
  return text
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** Rough HTML→text for the description field only — never used to render
 *  markup, only to produce plain preview text, so it does not need to be a
 *  real parser. Tags are stripped THEN entities decoded, so `&lt;script&gt;`
 *  in a hostile post body degrades to literal `<script>` TEXT inside an
 *  attribute value (which Next/React escapes on the way out — see below),
 *  never to a live tag. */
export function htmlToPlainText(html: string): string {
  const noTags = html.replace(/<[^>]*>/g, ' ');
  const decoded = noTags.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => HTML_ENTITY_MAP[m]);
  return sanitizeForMeta(decoded);
}

/**
 * Resolve a stored media URL to an ABSOLUTE `http(s)` URL, or `null` if it
 * cannot be. Deliberately fail-closed rather than "leave as-is" (contrast
 * `packages/mobile/src/utils/absolutizeMediaUrl.ts`, which is allowed to pass
 * an unresolvable shape through unchanged for an `<Image>` `uri` prop): an
 * `og:image` that isn't a real absolute URL is worse than no `og:image`, so a
 * `null` here means "try the next candidate in the fallback chain," never
 * "emit this anyway."
 *
 * Handles exactly the two shapes this app's own data ever contains — already
 * absolute (`https://...`, pre-M-6 rows or external images) and root-relative
 * (`/api/media/...`, post-M-6) — and rejects everything else (`data:`,
 * protocol-relative `//`, a bare relative path with no leading slash): none
 * of those are shapes `posts.media` / `topics.image` are ever written in, so
 * treating them as "maybe fine" would be guessing at an unknown format rather
 * than handling a real one.
 */
export function toAbsoluteImageUrl(url: string | null | undefined, origin: string): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  // MUST be checked before the root-relative branch below: `//host/path`
  // also starts with a single `/`, and `${origin}//host/path` is a
  // malformed URL (the `//host` becomes literal PATH, not a new host) —
  // silently minting that instead of rejecting it is exactly the kind of
  // "emit it anyway" this function's contract forbids.
  if (url.startsWith('//')) return null;
  if (url.startsWith('/')) return `${origin}${url}`;
  return null;
}

function defaultImage(origin: string): { url: string; alt: string } {
  return { url: `${origin}${DEFAULT_IMAGE_PATH}`, alt: SITE_NAME };
}

// ─── Generic (non-leaking) fallback ─────────────────────────────────────────

/**
 * The ONE fallback for every case that must not distinguish itself from any
 * other on-purpose (see the module doc's SECURITY POSTURE note). `url` is
 * still the real, requested URL — that leaks nothing a crawler didn't already
 * have by fetching it in the first place — but title/description/image are
 * always the generic site defaults, never anything derived from the row.
 */
export function genericMetadata(origin: string, url: string): Metadata {
  const image = defaultImage(origin);
  return {
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title: SITE_NAME,
      description: SITE_DESCRIPTION,
      url,
      images: [{ url: image.url, width: 640, height: 640, alt: image.alt }],
    },
    twitter: {
      card: 'summary',
      title: SITE_NAME,
      description: SITE_DESCRIPTION,
      images: [image.url],
    },
  };
}

// ─── Post metadata ───────────────────────────────────────────────────────────

export interface PostMetadataRow {
  id: string;
  topicId: string;
  title: string | null;
  content: string | null;
  media: { images?: string[]; videos?: string[]; imageAlts?: Record<string, string> } | null;
  isDeleted: boolean | null;
  topicTitle: string | null;
  topicVisibility: string | null;
  topicImage: string | null;
}

/**
 * Pure builder — takes the ROUTE's `topicId`/`postId` (so the canonical URL
 * is always correct even when `row` is null) plus whatever the DB returned
 * (or `null` for not-found), and never touches the network.
 */
export function metadataFromPostRow(
  routeTopicId: string,
  postId: string,
  row: PostMetadataRow | null,
  origin: string,
): Metadata {
  // The URL's topicId segment is cosmetic — the page itself resolves the
  // post by `postId` alone (`GET /api/posts/{postId}`) — so once we have the
  // real row, prefer ITS topicId for the canonical URL over whatever the
  // caller happened to put in the address bar.
  const url = `${origin}/topics/${row?.topicId ?? routeTopicId}/posts/${postId}`;

  // Only a public-topic, non-deleted post gets real metadata — exactly the
  // set `GET /api/posts/{postId}` would serve to a guest. Everything else
  // (no row, private/secret topic, soft-deleted) collapses to the identical
  // generic fallback so none of those states can be told apart from outside.
  if (!row || row.topicVisibility !== 'public' || row.isDeleted) {
    return genericMetadata(origin, url);
  }

  const cleanTitle = sanitizeForMeta(row.title ?? '');
  const title = cleanTitle ? truncateGraphemes(cleanTitle, MAX_TITLE_GRAPHEMES) : 'Untitled post';

  const plainBody = htmlToPlainText(row.content ?? '');
  const topicTitle = row.topicTitle ? sanitizeForMeta(row.topicTitle) : null;
  const description = plainBody
    ? truncateGraphemes(plainBody, MAX_DESCRIPTION_GRAPHEMES)
    : topicTitle
      ? `A post in ${topicTitle}`
      : SITE_DESCRIPTION;

  const media = collectPostMedia({ content: row.content ?? '', media: row.media });
  const candidate = media.images[0] ?? row.topicImage ?? null;
  const resolvedImage = toAbsoluteImageUrl(candidate, origin);
  const image = resolvedImage
    ? { url: resolvedImage, alt: title }
    : defaultImage(origin);

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      siteName: SITE_NAME,
      title,
      description,
      url,
      images: [{ url: image.url, alt: image.alt }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image.url],
    },
  };
}

/**
 * Fetches the row and builds metadata. Never throws: an unavailable DB (or
 * any other failure mid-lookup) degrades to the same generic fallback used
 * for "not found" — a metadata failure must not 500 the page, and a caller
 * genuinely cannot tell a DB outage apart from "this post is private" from
 * outside, which is an acceptable ambiguity here (the page body's own fetch
 * will surface a real error to the human visitor either way).
 */
export async function buildPostMetadata(topicId: string, postId: string, origin: string): Promise<Metadata> {
  const fallbackUrl = `${origin}/topics/${topicId}/posts/${postId}`;
  if (!isValidUUID(postId)) return genericMetadata(origin, fallbackUrl);

  try {
    const rows = await db
      .select({
        id: posts.id,
        topicId: posts.topicId,
        title: posts.title,
        content: posts.content,
        media: posts.media,
        isDeleted: posts.isDeleted,
        topicTitle: topics.title,
        topicVisibility: topics.visibility,
        topicImage: topics.image,
      })
      .from(posts)
      .leftJoin(topics, eq(posts.topicId, topics.id))
      .where(eq(posts.id, postId))
      .limit(1);
    return metadataFromPostRow(topicId, postId, rows[0] ?? null, origin);
  } catch (error) {
    logger.error(MODULE, 'Post metadata DB lookup failed — serving generic fallback', {
      postId,
      error: error instanceof Error ? error.message : String(error),
    });
    return genericMetadata(origin, fallbackUrl);
  }
}

// ─── Topic metadata ──────────────────────────────────────────────────────────

export interface TopicMetadataRow {
  id: string;
  title: string | null;
  description: string | null;
  image: string | null;
  visibility: string | null;
}

/**
 * Pure builder. Unlike posts, `private` topics DO get real metadata —
 * mirroring `GET /api/topics/{topicId}`'s own guest branch, which shows a
 * private topic's title/description/image to a signed-out caller and only
 * refuses `secret` (404). A `blindedAt` topic is deliberately NOT filtered
 * here either, for the same reason: the detail API doesn't gate on it, so a
 * direct link to a blinded topic still resolves for a human visitor — only
 * the SITEMAP (a discovery surface, matching `/api/topics` and `/api/feed`,
 * which DO filter blinded topics out of listings) excludes it.
 */
export function metadataFromTopicRow(
  routeTopicId: string,
  row: TopicMetadataRow | null,
  origin: string,
): Metadata {
  const url = `${origin}/topics/${row?.id ?? routeTopicId}`;

  if (!row || row.visibility === 'secret') {
    return genericMetadata(origin, url);
  }

  const cleanTitle = sanitizeForMeta(row.title ?? '');
  const title = cleanTitle ? truncateGraphemes(cleanTitle, MAX_TITLE_GRAPHEMES) : 'Untitled topic';

  const cleanDescription = row.description ? sanitizeForMeta(row.description) : '';
  const description = cleanDescription
    ? truncateGraphemes(cleanDescription, MAX_DESCRIPTION_GRAPHEMES)
    : `A topic on ${SITE_NAME}`;

  const resolvedImage = toAbsoluteImageUrl(row.image, origin);
  const image = resolvedImage ? { url: resolvedImage, alt: title } : defaultImage(origin);

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title,
      description,
      url,
      images: [{ url: image.url, alt: image.alt }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image.url],
    },
  };
}

export async function buildTopicMetadata(topicId: string, origin: string): Promise<Metadata> {
  const fallbackUrl = `${origin}/topics/${topicId}`;
  if (!isValidUUID(topicId)) return genericMetadata(origin, fallbackUrl);

  try {
    const row = await db.query.topics.findFirst({
      where: eq(topics.id, topicId),
      columns: { id: true, title: true, description: true, image: true, visibility: true },
    });
    return metadataFromTopicRow(topicId, row ?? null, origin);
  } catch (error) {
    logger.error(MODULE, 'Topic metadata DB lookup failed — serving generic fallback', {
      topicId,
      error: error instanceof Error ? error.message : String(error),
    });
    return genericMetadata(origin, fallbackUrl);
  }
}
