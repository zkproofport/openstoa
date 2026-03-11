'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';
import PostCard from '@/components/PostCard';
import Spinner from '@/components/Spinner';
import { truncateId } from '@/lib/utils';

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
  media?: { embeds?: { type: 'youtube' | 'vimeo'; url: string; videoId: string }[] } | null;
  authorNickname?: string;
  upvoteCount: number;
  commentCount: number;
  viewCount: number;
  createdAt: string;
  bookmarkedAt?: string;
}

type TabId = 'posts' | 'bookmarks' | 'likes' | 'settings';

const PAGE_SIZE = 20;

// ─── Icons ───────────────────────────────────────────────────────────────────

function UserIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
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

  // Settings tab state
  const [nicknameInput, setNicknameInput] = useState('');
  const [nicknameSaving, setNicknameSaving] = useState(false);
  const [nicknameFeedback, setNicknameFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  // Infinite scroll sentinel ref
  const sentinelRef = useRef<HTMLDivElement>(null);

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

  async function handleSaveNickname() {
    const trimmed = nicknameInput.trim();
    if (!trimmed) return;
    setNicknameSaving(true);
    setNicknameFeedback(null);
    try {
      const res = await fetch('/api/auth/session', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: trimmed }),
      });
      if (res.ok) {
        setSession((prev) => prev ? { ...prev, nickname: trimmed } : prev);
        setNicknameFeedback({ ok: true, msg: 'Nickname updated.' });
        setNicknameInput('');
      } else {
        const data = await res.json().catch(() => ({}));
        setNicknameFeedback({ ok: false, msg: data?.error ?? 'Failed to update nickname.' });
      }
    } catch {
      setNicknameFeedback({ ok: false, msg: 'Network error.' });
    } finally {
      setNicknameSaving(false);
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

  // Infinite scroll via IntersectionObserver
  // Uses raw state to avoid referencing render-body derived vars
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const hasMore = activeTab === 'posts' ? myPostsHasMore : activeTab === 'bookmarks' ? bookmarksHasMore : likesHasMore;
    const loading = activeTab === 'posts' ? myPostsLoading : activeTab === 'bookmarks' ? bookmarksLoading : likesLoading;
    const loadMore = () => {
      if (activeTab === 'posts') loadMyPosts(myPostsOffset, false);
      else if (activeTab === 'bookmarks') loadBookmarks(bookmarksOffset, false);
      else if (activeTab === 'likes') loadLikes(likesOffset, false);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          loadMore();
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    activeTab,
    myPostsHasMore, myPostsLoading, myPostsOffset,
    bookmarksHasMore, bookmarksLoading, bookmarksOffset,
    likesHasMore, likesLoading, likesOffset,
    loadMyPosts, loadBookmarks, loadLikes,
  ]);

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
    { id: 'settings', label: 'Settings' },
  ];

  const activePosts = activeTab === 'posts' ? myPosts : activeTab === 'bookmarks' ? bookmarks : likes;
  const activeLoading = activeTab === 'posts' ? myPostsLoading : activeTab === 'bookmarks' ? bookmarksLoading : likesLoading;
  const activeHasMore = activeTab === 'posts' ? myPostsHasMore : activeTab === 'bookmarks' ? bookmarksHasMore : likesHasMore;

  function handleLoadMore() {
    if (activeTab === 'posts') {
      loadMyPosts(myPostsOffset, false);
    } else if (activeTab === 'bookmarks') {
      loadBookmarks(bookmarksOffset, false);
    } else if (activeTab === 'likes') {
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

          {/* Feed — hidden when Settings tab is active */}
          {activeTab !== 'settings' && (
            <>
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
                    <PostCard key={post.id} post={post} href={`/topics/${post.topicId}/posts/${post.id}`} />
                  ))
                )}
              </div>

              {/* Infinite scroll sentinel */}
              {activeHasMore && (
                <div ref={sentinelRef} style={{ display: 'flex', justifyContent: 'center', padding: '20px 0' }}>
                  {activeLoading && <Spinner />}
                </div>
              )}
            </>
          )}

          {/* Settings tab content */}
          {activeTab === 'settings' && (
            <div style={{
              border: '1px solid rgba(255,255,255,0.06)',
              borderTop: 'none',
              borderRadius: '0 0 14px 14px',
              padding: '24px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 32,
            }}>
              {/* Nickname section */}
              <div>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 16px' }}>
                  Nickname
                </h3>
                <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 10 }}>
                  Current: <span style={{ color: '#e5e7eb', fontWeight: 600 }}>{displayName}</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={nicknameInput}
                    onChange={(e) => { setNicknameInput(e.target.value); setNicknameFeedback(null); }}
                    placeholder="New nickname"
                    maxLength={30}
                    style={{
                      flex: 1,
                      background: '#111',
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: 8,
                      padding: '9px 12px',
                      color: '#e5e7eb',
                      fontSize: 14,
                      outline: 'none',
                    }}
                  />
                  <button
                    onClick={handleSaveNickname}
                    disabled={!nicknameInput.trim() || nicknameSaving}
                    style={{
                      background: 'var(--accent)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 8,
                      padding: '9px 20px',
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: !nicknameInput.trim() || nicknameSaving ? 'not-allowed' : 'pointer',
                      opacity: !nicknameInput.trim() || nicknameSaving ? 0.5 : 1,
                      transition: 'opacity 0.12s',
                    }}
                  >
                    {nicknameSaving ? 'Saving...' : 'Save'}
                  </button>
                </div>
                {nicknameFeedback && (
                  <div style={{ marginTop: 8, fontSize: 13, color: nicknameFeedback.ok ? '#4ade80' : '#f87171' }}>
                    {nicknameFeedback.msg}
                  </div>
                )}
              </div>

              {/* Account section */}
              <div>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 16px' }}>
                  Account
                </h3>
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
          )}
        </div>
      </div>
    </>
  );
}
