import type { MetadataRoute } from 'next';
import { db } from '@/lib/db';
import { topics, posts } from '@/lib/db/schema';
import { and, desc, eq, isNull } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

// NOTE: this is `www.openstoa.xyz`, but the canonical production host
// documented in the root `CLAUDE.md` domain table is `openstoa.xyz` (no
// `www`) — `layout.tsx`'s `metadataBase` carries the same `www.` constant.
// Flagging rather than silently copying: unifying these is a one-line change
// IF `www.openstoa.xyz` actually redirects/resolves the same as the bare
// domain, but that needs a DNS/redirect check this change doesn't make.
const BASE_URL = 'https://www.openstoa.xyz';

/** Bounds how many post URLs a single sitemap can grow to. Google's own
 *  limit is 50,000 URLs per sitemap file; this is a much smaller, deliberate
 *  ceiling so the query stays cheap and recently-active content stays at the
 *  front of the list (ordered by `lastActivityAt` desc, below). */
const MAX_SITEMAP_POSTS = 500;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (process.env.APP_ENV !== 'production') return [];
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: BASE_URL,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1.0,
    },
    {
      url: `${BASE_URL}/topics`,
      lastModified: new Date(),
      changeFrequency: 'hourly',
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/ask`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/docs`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/recorded`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/skill.md`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/AGENTS.md`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.5,
    },
  ];

  let topicPages: MetadataRoute.Sitemap = [];
  let postPages: MetadataRoute.Sitemap = [];
  try {
    // `blindedAt` excluded — a discovery surface (search engines) should
    // mirror what `GET /api/topics` and `GET /api/feed` already keep out of
    // in-app listings for the same topic, not just its `visibility`. The
    // topic's OWN page (`generateMetadata` in
    // `src/app/topics/[topicId]/page.tsx`) deliberately does NOT apply this
    // filter — a direct link to a blinded topic still resolves for a human
    // visitor, only its appearance in a LISTING is suppressed.
    const publicTopics = await db
      .select({ id: topics.id, lastActivityAt: topics.lastActivityAt })
      .from(topics)
      .where(and(eq(topics.visibility, 'public'), isNull(topics.blindedAt)));

    topicPages = publicTopics.map((topic) => ({
      url: `${BASE_URL}/topics/${topic.id}`,
      lastModified: topic.lastActivityAt ?? new Date(),
      changeFrequency: 'daily' as const,
      priority: 0.7,
    }));
  } catch {
    // DB may not be available during build; skip dynamic topic pages
  }

  try {
    // Only posts in a public, non-blinded topic, and not themselves
    // soft-deleted — the same set `generateMetadata` on the post detail page
    // (`src/lib/pageMetadata.ts`) will actually serve real metadata for, so
    // a crawler following a sitemap URL here never lands on a page whose
    // `<head>` degrades to the generic fallback.
    const publicPosts = await db
      .select({
        id: posts.id,
        topicId: posts.topicId,
        lastActivityAt: posts.lastActivityAt,
      })
      .from(posts)
      .innerJoin(topics, eq(posts.topicId, topics.id))
      .where(
        and(
          eq(topics.visibility, 'public'),
          isNull(topics.blindedAt),
          eq(posts.isDeleted, false),
        ),
      )
      .orderBy(desc(posts.lastActivityAt))
      .limit(MAX_SITEMAP_POSTS);

    postPages = publicPosts.map((post) => ({
      url: `${BASE_URL}/topics/${post.topicId}/posts/${post.id}`,
      lastModified: post.lastActivityAt ?? new Date(),
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    }));
  } catch {
    // DB may not be available during build; skip dynamic post pages
  }

  return [...staticPages, ...topicPages, ...postPages];
}
