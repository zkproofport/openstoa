import { db } from '@/lib/db';
import { posts } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

const REDDIT_EPOCH = 1134028003;

export function computeHotScore(upvotes: number, createdAt: Date): number {
  const order = Math.log10(Math.max(Math.abs(upvotes), 1));
  const sign = upvotes > 0 ? 1 : upvotes < 0 ? -1 : 0;
  const seconds = Math.floor(createdAt.getTime() / 1000) - REDDIT_EPOCH;
  return Number((sign * order + seconds / 45000).toFixed(7));
}

export async function updatePostScore(postId: string): Promise<void> {
  const post = await db.query.posts.findFirst({
    where: eq(posts.id, postId),
    columns: { upvoteCount: true, createdAt: true },
  });
  if (!post || !post.createdAt) return;
  const score = computeHotScore(post.upvoteCount, new Date(post.createdAt));
  await db.update(posts).set({ score }).where(eq(posts.id, postId));
}
