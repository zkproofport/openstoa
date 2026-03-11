'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';
import SNSContent from '@/components/SNSContent';

// ─── Types ───────────────────────────────────────────────────────────────────

interface UserSession {
  userId: string;
  nickname?: string;
}

interface Post {
  id: string;
  topicId: string;
  title: string;
  content: string;
  media?: unknown;
  authorNickname?: string;
  upvoteCount: number;
  commentCount: number;
  viewCount: number;
  createdAt: string;
  bookmarkedAt?: string;
}

type TabId = 'posts' | 'bookmarks' | 'likes';

const PAGE_SIZE = 20;

// ─── Utilities ───────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function truncateId(id: string): string {
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}...${id.slice(-6)}`;
}

// ─── Icons ───────────────────────────────────────────────────────────────────

function HeartIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--accent)"
      strokeWidth="2"
      strokeLinecap="round"
      style={{ animation: 'spin 1s linear infinite' }}
    >
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

// ─── Post Card ───────────────────────────────────────────────────────────────

function PostCard({ post }: { post: Post }) {
  return (
    <Link
      href={`/topics/${post.topicId}/posts/${post.id}`}
      style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
    >
      <article
        style={{
          padding: '16px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          transition: 'background 0.12s',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        {/* Title */}
        <h3 style={{
          fontSize: 15,
          fontWeight: 700,
          margin: '0 0 6px 0',
          letterSpacing: '-0.01em',
          color: '#e5e7eb',
          lineHeight: 1.4,
        }}>
          {post.title}
        </h3>

        {/* Content preview */}
        <div style={{ marginBottom: 10 }}>
          <SNSContent
            html={post.content}
            media={null}
            truncate={true}
            maxLines={2}
          />
        </div>

        {/* Meta row */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          fontSize: 12,
          color: '#6b7280',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <HeartIcon />
            {post.upvoteCount}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <CommentIcon />
            {post.commentCount}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <EyeIcon />
            {post.viewCount}
          </span>
          <span style={{ marginLeft: 'auto' }}>
            {relativeTime(post.createdAt)}
          </span>
        </div>
      </article>
    </Link>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function MyPage() {
  const router = useRouter();
  const [session, setSession] = useState<UserSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  const [activeTab, setActiveTab] = useState<TabId>('posts');

  const [loggingOut, setLoggingOut] = useState(false);

  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [ownedTopicsError, setOwnedTopicsError] = useState<{ id: string; title: string }[] | null>(null);

  const [myPosts, setMyPosts] = useState<Post[]>([]);
  const [myPostsOffset, setMyPostsOffset] = useState(0);
  const [myPostsHasMore, setMyPostsHasMore] = useState(false);
  const [myPostsLoading, setMyPostsLoading] = useState(false);

  const [bookmarks, setBookmarks] = useState<Post[]>([]);
  const [bookmarksOffset, setBookmarksOffset] = useState(0);
  const [bookmarksHasMore, setBookmarksHasMore] = useState(false);
  const [bookmarksLoading, setBookmarksLoading] = useState(false);

  const [likes, setLikes] = useState<Post[]>([]);
  const [likesOffset, setLikesOffset] = useState(0);
  const [likesHasMore, setLikesHasMore] = useState(false);
  const [likesLoading, setLikesLoading] = useState(false);

  // Load session
  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) {
          router.replace('/');
          return;
        }
        setSession(data);
      })
      .catch(() => router.replace('/'))
      .finally(() => setSessionLoading(false));
  }, [router]);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/');
    } catch {
      setLoggingOut(false);
    }
  }

  // Load my posts
  const loadMyPosts = useCallback(async (currentOffset: number, replace: boolean) => {
    setMyPostsLoading(true);
    try {
      const res = await fetch(`/api/my/posts?limit=${PAGE_SIZE}&offset=${currentOffset}`);
      if (!res.ok) return;
      const data = await res.json();
      const newPosts: Post[] = data.posts ?? [];
      setMyPosts((prev) => (replace ? newPosts : [...prev, ...newPosts]));
      setMyPostsHasMore(newPosts.length === PAGE_SIZE);
      setMyPostsOffset(currentOffset + newPosts.length);
    } finally {
      setMyPostsLoading(false);
    }
  }, []);

  // Load bookmarks
  const loadBookmarks = useCallback(async (currentOffset: number, replace: boolean) => {
    setBookmarksLoading(true);
    try {
      const res = await fetch(`/api/bookmarks?limit=${PAGE_SIZE}&offset=${currentOffset}`);
      if (!res.ok) return;
      const data = await res.json();
      const newPosts: Post[] = data.posts ?? [];
      setBookmarks((prev) => (replace ? newPosts : [...prev, ...newPosts]));
      setBookmarksHasMore(newPosts.length === PAGE_SIZE);
      setBookmarksOffset(currentOffset + newPosts.length);
    } finally {
      setBookmarksLoading(false);
    }
  }, []);

  // Load likes
  const loadLikes = useCallback(async (currentOffset: number, replace: boolean) => {
    setLikesLoading(true);
    try {
      const res = await fetch(`/api/my/likes?limit=${PAGE_SIZE}&offset=${currentOffset}`);
      if (!res.ok) return;
      const data = await res.json();
      const newPosts: Post[] = data.posts ?? [];
      setLikes((prev) => (replace ? newPosts : [...prev, ...newPosts]));
      setLikesHasMore(newPosts.length === PAGE_SIZE);
      setLikesOffset(currentOffset + newPosts.length);
    } finally {
      setLikesLoading(false);
    }
  }, []);

  // Initial load after session
  useEffect(() => {
    if (!session) return;
    loadMyPosts(0, true);
    loadBookmarks(0, true);
    loadLikes(0, true);
  }, [session, loadMyPosts, loadBookmarks, loadLikes]);

  if (sessionLoading) {
    return (
      <>
        <Header />
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
          <Spinner />
        </div>
      </>
    );
  }

  if (!session) return null;

  const displayName = session.nickname ?? truncateId(session.userId);
  const memberSince = ''; // userId is a nullifier, no createdAt from session — show nothing

  const tabs: { id: TabId; label: string }[] = [
    { id: 'posts', label: 'My Posts' },
    { id: 'bookmarks', label: 'Bookmarks' },
    { id: 'likes', label: 'Likes' },
  ];

  const activePosts = activeTab === 'posts' ? myPosts : activeTab === 'bookmarks' ? bookmarks : likes;
  const activeLoading = activeTab === 'posts' ? myPostsLoading : activeTab === 'bookmarks' ? bookmarksLoading : likesLoading;
  const activeHasMore = activeTab === 'posts' ? myPostsHasMore : activeTab === 'bookmarks' ? bookmarksHasMore : likesHasMore;

  function handleLoadMore() {
    if (activeTab === 'posts') {
      loadMyPosts(myPostsOffset, false);
    } else if (activeTab === 'bookmarks') {
      loadBookmarks(bookmarksOffset, false);
    } else {
      loadLikes(likesOffset, false);
    }
  }

  const emptyLabel = activeTab === 'posts' ? 'No posts yet.' : activeTab === 'bookmarks' ? 'No bookmarks yet.' : 'No liked posts yet.';

  return (
    <>
      <Header />
      <div style={{ paddingTop: 36, paddingBottom: 100 }}>
        {/* Breadcrumb */}
        <div style={{ marginBottom: 24 }}>
          <Link href="/topics" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 13 }}>
            ← Topics
          </Link>
        </div>

        {/* Profile card */}
        <div style={{
          padding: '24px',
          background: '#0d0d0d',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 14,
          marginBottom: 28,
          display: 'flex',
          alignItems: 'center',
          gap: 18,
        }}>
          {/* Avatar */}
          <div style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            flexShrink: 0,
          }}>
            <UserIcon />
          </div>

          {/* Info */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 18,
              fontWeight: 800,
              letterSpacing: '-0.03em',
              color: '#e5e7eb',
              marginBottom: 4,
            }}>
              {displayName}
            </div>
            <div style={{
              fontFamily: 'monospace',
              fontSize: 11,
              color: '#4b5563',
              wordBreak: 'break-all',
            }}>
              {truncateId(session.userId)}
            </div>
            {memberSince && (
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                Member since {memberSince}
              </div>
            )}
          </div>

          {/* Post count badge */}
          <div style={{
            textAlign: 'center',
            flexShrink: 0,
          }}>
            <div style={{
              fontSize: 22,
              fontWeight: 800,
              color: 'var(--accent)',
              letterSpacing: '-0.03em',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {myPosts.length}
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1 }}>posts</div>
          </div>
        </div>

        {/* Centered feed column */}
        <div style={{ maxWidth: 600, margin: '0 auto' }}>
          {/* Tab bar */}
          <div style={{
            display: 'flex',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            marginBottom: 0,
          }}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  borderBottom: activeTab === tab.id
                    ? '2px solid var(--accent)'
                    : '2px solid transparent',
                  color: activeTab === tab.id ? 'var(--foreground)' : 'var(--muted)',
                  fontSize: 14,
                  fontWeight: activeTab === tab.id ? 700 : 400,
                  padding: '10px 20px',
                  cursor: 'pointer',
                  marginBottom: -1,
                  transition: 'color 0.12s, border-color 0.12s',
                  letterSpacing: '-0.01em',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Feed */}
          <div style={{
            border: '1px solid rgba(255,255,255,0.06)',
            borderTop: 'none',
            borderRadius: '0 0 14px 14px',
            overflow: 'hidden',
            minHeight: 120,
          }}>
            {activeLoading && activePosts.length === 0 ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}>
                <Spinner />
              </div>
            ) : activePosts.length === 0 ? (
              <div style={{
                textAlign: 'center',
                padding: '60px 20px',
                color: '#6b7280',
                fontSize: 14,
              }}>
                {emptyLabel}
              </div>
            ) : (
              activePosts.map((post) => (
                <PostCard key={post.id} post={post} />
              ))
            )}
          </div>

          {/* Load more */}
          {activeHasMore && (
            <div style={{ textAlign: 'center', marginTop: 20 }}>
              <button
                onClick={handleLoadMore}
                disabled={activeLoading}
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  color: '#6b7280',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 8,
                  padding: '10px 28px',
                  fontSize: 14,
                  cursor: activeLoading ? 'default' : 'pointer',
                  opacity: activeLoading ? 0.5 : 1,
                  transition: 'opacity 0.12s',
                }}
              >
                {activeLoading ? 'Loading...' : 'Load more'}
              </button>
            </div>
          )}
          {/* Logout */}
          <div style={{ marginTop: 48, marginBottom: 16 }}>
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              style={{
                width: '100%',
                padding: '12px 20px',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 10,
                color: '#9ca3af',
                fontSize: 14,
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.12s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)'; (e.currentTarget as HTMLElement).style.color = '#e5e7eb'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; (e.currentTarget as HTMLElement).style.color = '#9ca3af'; }}
            >
              {loggingOut ? 'Logging out...' : 'Logout'}
            </button>
          </div>

          {/* Danger Zone */}
          <div style={{
            marginTop: 48,
            padding: '20px 24px',
            background: 'rgba(239,68,68,0.04)',
            border: '1px solid rgba(239,68,68,0.15)',
            borderRadius: 12,
          }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: '#ef4444', margin: '0 0 8px' }}>
              Danger Zone
            </h3>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 14px', lineHeight: 1.5 }}>
              계정을 삭제하면 닉네임이 &apos;[탈퇴한 사용자]&apos;로 변경되며, 작성한 게시글과 댓글은 유지됩니다. 토픽 소유권은 미리 이전해야 합니다.
            </p>

            {ownedTopicsError && (
              <div style={{
                marginBottom: 14,
                padding: '12px 14px',
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: 8,
              }}>
                <p style={{ fontSize: 13, color: '#ef4444', margin: '0 0 8px', fontWeight: 600 }}>
                  토픽 소유권을 먼저 이전해주세요
                </p>
                <ul style={{ margin: 0, padding: '0 0 0 18px', fontSize: 13, color: '#f87171', lineHeight: 1.8 }}>
                  {ownedTopicsError.map((t) => (
                    <li key={t.id}>{t.title}</li>
                  ))}
                </ul>
              </div>
            )}

            {!showDeleteAccount ? (
              <button onClick={() => { setShowDeleteAccount(true); setOwnedTopicsError(null); }} style={{
                background: 'rgba(239,68,68,0.1)',
                color: '#ef4444',
                border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: 8,
                padding: '8px 18px',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}>
                Delete Account
              </button>
            ) : (
              <div>
                <p style={{ fontSize: 12, color: '#ef4444', margin: '0 0 10px' }}>
                  Type <strong>DELETE</strong> to confirm:
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    placeholder="DELETE"
                    style={{
                      flex: 1,
                      background: '#111',
                      border: '1px solid rgba(239,68,68,0.3)',
                      borderRadius: 6,
                      padding: '8px 12px',
                      color: '#e5e7eb',
                      fontSize: 13,
                      outline: 'none',
                      fontFamily: 'monospace',
                    }}
                  />
                  <button
                    onClick={async () => {
                      setDeletingAccount(true);
                      setOwnedTopicsError(null);
                      try {
                        const res = await fetch('/api/account', { method: 'DELETE' });
                        if (res.status === 409) {
                          const data = await res.json();
                          setOwnedTopicsError(data.topics ?? []);
                          setShowDeleteAccount(false);
                          setDeleteConfirmText('');
                        } else if (res.ok) {
                          router.replace('/');
                        }
                      } finally {
                        setDeletingAccount(false);
                      }
                    }}
                    disabled={deleteConfirmText !== 'DELETE' || deletingAccount}
                    style={{
                      background: deleteConfirmText === 'DELETE' ? '#ef4444' : 'rgba(239,68,68,0.2)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      padding: '8px 18px',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: deleteConfirmText === 'DELETE' ? 'pointer' : 'not-allowed',
                      opacity: deletingAccount ? 0.5 : 1,
                    }}
                  >
                    {deletingAccount ? 'Deleting...' : 'Confirm'}
                  </button>
                  <button
                    onClick={() => { setShowDeleteAccount(false); setDeleteConfirmText(''); setOwnedTopicsError(null); }}
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      color: '#6b7280',
                      border: 'none',
                      borderRadius: 6,
                      padding: '8px 14px',
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
