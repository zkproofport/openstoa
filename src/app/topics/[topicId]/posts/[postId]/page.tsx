import type { Metadata } from 'next';
import { getServerLocale } from '@/lib/i18n/getServerLocale';
import { buildPostMetadata } from '@/lib/pageMetadata';
import { resolveRequestOrigin } from '@/lib/requestOrigin';
import PostDetailClient from './PostDetailClient';

// Metadata depends on the REQUEST (its own host — see `resolveRequestOrigin`
// — and a live DB read), so this route can never be statically generated.
// Mirrors the root layout's `export const dynamic = 'force-dynamic'`.
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ topicId: string; postId: string }>;
}): Promise<Metadata> {
  const { topicId, postId } = await params;
  const origin = await resolveRequestOrigin();
  return buildPostMetadata(topicId, postId, origin, await getServerLocale());
}

export default function PostPage() {
  return <PostDetailClient />;
}
