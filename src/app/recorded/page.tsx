'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';
import PostCard from '@/components/PostCard';
import Spinner from '@/components/Spinner';

interface Post {
  id: string;
  title: string;
  content: string;
  media?: { embeds?: { type: 'youtube' | 'vimeo'; url: string; videoId: string }[] } | null;
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
  const router = useRouter();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [postsLoading, setPostsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) { router.replace('/'); return; }
        setSessionUserId(data.userId);
      })
      .catch(() => router.replace('/'));
  }, [router]);

  const loadPosts = useCallback(async (currentOffset: number, replace: boolean) => {
    if (replace) setLoading(true);
    else setPostsLoading(true);
    try {
      const res = await fetch(`/api/recorded?limit=${PAGE_SIZE}&offset=${currentOffset}`);
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
    <>
      <Header />
      <div style={{ paddingTop: 40, paddingBottom: 80, maxWidth: '56rem', margin: '0 auto', padding: '40px 1.5rem 80px' }}>
        <div style={{ marginBottom: 24 }}>
          <Link href="/topics" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 13 }}>
            ← Topics
          </Link>
        </div>

        <h1 style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-0.04em', margin: '0 0 8px' }}>
          Recorded Posts
        </h1>
        <p style={{ fontSize: 16, color: 'var(--muted)', marginBottom: 24 }}>
          Posts recorded on Base by the community
        </p>

        <div style={{ maxWidth: 600, margin: '0 auto' }}>
          <div style={{
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 14,
            overflow: 'hidden',
          }}>
            {loading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
                <Spinner />
              </div>
            ) : posts.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 20px' }}>
                <p style={{ fontSize: 15, color: '#6b7280' }}>
                  No recorded posts yet. Be the first to record a post on-chain!
                </p>
              </div>
            ) : (
              posts.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  href={`/topics/${post.topicId}/posts/${post.id}`}
                  showAuthor
                  media={post.media}
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
        </div>
      </div>
    </>
  );
}
