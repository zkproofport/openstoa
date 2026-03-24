'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import CommunityLayout from '@/components/CommunityLayout';
import PostCard from '@/components/PostCard';
import Spinner from '@/components/Spinner';
import Avatar from '@/components/Avatar';
import ImageLightbox from '@/components/ImageLightbox';
import { truncateId, resizeImage } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface UserSession {
  userId: string;
  nickname?: string;
  profileImage?: string | null;
  totalRecorded?: number;
}

interface Post {
  id: string;
  topicId: string;
  title: string;
  content: string;
  authorNickname?: string;
  upvoteCount: number;
  commentCount: number;
  viewCount: number;
  createdAt: string;
  bookmarkedAt?: string;
}

type TabId = 'posts' | 'topics' | 'bookmarks' | 'likes' | 'settings';

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

  const [myTopics, setMyTopics] = useState<{ id: string; title: string; image?: string | null; memberCount?: number }[]>([]);
  const [myTopicsLoading, setMyTopicsLoading] = useState(false);

  // Settings tab state
  const [nicknameInput, setNicknameInput] = useState('');
  const [nicknameSaving, setNicknameSaving] = useState(false);
  const [nicknameFeedback, setNicknameFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  // Domain badge state (multi-domain)
  const [domainBadgeDomains, setDomainBadgeDomains] = useState<string[]>([]);
  const [domainBadgeAvailable, setDomainBadgeAvailable] = useState<string | null>(null);
  const [domainBadgeLoading, setDomainBadgeLoading] = useState(false);
  const [domainBadgeToggling, setDomainBadgeToggling] = useState(false);

  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [imageUploading, setImageUploading] = useState(false);
  const [imageFeedback, setImageFeedback] = useState<string | null>(null);

  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  function handleImageClick(src: string) {
    if (window.innerWidth <= 768 || 'ontouchstart' in window) {
      setLightboxSrc(src);
    } else {
      window.open(src, '_blank');
    }
  }

  // Infinite scroll sentinel ref
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Load session
  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (!data?.userId) {
          router.replace('/');
          return;
        }
        setSession(data);
        if (data.profileImage) setProfileImage(data.profileImage);
        // Also fetch from profile image endpoint (session may not include it)
        fetch('/api/profile/image').then(r => r.ok ? r.json() : null).then(d => {
          if (d?.profileImage) setProfileImage(d.profileImage);
        }).catch(() => {});
      })
      .catch(() => router.replace('/'))
      .finally(() => setSessionLoading(false));
  }, [router]);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      try { localStorage.removeItem('os-session'); } catch {}
      router.push('/');
    } catch {
      setLoggingOut(false);
    }
  }

  async function handleSaveNickname() {
    const trimmed = nicknameInput.trim();
    if (!trimmed) return;
    const NICKNAME_RE = /^[a-zA-Z0-9_]{2,20}$/;
    if (!NICKNAME_RE.test(trimmed)) {
      setNicknameFeedback({ ok: false, msg: '2-20 characters, letters/numbers/underscore only' });
      return;
    }
    setNicknameSaving(true);
    setNicknameFeedback(null);
    try {
      const res = await fetch('/api/profile/nickname', {
        method: 'PUT',
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

  // Load domain badge status when settings tab is opened
  useEffect(() => {
    if (activeTab !== 'settings') return;
    setDomainBadgeLoading(true);
    fetch('/api/profile/domain-badge')
      .then((r) => r.json())
      .then((data) => {
        setDomainBadgeDomains(data.domains ?? []);
        setDomainBadgeAvailable(data.availableDomain ?? null);
      })
      .catch(() => {})
      .finally(() => setDomainBadgeLoading(false));
  }, [activeTab]);

  async function handleDomainBadgeAdd() {
    setDomainBadgeToggling(true);
    try {
      const res = await fetch('/api/profile/domain-badge', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setDomainBadgeDomains(data.domains ?? []);
      }
    } catch {}
    setDomainBadgeToggling(false);
  }

  async function handleDomainBadgeRemove(domain: string) {
    setDomainBadgeToggling(true);
    try {
      const res = await fetch('/api/profile/domain-badge', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      if (res.ok) {
        const data = await res.json();
        setDomainBadgeDomains(data.domains ?? []);
      }
    } catch {}
    setDomainBadgeToggling(false);
  }

  async function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    if (file.size > 10 * 1024 * 1024) {
      setImageFeedback('Image must be under 10MB');
      return;
    }
    setImageUploading(true);
    setImageFeedback(null);
    try {
      if (profileImage) {
        const delRes = await fetch('/api/profile/image', { method: 'DELETE' });
        if (!delRes.ok) throw new Error('Failed to remove old image');
      }
      const resized = await resizeImage(file, 200);
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'avatar.webp', contentType: 'image/webp', size: resized.size, purpose: 'avatar' }),
      });
      if (!res.ok) throw new Error('Failed to get upload URL');
      const { uploadUrl, publicUrl } = await res.json();
      const uploadRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: resized });
      if (!uploadRes.ok) throw new Error('Failed to upload image');
      const saveRes = await fetch('/api/profile/image', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: publicUrl }),
      });
      if (!saveRes.ok) throw new Error('Failed to save profile image');
      setProfileImage(publicUrl);
      setImageFeedback(null);
    } catch (err) {
      setImageFeedback(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setImageUploading(false);
      e.target.value = '';
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

  const loadMyTopics = useCallback(async () => {
    setMyTopicsLoading(true);
    try {
      const res = await fetch('/api/topics');
      if (!res.ok) return;
      const data = await res.json();
      setMyTopics(data.topics ?? []);
    } finally {
      setMyTopicsLoading(false);
    }
  }, []);

  // Initial load after session
  useEffect(() => {
    if (!session) return;
    loadMyPosts(0, true);
    loadMyTopics();
    loadBookmarks(0, true);
    loadLikes(0, true);
  }, [session, loadMyPosts, loadMyTopics, loadBookmarks, loadLikes]);

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
      <CommunityLayout isGuest={false} sessionChecked={false}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
          <Spinner />
        </div>
      </CommunityLayout>
    );
  }

  if (!session) return null;

  const displayName = session.nickname ?? truncateId(session.userId);
  const memberSince = ''; // userId is a nullifier, no createdAt from session — show nothing

  const tabs: { id: TabId; label: string }[] = [
    { id: 'posts', label: 'My Posts' },
    { id: 'topics', label: 'My Topics' },
    { id: 'bookmarks', label: 'Bookmarks' },
    { id: 'likes', label: 'Likes' },
    { id: 'settings', label: 'Settings' },
  ];

  const activePosts = activeTab === 'posts' ? myPosts : activeTab === 'bookmarks' ? bookmarks : activeTab === 'likes' ? likes : [];
  const activeLoading = activeTab === 'posts' ? myPostsLoading : activeTab === 'bookmarks' ? bookmarksLoading : activeTab === 'likes' ? likesLoading : myTopicsLoading;
  const activeHasMore = activeTab === 'posts' ? myPostsHasMore : activeTab === 'bookmarks' ? bookmarksHasMore : activeTab === 'likes' ? likesHasMore : false;

  function handleLoadMore() {
    if (activeTab === 'posts') {
      loadMyPosts(myPostsOffset, false);
    } else if (activeTab === 'bookmarks') {
      loadBookmarks(bookmarksOffset, false);
    } else if (activeTab === 'likes') {
      loadLikes(likesOffset, false);
    }
  }

  const emptyLabel = activeTab === 'posts' ? 'No posts yet.' : activeTab === 'topics' ? 'No topics joined yet.' : activeTab === 'bookmarks' ? 'No bookmarks yet.' : 'No liked posts yet.';

  return (
    <CommunityLayout isGuest={false} sessionChecked={true}>
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}

        {/* Profile card */}
        <div style={{
          padding: '24px',
          background: 'var(--surface, #0c0e18)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 14,
          marginBottom: 28,
          display: 'flex',
          alignItems: 'center',
          gap: 18,
        }}>
          {/* Avatar */}
          <span
            onClick={() => profileImage && handleImageClick(profileImage)}
            style={{ cursor: profileImage ? 'pointer' : undefined, display: 'inline-flex' }}
          >
            <Avatar src={profileImage} name={displayName} size={56} />
          </span>

          {/* Info */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: '-0.03em',
              color: '#e5e7eb',
              marginBottom: 4,
            }}>
              {displayName}
            </div>
            <div style={{
              fontFamily: 'monospace',
              fontSize: 15,
              color: '#4b5563',
              wordBreak: 'break-all',
            }}>
              {truncateId(session.userId)}
            </div>
            {memberSince && (
              <div style={{ fontSize: 14, color: '#6b7280', marginTop: 4 }}>
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
            <div style={{ fontSize: 15, color: '#6b7280', marginTop: 1 }}>posts</div>
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

          {/* My Topics tab */}
          {activeTab === 'topics' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {myTopicsLoading && <div style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>Loading...</div>}
              {!myTopicsLoading && myTopics.length === 0 && (
                <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 14 }}>No topics joined yet.</div>
              )}
              {myTopics.map(topic => (
                <a key={topic.id} href={`/topics/${topic.id}`} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 16px',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  textDecoration: 'none',
                  color: 'inherit',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-hover, rgba(255,255,255,0.04))')}
                onMouseLeave={e => (e.currentTarget.style.background = 'var(--surface)')}
                >
                  <div style={{
                    width: 36, height: 36, borderRadius: 8,
                    background: 'var(--accent)', color: '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 16, fontWeight: 700, flexShrink: 0,
                  }}>
                    {topic.title.charAt(0).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>{topic.title}</div>
                    {topic.memberCount !== undefined && (
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{topic.memberCount} members</div>
                    )}
                  </div>
                </a>
              ))}
            </div>
          )}

          {/* Feed — hidden when Settings or Topics tab is active */}
          {activeTab !== 'settings' && activeTab !== 'topics' && (
            <>
              {/* My posts recorded stat */}
              {activeTab === 'posts' && session.totalRecorded !== undefined && session.totalRecorded > 0 && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 16px',
                  background: 'rgba(139,92,246,0.08)',
                  border: '1px solid rgba(139,92,246,0.15)',
                  borderRadius: 8,
                  marginBottom: 16,
                  fontSize: 14,
                  color: '#a78bfa',
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                  <span>My posts recorded <strong>{session.totalRecorded}</strong> time{session.totalRecorded !== 1 ? 's' : ''} on Base</span>
                </div>
              )}

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
              {/* Profile Image section */}
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 16px' }}>
                  Profile Image
                </h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <label
                    style={{
                      position: 'relative',
                      width: 72,
                      height: 72,
                      borderRadius: '50%',
                      cursor: imageUploading ? 'wait' : 'pointer',
                      flexShrink: 0,
                      display: 'block',
                      overflow: 'hidden',
                      border: profileImage ? 'none' : '2px dashed rgba(255,255,255,0.15)',
                      transition: 'border-color 0.15s',
                      opacity: imageUploading ? 0.5 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!profileImage) (e.currentTarget as HTMLElement).style.borderColor = 'rgba(59,130,246,0.4)';
                      const overlay = e.currentTarget.querySelector('[data-overlay]') as HTMLElement | null;
                      if (overlay) overlay.style.opacity = '1';
                    }}
                    onMouseLeave={(e) => {
                      if (!profileImage) (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.15)';
                      const overlay = e.currentTarget.querySelector('[data-overlay]') as HTMLElement | null;
                      if (overlay) overlay.style.opacity = '0';
                    }}
                  >
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleImageSelect}
                      disabled={imageUploading}
                      style={{ display: 'none' }}
                    />
                    {profileImage ? (
                      <>
                        <Avatar src={profileImage} name={displayName} size={72} />
                        <div
                          data-overlay=""
                          style={{
                            position: 'absolute',
                            inset: 0,
                            borderRadius: '50%',
                            background: 'rgba(0,0,0,0.55)',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: 0,
                            transition: 'opacity 0.15s',
                            color: '#fff',
                            fontSize: 15,
                            fontWeight: 600,
                            gap: 2,
                          }}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                            <circle cx="12" cy="13" r="4" />
                          </svg>
                          <span>Change</span>
                        </div>
                      </>
                    ) : (
                      <div style={{
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--muted)',
                        fontSize: 15,
                        textAlign: 'center',
                        lineHeight: 1.3,
                      }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 3 }}>
                          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                          <circle cx="12" cy="13" r="4" />
                        </svg>
                        <span>{imageUploading ? '...' : 'Upload'}</span>
                      </div>
                    )}
                  </label>
                  <div style={{ fontSize: 14, color: '#4b5563', lineHeight: 1.5 }}>
                    {imageUploading ? 'Uploading...' : profileImage ? 'Hover to change photo' : 'Click to upload photo'}
                    <br />
                    Auto-resized to 200x200 WebP
                  </div>
                </div>
                {imageFeedback && (
                  <div style={{ marginTop: 8, fontSize: 15, color: '#f87171' }}>
                    {imageFeedback}
                  </div>
                )}
              </div>

              {/* Nickname section */}
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 16px' }}>
                  Nickname
                </h3>
                <div style={{ fontSize: 15, color: '#9ca3af', marginBottom: 10 }}>
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
                      background: 'var(--surface, #0c0e18)',
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
                  <div style={{ marginTop: 8, fontSize: 15, color: nicknameFeedback.ok ? '#4ade80' : '#f87171' }}>
                    {nicknameFeedback.msg}
                  </div>
                )}
              </div>

              {/* Domain Badge section (multi-domain) */}
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 16px' }}>
                  Domain Badges
                </h3>
                {domainBadgeLoading ? (
                  <div style={{ fontSize: 14, color: '#6b7280' }}>Loading...</div>
                ) : (domainBadgeDomains.length > 0 || domainBadgeAvailable) ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {/* Active domain badges */}
                    {domainBadgeDomains.map((d) => (
                      <div key={d} style={{
                        padding: '12px 16px',
                        background: 'rgba(139,92,246,0.06)',
                        border: '1px solid rgba(139,92,246,0.3)',
                        borderRadius: 10,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                      }}>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 3,
                          fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 4,
                          background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.3)', color: '#8b5cf6',
                        }}>
                          {'📧'} {d}
                        </span>
                        <span style={{ flex: 1, fontSize: 13, color: '#6b7280' }}>visible to others</span>
                        <button
                          onClick={() => handleDomainBadgeRemove(d)}
                          disabled={domainBadgeToggling}
                          style={{
                            background: 'rgba(239,68,68,0.1)',
                            color: '#ef4444',
                            border: '1px solid rgba(239,68,68,0.25)',
                            borderRadius: 6,
                            padding: '4px 12px',
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: domainBadgeToggling ? 'not-allowed' : 'pointer',
                            opacity: domainBadgeToggling ? 0.5 : 1,
                            transition: 'all 0.12s',
                            flexShrink: 0,
                          }}
                        >
                          Hide
                        </button>
                      </div>
                    ))}

                    {/* Add available domain (if not already opted in) */}
                    {domainBadgeAvailable && !domainBadgeDomains.includes(domainBadgeAvailable) && (
                      <div style={{
                        padding: '12px 16px',
                        background: 'rgba(255,255,255,0.02)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 10,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                      }}>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 14, fontWeight: 600, color: '#e5e7eb' }}>
                            {domainBadgeAvailable}
                          </span>
                          <span style={{ fontSize: 13, color: '#6b7280', marginLeft: 8 }}>
                            verified — show as badge?
                          </span>
                        </span>
                        <button
                          onClick={handleDomainBadgeAdd}
                          disabled={domainBadgeToggling}
                          style={{
                            background: 'rgba(139,92,246,0.15)',
                            color: '#8b5cf6',
                            border: '1px solid rgba(139,92,246,0.3)',
                            borderRadius: 6,
                            padding: '4px 12px',
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: domainBadgeToggling ? 'not-allowed' : 'pointer',
                            opacity: domainBadgeToggling ? 0.5 : 1,
                            transition: 'all 0.12s',
                            flexShrink: 0,
                          }}
                        >
                          Show
                        </button>
                      </div>
                    )}

                    <p style={{ fontSize: 12, color: '#4b5563', margin: '4px 0 0', lineHeight: 1.5 }}>
                      Domain badges are shown next to your name in posts, comments, and member lists. Verify more workspace domains to add additional badges.
                    </p>
                  </div>
                ) : (
                  <div style={{
                    padding: '16px 20px',
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: 10,
                  }}>
                    <p style={{ fontSize: 14, color: '#6b7280', margin: 0, lineHeight: 1.5 }}>
                      No workspace verification found. Join a workspace-gated topic with a domain proof to unlock this feature.
                    </p>
                  </div>
                )}
              </div>

              {/* Account section */}
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 16px' }}>
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
                <p style={{ fontSize: 15, color: '#6b7280', margin: '0 0 14px', lineHeight: 1.5 }}>
                  If you delete your account, your nickname will be changed to &apos;[Withdrawn User]&apos; and your posts and comments will remain. Please transfer topic ownership beforehand.
                </p>

                {ownedTopicsError && (
                  <div style={{
                    marginBottom: 14,
                    padding: '12px 14px',
                    background: 'rgba(239,68,68,0.08)',
                    border: '1px solid rgba(239,68,68,0.25)',
                    borderRadius: 8,
                  }}>
                    <p style={{ fontSize: 15, color: '#ef4444', margin: '0 0 8px', fontWeight: 600 }}>
                      Please transfer topic ownership first
                    </p>
                    <ul style={{ margin: 0, padding: '0 0 0 18px', fontSize: 15, color: '#f87171', lineHeight: 1.8 }}>
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
                    fontSize: 15,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}>
                    Delete Account
                  </button>
                ) : (
                  <div>
                    <p style={{ fontSize: 14, color: '#ef4444', margin: '0 0 10px' }}>
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
                          background: 'var(--surface, #0c0e18)',
                          border: '1px solid rgba(239,68,68,0.3)',
                          borderRadius: 6,
                          padding: '8px 12px',
                          color: '#e5e7eb',
                          fontSize: 15,
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
                          fontSize: 15,
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
                          fontSize: 15,
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
    </CommunityLayout>
  );
}
