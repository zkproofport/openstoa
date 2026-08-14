import type { Metadata } from 'next';
import { buildTopicMetadata } from '@/lib/pageMetadata';
import { resolveRequestOrigin } from '@/lib/requestOrigin';
import TopicPageClient from './TopicPageClient';

// See the post detail page's identical comment — metadata depends on the
// request's own host and a live DB read, so this can never be static.
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ topicId: string }>;
}): Promise<Metadata> {
  const { topicId } = await params;
  const origin = await resolveRequestOrigin();
  return buildTopicMetadata(topicId, origin);
}

export default function TopicPage() {
  return <TopicPageClient />;
}
