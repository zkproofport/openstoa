import type { MetadataRoute } from 'next';
import { db } from '@/lib/db';
import { topics } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

const IS_PRODUCTION = process.env.APP_ENV === 'production';
const BASE_URL = 'https://www.openstoa.xyz';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!IS_PRODUCTION) return [];
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
  try {
    const publicTopics = await db
      .select({ id: topics.id, lastActivityAt: topics.lastActivityAt })
      .from(topics)
      .where(eq(topics.visibility, 'public'));

    topicPages = publicTopics.map((topic) => ({
      url: `${BASE_URL}/topics/${topic.id}`,
      lastModified: topic.lastActivityAt ?? new Date(),
      changeFrequency: 'daily' as const,
      priority: 0.7,
    }));
  } catch {
    // DB may not be available during build; skip dynamic topic pages
  }

  return [...staticPages, ...topicPages];
}
