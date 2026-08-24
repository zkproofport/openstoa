'use client';

import { apiFetch } from '@/lib/apiFetch';
import { loadSession } from '@/lib/sessionCache';
import { useState, useEffect, useRef, useCallback } from 'react';
import CommunityLayout from '@/components/CommunityLayout';
import PostCard from '@/components/PostCard';
import Spinner from '@/components/Spinner';
import { useTranslation } from '@/lib/i18n/I18nProvider';

interface Post {
  id: string;
  title: string;
  content: string;
  authorNickname: string;
  authorProfileImage?: string | null;
  authorId: string;
  topicId: string;
  topicTitle?: string;
  commentCount?: number;
  upvoteCount?: number;
  viewCount?: number;
  recordCount?: number;
  isPinned?: boolean;
  reactions?: { emoji: string; count: number; userReacted: boolean }[];
  userVoted?: number | null;
  createdAt: string;
}

const PAGE_SIZE = 20;

export default function RecordedPage() {
  const { t } = useTranslation();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [postsLoading, setPostsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadSession()
      .then((data) => {
        if (data?.userId) setSessionUserId(data.userId);
      })
      .catch(() => {});
  }, []);

  const loadPosts = useCallback(async (currentOffset: number, replace: boolean) => {
    if (replace) setLoading(true);
    else setPostsLoading(true);
    try {
      const res = await apiFetch(`/api/recorded?limit=${PAGE_SIZE}&offset=${currentOffset}`);
      if (!res.ok) return;
      const data = await res.json();
      const newPosts: Post[] = data.posts ?? [];
      setPosts((prev) => replace ? newPosts : [...prev, ...newPosts]);
      setHasMore(newPosts.length === PAGE_SIZE);
      setOffset(currentOffset + newPosts.length);
    } finally {
      setLoading(false);
      setPostsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPosts(0, true);
  }, [loadPosts]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !postsLoading) {
          loadPosts(offset, false);
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, postsLoading, offset, loadPosts]);

  return (
    <CommunityLayout isGuest={!sessionUserId} sessionChecked={!loading}>
      <div style={{ marginBottom: 'var(--space-5)' }}>
        <h1 style={{ fontSize: 'var(--text-heading-lg)', fontWeight: 800, letterSpacing: '-0.04em', margin: '0 0 var(--space-2)' }}>
          {t('recordedPage.title')}
        </h1>
        <p style={{ fontSize: 'var(--text-body)', color: 'var(--muted)', marginBottom: 0 }}>
          {t('recordedPage.subtitle')}
        </p>
      </div>

      <div style={{
        border: '1px solid var(--color-border-default)',
        borderRadius: 'var(--radius-card)',
        overflow: 'hidden',
      }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
            <Spinner />
          </div>
        ) : posts.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <p style={{ fontSize: 'var(--text-body)', color: 'var(--color-text-tertiary)' }}>
              {t('recordedPage.empty')}
            </p>
          </div>
        ) : (
          posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              href={`/topics/${post.topicId}/posts/${post.id}`}
              showAuthor
              sessionUserId={sessionUserId}
              authorId={post.authorId}
              expandable
            />
          ))
        )}
      </div>

      {hasMore && (
        <div ref={sentinelRef} style={{ display: 'flex', justifyContent: 'center', padding: '20px 0' }}>
          {postsLoading && <Spinner />}
        </div>
      )}
    </CommunityLayout>
  );
}
