'use client';

import { apiFetch, UPLOAD_REQUEST_TIMEOUT_MS } from '@/lib/apiFetch';
import { useSession, useClearSession } from '@/lib/useSession';
import { useState, useEffect, useCallback, useRef, Children } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import CommunityLayout from '@/components/CommunityLayout';
import PostCard from '@/components/PostCard';
import Spinner from '@/components/Spinner';
import Avatar from '@/components/Avatar';
import ImageLightbox from '@/components/ImageLightbox';
import AiAgentSettings from '@/components/AiAgentSettings';
import LocaleSwitcher from '@/components/LocaleSwitcher';
import ThemeToggle from '@/components/ThemeToggle';
import { truncateId, resizeImage } from '@/lib/utils';
import { useTranslation } from '@/lib/i18n/I18nProvider';
import { wipeLocalKeys } from '@/lib/mls/wipeLocalKeys';

// ─── Types ───────────────────────────────────────────────────────────────────

interface UserSession {
  userId: string;
  nickname?: string;
  profileImage?: string | null;
  totalRecorded?: number;
  role?: string;
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

type TabId = 'posts' | 'topics' | 'bookmarks' | 'settings';

const PAGE_SIZE = 20;

// ─── Settings surface contract ───────────────────────────────────────────────

/**
 * ONE list idiom for every settings row on this surface.
 *
 * `/my`'s Settings tab used to stack five differently-styled panels — a bare
 * section here, a bordered card there, a tinted danger box at the bottom —
 * and the two components it embeds (`AiAgentSettings`, and `AccountRecovery`
 * via `/recovery`) each carried a third and fourth look. These two objects are
 * the whole contract: a bordered list, and a row inside it.
 *
 * Mirrored VERBATIM in `src/components/AiAgentSettings.tsx` and
 * `src/components/AccountRecovery.tsx`, which render into this same surface.
 * `src/__tests__/settingsSurface.test.tsx` re-parses all three files and fails
 * if any copy drifts, so "they match" is a checked fact, not a convention.
 */
const SETTINGS_LIST: React.CSSProperties = {
  background: 'var(--color-bg-secondary)',
  border: '1px solid var(--color-border-default)',
  borderRadius: 'var(--radius-card)',
  overflow: 'hidden',
};
const SETTINGS_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-4)',
  flexWrap: 'wrap',
  padding: 'var(--space-4)',
  minHeight: 'var(--touch-target-min)',
};

/** Section heading above a list. `.os-label` gates uppercase+tracking to :lang(en). */
const SETTINGS_HEADING: React.CSSProperties = {
  color: 'var(--color-text-tertiary)',
  margin: '0 0 var(--space-3)',
};

/** Explanatory copy under a list — capped at a reading measure, never full-bleed. */
const SETTINGS_NOTE: React.CSSProperties = {
  fontSize: 'var(--text-caption)',
  color: 'var(--color-text-tertiary)',
  lineHeight: 'var(--leading-base)',
  maxWidth: '68ch',
  margin: 'var(--space-3) 0 0',
};

const ROW_LABEL: React.CSSProperties = {
  fontSize: 'var(--text-body-sm)',
  fontWeight: 600,
  color: 'var(--color-text-primary)',
};
const ROW_HINT: React.CSSProperties = {
  fontSize: 'var(--text-caption)',
  color: 'var(--color-text-tertiary)',
  lineHeight: 'var(--leading-base)',
  maxWidth: '60ch',
  marginTop: 2,
};

/**
 * A verified-claim chip in the identity block (design: "identity is a
 * nullifier, trust is a badge"). Transparent ground + toned border, so a row
 * of them never out-shouts the name above it.
 */
function identityChip(tone: 'accent' | 'warning' | 'quiet'): React.CSSProperties {
  const color =
    tone === 'accent' ? 'var(--color-brand-accent)'
      : tone === 'warning' ? 'var(--color-status-warning)'
        : 'var(--color-text-tertiary)';
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
    padding: '2px var(--space-2)',
    borderRadius: 'var(--radius-control)',
    background: 'transparent',
    border: `1px solid ${tone === 'quiet' ? 'var(--color-border-default)' : `color-mix(in srgb, ${color} 34%, transparent)`}`,
    color,
    fontSize: 'var(--text-label)',
    fontWeight: 600,
    lineHeight: 'var(--leading-tight)',
  };
}

// ─── Settings primitives ─────────────────────────────────────────────────────

/**
 * A bordered list whose children are rows. The hairline between rows is drawn
 * by the wrapper rather than by each row, because an inline style cannot
 * express `:not(:first-child)` and a row that draws its own top border has to
 * know where it sits — which is exactly the coupling that let the old panels
 * drift apart.
 */
function SettingsList({ children }: { children: React.ReactNode }) {
  const rows = Children.toArray(children);
  return (
    <div style={SETTINGS_LIST}>
      {rows.map((row, i) => (
        <div key={i} style={i === 0 ? undefined : { borderTop: '1px solid var(--color-border-default)' }}>
          {row}
        </div>
      ))}
    </div>
  );
}

/**
 * One settings row: what it is on the left, the control on the right.
 *
 * `flexWrap` + a `1 1 200px` text column is the whole responsive story — at
 * 320px the control wraps under the label instead of squeezing it to two
 * characters. `stack` is for controls that are a composition rather than a
 * single affordance (the nickname form, the domain-badge list).
 */
function SettingsRow({
  label,
  hint,
  control,
  stack = false,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  control?: React.ReactNode;
  stack?: boolean;
}) {
  return (
    <div
      style={{
        ...SETTINGS_ROW,
        ...(stack ? { flexDirection: 'column', alignItems: 'stretch' } : null),
      }}
    >
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        <div style={ROW_LABEL}>{label}</div>
        {hint ? <div style={ROW_HINT}>{hint}</div> : null}
      </div>
      {control ? <div style={{ flexShrink: 0, ...(stack ? { width: '100%' } : null) }}>{control}</div> : null}
    </div>
  );
}

function SettingsSection({
  title,
  note,
  children,
}: {
  title: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 'var(--space-6)' }}>
      <h3 className="os-label" style={SETTINGS_HEADING}>
        {title}
      </h3>
      {children}
      {note ? <p style={SETTINGS_NOTE}>{note}</p> : null}
    </section>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────────

function CameraIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function ChainIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function MyPage() {
  const router = useRouter();
  const { t } = useTranslation();
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

  // Push notification state (P-M global switch). `null` = not loaded yet;
  // the server's permissive default (enabled, nothing muted) only lands once
  // GET /api/push/preferences answers, so we never render a wrong "off".
  const [pushEnabled, setPushEnabled] = useState<boolean | null>(null);
  const [pushMutedCount, setPushMutedCount] = useState(0);
  const [pushLoading, setPushLoading] = useState(false);
  const [pushSaving, setPushSaving] = useState(false);
  const [pushFeedback, setPushFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

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
  /*
   * Acts once the SERVER has answered — a seeded session is a hint, and a
   * redirect or a guest verdict must not rest on one. The previous code ran
   * only after the fetch settled, and a failed lookup settles as `null`.
   */
  // Named apart from the `session` STATE this page already keeps: that one is
  // the narrowed, page-local copy; this is the shared query result.
  const { session: authSession, isVerified } = useSession();

  useEffect(() => {
    if (!isVerified) return;
    setSessionLoading(false);
    if (!authSession?.userId) {
      router.replace('/');
      return;
    }
    // Narrowed, not cast: the guard above proves `userId` is present, and the
    // query types it optional because a signed-out session has none.
    setSession({ ...authSession, userId: authSession.userId });
    if (authSession.profileImage) setProfileImage(authSession.profileImage);
    // Also fetch from profile image endpoint (session may not include it)
    apiFetch('/api/profile/image').then(r => r.ok ? r.json() : null).then(d => {
      if (d?.profileImage) setProfileImage(d.profileImage);
    }).catch(() => {});
  }, [router, authSession, isVerified]);

  const clearSession = useClearSession();

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
      // Through the cache that owns the key, so the module memo goes too — a
      // stale memo showed the previous person's name until the server disagreed.
      clearSession();

      /*
       * ERASE THE KEY MATERIAL TOO.
       *
       * Signing out used to clear the session and stop. The MLS ClientState
       * stayed in IndexedDB, this browser's leaf identity in `localStorage`,
       * and — worst, because it is not even ciphertext — the decrypted-picture
       * cache on disk. Closing the browser changed none of it, so on a shared
       * machine the next person could open the same browser and read the
       * previous person's end-to-end encrypted conversation, pictures included.
       *
       * Chat has since left the web, and this is NOT therefore unnecessary:
       * everyone who used it before today already has that material in their
       * browser, and signing out is the one moment we are certain of being able
       * to remove it.
       *
       * AWAITED, not fired and forgotten — the redirect below can tear the page
       * down mid-delete, and a half-wiped store is worse than an untouched one
       * because it looks clean. `wipeLocalKeys` never rejects, so this cannot
       * strand anyone on the settings page.
       */
      await wipeLocalKeys();

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
      setNicknameFeedback({ ok: false, msg: t('myPage.settings.nickname.validationHint') });
      return;
    }
    setNicknameSaving(true);
    setNicknameFeedback(null);
    try {
      const res = await apiFetch('/api/profile/nickname', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: trimmed }),
      });
      if (res.ok) {
        setSession((prev) => prev ? { ...prev, nickname: trimmed } : prev);
        setNicknameFeedback({ ok: true, msg: t('myPage.settings.nickname.updated') });
        setNicknameInput('');
      } else {
        const data = await res.json().catch(() => ({}));
        setNicknameFeedback({ ok: false, msg: data?.error ?? t('myPage.settings.nickname.updateFailed') });
      }
    } catch {
      setNicknameFeedback({ ok: false, msg: t('common.networkError') });
    } finally {
      setNicknameSaving(false);
    }
  }

  // Load push preferences when the settings tab is opened. Failure leaves
  // `pushEnabled` null so the section renders "couldn't load" instead of
  // claiming notifications are off.
  useEffect(() => {
    if (activeTab !== 'settings') return;
    setPushLoading(true);
    apiFetch('/api/push/preferences')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('failed'))))
      .then((data: { enabled: boolean; mutedTopicIds?: string[] }) => {
        setPushEnabled(data.enabled !== false);
        setPushMutedCount(data.mutedTopicIds?.length ?? 0);
      })
      .catch(() => setPushEnabled(null))
      .finally(() => setPushLoading(false));
  }, [activeTab]);

  async function handleTogglePush(next: boolean) {
    setPushSaving(true);
    setPushFeedback(null);
    try {
      const res = await apiFetch('/api/push/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? t('myPage.settings.notifications.updateFailed'));
      }
      // Trust the server's echo, not the requested value.
      const data = (await res.json()) as { enabled: boolean; mutedTopicIds?: string[] };
      setPushEnabled(data.enabled);
      setPushMutedCount(data.mutedTopicIds?.length ?? 0);
    } catch (err) {
      setPushFeedback({ ok: false, msg: err instanceof Error ? err.message : t('common.networkError') });
    } finally {
      setPushSaving(false);
    }
  }

  // Load domain badge status when settings tab is opened
  useEffect(() => {
    if (activeTab !== 'settings') return;
    setDomainBadgeLoading(true);
    apiFetch('/api/profile/domain-badge')
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
      const res = await apiFetch('/api/profile/domain-badge', { method: 'POST' });
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
      const res = await apiFetch('/api/profile/domain-badge', {
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
      setImageFeedback(t('profilePage.imageTooLarge'));
      return;
    }
    setImageUploading(true);
    setImageFeedback(null);
    try {
      if (profileImage) {
        const delRes = await apiFetch('/api/profile/image', { method: 'DELETE' });
        if (!delRes.ok) throw new Error(t('myPage.settings.profileImage.removeOldFailed'));
      }
      const resized = await resizeImage(file, 200);
      const form = new FormData();
      form.append('file', new File([resized], 'avatar.webp', { type: 'image/webp' }));
      form.append('purpose', 'avatar');
      // Upload deadline, not the ordinary one — the clock covers the body.
      const res = await apiFetch('/api/upload', {
        method: 'POST',
        body: form,
        timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
      });
      if (!res.ok) throw new Error(t('profilePage.uploadImageFailed'));
      const { publicUrl } = (await res.json()) as { publicUrl: string };
      const saveRes = await apiFetch('/api/profile/image', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: publicUrl }),
      });
      if (!saveRes.ok) throw new Error(t('profilePage.saveImageFailed'));
      setProfileImage(publicUrl);
      setImageFeedback(null);
    } catch (err) {
      setImageFeedback(err instanceof Error ? err.message : t('profilePage.uploadFailed'));
    } finally {
      setImageUploading(false);
      e.target.value = '';
    }
  }

  // Load my posts
  const loadMyPosts = useCallback(async (currentOffset: number, replace: boolean) => {
    setMyPostsLoading(true);
    try {
      const res = await apiFetch(`/api/my/posts?limit=${PAGE_SIZE}&offset=${currentOffset}`);
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
      const res = await apiFetch(`/api/bookmarks?limit=${PAGE_SIZE}&offset=${currentOffset}`);
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

  const loadMyTopics = useCallback(async () => {
    setMyTopicsLoading(true);
    try {
      const res = await apiFetch('/api/topics');
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
  }, [session, loadMyPosts, loadMyTopics, loadBookmarks]);

  // Infinite scroll via IntersectionObserver
  // Uses raw state to avoid referencing render-body derived vars
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const hasMore = activeTab === 'posts' ? myPostsHasMore : activeTab === 'bookmarks' ? bookmarksHasMore : false;
    const loading = activeTab === 'posts' ? myPostsLoading : activeTab === 'bookmarks' ? bookmarksLoading : false;
    const loadMore = () => {
      if (activeTab === 'posts') loadMyPosts(myPostsOffset, false);
      else if (activeTab === 'bookmarks') loadBookmarks(bookmarksOffset, false);
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
    loadMyPosts, loadBookmarks,
  ]);

  if (sessionLoading) {
    return (
      <CommunityLayout isGuest={false} sessionChecked={false}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-7) 0' }}>
          <Spinner />
        </div>
      </CommunityLayout>
    );
  }

  if (!session) return null;

  const displayName = session.nickname ?? truncateId(session.userId);
  const recordedCount = session.totalRecorded ?? 0;

  const tabs: { id: TabId; label: string }[] = [
    { id: 'posts', label: t('myPage.tabs.posts') },
    { id: 'topics', label: t('myPage.tabs.topics') },
    { id: 'bookmarks', label: t('myPage.tabs.bookmarks') },
    { id: 'settings', label: t('myPage.tabs.settings') },
  ];

  const activePosts = activeTab === 'posts' ? myPosts : activeTab === 'bookmarks' ? bookmarks : [];
  const activeLoading = activeTab === 'posts' ? myPostsLoading : activeTab === 'bookmarks' ? bookmarksLoading : myTopicsLoading;
  const activeHasMore = activeTab === 'posts' ? myPostsHasMore : activeTab === 'bookmarks' ? bookmarksHasMore : false;

  const emptyLabel = activeTab === 'posts' ? t('myPage.empty.posts') : activeTab === 'topics' ? t('myPage.empty.topics') : t('myPage.empty.bookmarks');

  const canDelete = deleteConfirmText === 'DELETE';

  return (
    <CommunityLayout isGuest={false} sessionChecked={true}>
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}

      {/* ── Identity ──────────────────────────────────────────────────────────
          "Identity is a nullifier, trust is a badge": the name, the id it is
          derived from, and the claims anyone can verify — in that order, with
          nothing else competing. */}
      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-6) 0 var(--space-5)',
        }}
      >
        <span
          onClick={() => profileImage && handleImageClick(profileImage)}
          style={{ cursor: profileImage ? 'pointer' : undefined, display: 'inline-flex' }}
        >
          <Avatar src={profileImage} name={displayName} size={72} />
        </span>

        <div style={{ maxWidth: '100%', minWidth: 0 }}>
          <h1
            style={{
              fontSize: 'var(--text-heading-sm)',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: 'var(--color-text-primary)',
              margin: 0,
              overflowWrap: 'anywhere',
            }}
          >
            {displayName}
          </h1>
          {/* The nullifier, not a wallet — mono + break-all because it is data,
              and a 66-char hash must be allowed to break anywhere. */}
          <div
            className="os-break-all"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-caption)',
              color: 'var(--color-text-tertiary)',
              marginTop: 'var(--space-1)',
            }}
          >
            {truncateId(session.userId)}
          </div>
        </div>

        {(session.role === 'admin' || recordedCount > 0) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', justifyContent: 'center' }}>
            {/* Deliberately NOT `.os-label`: that class is the uppercase-Latin
                section-heading idiom (and sets the mono face, which has no
                Hangul coverage). This is user-facing status text that
                translates — "Admin" / "관리자". */}
            {session.role === 'admin' && (
              <span style={identityChip('warning')}>{t('myPage.adminBadge')}</span>
            )}
            {recordedCount > 0 && (
              <span style={identityChip('quiet')}>
                <ChainIcon />
                {recordedCount === 1
                  ? t('myPage.recordedStatOne', { count: recordedCount })
                  : t('myPage.recordedStatOther', { count: recordedCount })}
              </span>
            )}
          </div>
        )}

        <p
          style={{
            fontSize: 'var(--text-caption)',
            color: 'var(--color-text-tertiary)',
            lineHeight: 'var(--leading-base)',
            maxWidth: '48ch',
            margin: 0,
          }}
        >
          {t('myPage.identityNote')}
        </p>
      </section>

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <div
        role="tablist"
        style={{
          display: 'flex',
          gap: 'var(--space-1)',
          borderBottom: '1px solid var(--color-border-default)',
          marginBottom: 'var(--space-5)',
          overflowX: 'auto',
        }}
      >
        {tabs.map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={selected}
              onClick={() => setActiveTab(tab.id)}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: selected ? '2px solid var(--color-brand-primary)' : '2px solid transparent',
                color: selected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--text-body-sm)',
                fontWeight: selected ? 650 : 400,
                padding: '0 var(--space-4)',
                cursor: 'pointer',
                marginBottom: -1,
                transition: 'color 0.12s, border-color 0.12s',
                minHeight: 'var(--touch-target-min)',
                whiteSpace: 'nowrap',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ── My Topics ────────────────────────────────────────────────────── */}
      {activeTab === 'topics' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {myTopicsLoading && (
            <div style={{ textAlign: 'center', padding: 'var(--space-5)', color: 'var(--color-text-tertiary)', fontSize: 'var(--text-body-sm)' }}>
              {t('common.loading')}
            </div>
          )}
          {!myTopicsLoading && myTopics.length === 0 && (
            <div style={{ textAlign: 'center', padding: 'var(--space-7) var(--space-5)', color: 'var(--color-text-tertiary)', fontSize: 'var(--text-body-sm)' }}>
              {t('myPage.empty.topics')}
            </div>
          )}
          {myTopics.map(topic => (
            <a key={topic.id} href={`/topics/${topic.id}`} style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
              padding: 'var(--space-3) var(--space-4)',
              minHeight: 'var(--touch-target-min)',
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border-default)',
              borderRadius: 'var(--radius-card)',
              textDecoration: 'none',
              color: 'inherit',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-bg-tertiary)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--color-bg-secondary)')}
            >
              <div style={{
                width: 36, height: 36, borderRadius: 'var(--radius-control)',
                background: 'var(--color-brand-primary)', color: 'var(--color-text-inverted)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'var(--text-body)', fontWeight: 700, flexShrink: 0,
              }}>
                {topic.title.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--text-body-sm)', fontWeight: 600, color: 'var(--color-text-primary)' }}>{topic.title}</div>
                {topic.memberCount !== undefined && (
                  <div style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-tertiary)' }}>
                    {topic.memberCount} {topic.memberCount === 1 ? t('rightSidebar.member') : t('rightSidebar.members')}
                  </div>
                )}
              </div>
            </a>
          ))}
        </div>
      )}

      {/* ── Posts / Bookmarks ────────────────────────────────────────────── */}
      {activeTab !== 'settings' && activeTab !== 'topics' && (
        <>
          <div style={{
            border: '1px solid var(--color-border-default)',
            borderRadius: 'var(--radius-card)',
            overflow: 'hidden',
            minHeight: 120,
          }}>
            {activeLoading && activePosts.length === 0 ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-7) 0' }}>
                <Spinner />
              </div>
            ) : activePosts.length === 0 ? (
              <div style={{
                textAlign: 'center',
                padding: 'var(--space-7) var(--space-5)',
                color: 'var(--color-text-tertiary)',
                fontSize: 'var(--text-body-sm)',
              }}>
                {emptyLabel}
              </div>
            ) : (
              activePosts.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  href={`/topics/${post.topicId}/posts/${post.id}`}
                  sessionUserId={session?.userId ?? null}
                  // Bookmarks tab shows other authors' posts — render the
                  // header so it's clear who wrote each one. My Posts
                  // hides it (the user is always the author).
                  showAuthor={activeTab === 'bookmarks'}
                  showTopic
                />
              ))
            )}
          </div>

          {/* Infinite scroll sentinel */}
          {activeHasMore && (
            <div ref={sentinelRef} style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-5) 0' }}>
              {activeLoading && <Spinner />}
            </div>
          )}
        </>
      )}

      {/* ── Settings ─────────────────────────────────────────────────────── */}
      {activeTab === 'settings' && (
        <div>
          {/* Preferences — device-level choices, signed in or not. */}
          <SettingsSection
            title={t('myPage.settings.groups.preferences')}
            note={
              pushEnabled === null ? undefined : (
                <>
                  {t('myPage.settings.notifications.explainer')}
                  {pushMutedCount > 0 && (
                    <>
                      {' '}
                      {pushMutedCount === 1
                        ? t('myPage.settings.notifications.mutedCountOne', { count: pushMutedCount })
                        : t('myPage.settings.notifications.mutedCountOther', { count: pushMutedCount })}
                    </>
                  )}
                  {' '}{t('myPage.settings.notifications.permissionNote')}
                </>
              )
            }
          >
            <SettingsList>
              <SettingsRow
                label={t('common.language')}
                hint={t('myPage.settings.language.hint')}
                control={<LocaleSwitcher />}
              />
              <SettingsRow
                label={t('myPage.settings.theme.title')}
                hint={t('myPage.settings.theme.hint')}
                control={<ThemeToggle />}
              />
              <SettingsRow
                label={t('myPage.settings.notifications.pushLabel')}
                hint={
                  pushLoading
                    ? t('common.loading')
                    : pushEnabled === null
                      ? t('myPage.settings.notifications.loadFailed')
                      : pushEnabled
                        ? t('myPage.settings.notifications.pushOnHint')
                        : t('myPage.settings.notifications.pushOffHint')
                }
                control={
                  pushLoading || pushEnabled === null ? undefined : (
                    <button
                      role="switch"
                      aria-checked={pushEnabled}
                      aria-label={t('myPage.settings.notifications.pushLabel')}
                      onClick={() => handleTogglePush(!pushEnabled)}
                      disabled={pushSaving}
                      style={{
                        width: 46,
                        height: 26,
                        flexShrink: 0,
                        borderRadius: 'var(--radius-pill)',
                        border: '1px solid ' + (pushEnabled ? 'color-mix(in srgb, var(--color-brand-primary) 50%, transparent)' : 'var(--color-border-default)'),
                        background: pushEnabled ? 'color-mix(in srgb, var(--color-brand-primary) 35%, transparent)' : 'var(--color-bg-tertiary)',
                        cursor: pushSaving ? 'not-allowed' : 'pointer',
                        opacity: pushSaving ? 0.5 : 1,
                        padding: 0,
                        position: 'relative',
                        transition: 'background 0.12s, border-color 0.12s',
                      }}
                    >
                      <span style={{
                        position: 'absolute',
                        top: 2,
                        left: pushEnabled ? 22 : 2,
                        width: 20,
                        height: 20,
                        borderRadius: 'var(--radius-pill)',
                        background: pushEnabled ? 'var(--color-brand-primary)' : 'var(--color-text-tertiary)',
                        transition: 'left 0.12s, background 0.12s',
                      }} />
                    </button>
                  )
                }
              />
            </SettingsList>
            {pushFeedback && (
              <p style={{ ...SETTINGS_NOTE, color: pushFeedback.ok ? 'var(--color-brand-accent)' : 'var(--color-status-danger)' }}>
                {pushFeedback.msg}
              </p>
            )}
          </SettingsSection>

          {/* Profile — what other members see. */}
          <SettingsSection title={t('myPage.settings.groups.profile')}>
            <SettingsList>
              <SettingsRow
                label={t('myPage.settings.profileImage.title')}
                hint={
                  <>
                    {imageUploading
                      ? t('myPage.settings.profileImage.uploading')
                      : profileImage
                        ? t('myPage.settings.profileImage.hoverToChange')
                        : t('myPage.settings.profileImage.clickToUpload')}
                    {' · '}
                    {t('myPage.settings.profileImage.autoResized')}
                    {imageFeedback && (
                      <span style={{ display: 'block', color: 'var(--color-status-danger)', marginTop: 'var(--space-1)' }}>
                        {imageFeedback}
                      </span>
                    )}
                  </>
                }
                control={
                  <label
                    style={{
                      position: 'relative',
                      width: 56,
                      height: 56,
                      borderRadius: '50%',
                      cursor: imageUploading ? 'wait' : 'pointer',
                      flexShrink: 0,
                      display: 'block',
                      overflow: 'hidden',
                      border: profileImage ? 'none' : '2px dashed var(--color-border-default)',
                      transition: 'border-color 0.15s',
                      opacity: imageUploading ? 0.5 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!profileImage) (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand-primary)';
                      const overlay = e.currentTarget.querySelector('[data-overlay]') as HTMLElement | null;
                      if (overlay) overlay.style.opacity = '1';
                    }}
                    onMouseLeave={(e) => {
                      if (!profileImage) (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border-default)';
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
                        <Avatar src={profileImage} name={displayName} size={56} />
                        <div
                          data-overlay=""
                          style={{
                            position: 'absolute',
                            inset: 0,
                            borderRadius: '50%',
                            background: 'rgba(0,0,0,0.55)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: 0,
                            transition: 'opacity 0.15s',
                            // A scrim over the user's own photo, not a page
                            // ground: it stays black and its glyph stays white
                            // in light mode too (see tokenSweep ALLOWLIST).
                            color: '#fff',
                          }}
                          aria-label={t('myPage.settings.profileImage.change')}
                        >
                          <CameraIcon size={16} />
                        </div>
                      </>
                    ) : (
                      <div style={{
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--color-text-tertiary)',
                      }}>
                        <CameraIcon size={18} />
                      </div>
                    )}
                  </label>
                }
              />

              <SettingsRow
                label={t('myPage.settings.nickname.title')}
                hint={
                  <>
                    {t('myPage.settings.nickname.currentLabel')}{' '}
                    <span style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>{displayName}</span>
                    {' · '}
                    {t('myPage.settings.nickname.validationHint')}
                  </>
                }
                stack
                control={
                  <>
                    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        value={nicknameInput}
                        onChange={(e) => { setNicknameInput(e.target.value); setNicknameFeedback(null); }}
                        placeholder={t('myPage.settings.nickname.placeholder')}
                        aria-label={t('myPage.settings.nickname.title')}
                        maxLength={30}
                        style={{
                          flex: '1 1 200px',
                          minWidth: 0,
                          background: 'var(--color-bg-primary)',
                          border: '1px solid var(--color-border-default)',
                          borderRadius: 'var(--radius-control)',
                          padding: '0 var(--space-3)',
                          color: 'var(--color-text-primary)',
                          // 16px floor: below that, iOS Safari zooms on focus.
                          fontSize: 'var(--text-body)',
                          fontFamily: 'var(--font-sans)',
                          minHeight: 'var(--touch-target-min)',
                          boxSizing: 'border-box',
                        }}
                      />
                      <button
                        className="os-button os-button-primary"
                        onClick={handleSaveNickname}
                        disabled={!nicknameInput.trim() || nicknameSaving}
                        style={{
                          cursor: !nicknameInput.trim() || nicknameSaving ? 'not-allowed' : 'pointer',
                          opacity: !nicknameInput.trim() || nicknameSaving ? 0.5 : 1,
                        }}
                      >
                        {nicknameSaving ? t('myPage.settings.nickname.saving') : t('common.save')}
                      </button>
                    </div>
                    {nicknameFeedback && (
                      <div style={{
                        marginTop: 'var(--space-2)',
                        fontSize: 'var(--text-caption)',
                        color: nicknameFeedback.ok ? 'var(--color-brand-accent)' : 'var(--color-status-danger)',
                      }}>
                        {nicknameFeedback.msg}
                      </div>
                    )}
                  </>
                }
              />

              <SettingsRow
                label={t('myPage.settings.domainBadges.title')}
                hint={
                  domainBadgeLoading
                    ? t('common.loading')
                    : domainBadgeDomains.length === 0 && !domainBadgeAvailable
                      ? t('myPage.settings.domainBadges.noneFound')
                      : t('myPage.settings.domainBadges.helpText')
                }
                stack={domainBadgeDomains.length > 0 || !!domainBadgeAvailable}
                control={
                  domainBadgeLoading || (domainBadgeDomains.length === 0 && !domainBadgeAvailable) ? undefined : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                      {domainBadgeDomains.map((d) => (
                        <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                          <span style={identityChip('accent')}>{d}</span>
                          <span style={{ flex: '1 1 auto', fontSize: 'var(--text-caption)', color: 'var(--color-text-tertiary)' }}>
                            {t('myPage.settings.domainBadges.visibleToOthers')}
                          </span>
                          <button
                            className="os-chip"
                            onClick={() => handleDomainBadgeRemove(d)}
                            disabled={domainBadgeToggling}
                            style={{
                              color: 'var(--color-status-danger)',
                              cursor: domainBadgeToggling ? 'not-allowed' : 'pointer',
                              opacity: domainBadgeToggling ? 0.5 : 1,
                            }}
                          >
                            {t('myPage.settings.domainBadges.hide')}
                          </button>
                        </div>
                      ))}

                      {domainBadgeAvailable && !domainBadgeDomains.includes(domainBadgeAvailable) && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 'var(--text-body-sm)', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                            {domainBadgeAvailable}
                          </span>
                          <span style={{ flex: '1 1 auto', fontSize: 'var(--text-caption)', color: 'var(--color-text-tertiary)' }}>
                            {t('myPage.settings.domainBadges.verifiedPrompt')}
                          </span>
                          <button
                            className="os-chip"
                            onClick={handleDomainBadgeAdd}
                            disabled={domainBadgeToggling}
                            style={{
                              color: 'var(--color-brand-primary)',
                              cursor: domainBadgeToggling ? 'not-allowed' : 'pointer',
                              opacity: domainBadgeToggling ? 0.5 : 1,
                            }}
                          >
                            {t('myPage.settings.domainBadges.show')}
                          </button>
                        </div>
                      )}
                    </div>
                  )
                }
              />
            </SettingsList>
          </SettingsSection>

          {/* AI agents / API keys — renders its own rows in this same idiom. */}
          <SettingsSection title={t('myPage.settings.aiAgents.title')}>
            <AiAgentSettings />
          </SettingsSection>

          {/* Recovery (FIX8) — mirrors mobile's ProfileStack ->
              AccountRecoveryScreen: a link OUT of the account area to the
              dedicated flow, not the flow inlined here. `/recovery`
              (`AccountRecovery.tsx`) still owns the passkey/recovery-code UI
              and stays reachable as a direct URL; this is where a signed-in
              user DISCOVERS it, replacing the old top-level header link. */}
          <SettingsSection title={t('myPage.settings.recovery.title')}>
            <SettingsList>
              <SettingsRow
                label={t('myPage.settings.recovery.title')}
                hint={t('myPage.settings.recovery.body')}
                control={
                  <Link href="/recovery" className="os-button">
                    {t('myPage.settings.recovery.cta')}
                  </Link>
                }
              />
            </SettingsList>
          </SettingsSection>

          {/* Account — sign out, and the one irreversible action. */}
          <SettingsSection title={t('myPage.settings.account.title')}>
            <SettingsList>
              <SettingsRow
                label={t('myPage.settings.account.logout')}
                hint={t('myPage.settings.account.logoutHint')}
                control={
                  <button
                    className="os-button"
                    onClick={handleLogout}
                    disabled={loggingOut}
                    style={{ opacity: loggingOut ? 0.5 : 1 }}
                  >
                    {loggingOut ? t('myPage.settings.account.loggingOut') : t('myPage.settings.account.logout')}
                  </button>
                }
              />

              <SettingsRow
                label={t('myPage.settings.dangerZone.deleteAccount')}
                hint={
                  <>
                    {t('myPage.settings.dangerZone.deleteAccountIntro')}
                    {/* Phrasing-content only (the hint slot is a <div> of running
                        text, and this sits inline within it) — hence stacked
                        <span>s rather than a <ul>. */}
                    {ownedTopicsError && (
                      <span style={{ display: 'block', marginTop: 'var(--space-2)', color: 'var(--color-status-danger)' }}>
                        <strong style={{ fontWeight: 600 }}>{t('myPage.settings.dangerZone.transferOwnershipFirst')}</strong>
                        {ownedTopicsError.map((topic) => (
                          <span key={topic.id} style={{ display: 'block' }}>{topic.title}</span>
                        ))}
                      </span>
                    )}
                  </>
                }
                stack={showDeleteAccount}
                control={
                  !showDeleteAccount ? (
                    <button
                      className="os-button"
                      onClick={() => { setShowDeleteAccount(true); setOwnedTopicsError(null); }}
                      style={{
                        color: 'var(--color-status-danger)',
                        borderColor: 'color-mix(in srgb, var(--color-status-danger) 30%, transparent)',
                      }}
                    >
                      {t('myPage.settings.dangerZone.deleteAccount')}
                    </button>
                  ) : (
                    <div>
                      <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-status-danger)', margin: '0 0 var(--space-2)' }}>
                        {/* "DELETE" is a literal confirmation keyword the app compares
                            against exactly (deleteConfirmText === 'DELETE') — kept
                            untranslated in both locales on purpose. */}
                        {t('myPage.settings.dangerZone.typeToConfirmPre')} <strong>DELETE</strong> {t('myPage.settings.dangerZone.typeToConfirmPost')}
                      </p>
                      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                        <input
                          type="text"
                          value={deleteConfirmText}
                          onChange={(e) => setDeleteConfirmText(e.target.value)}
                          placeholder="DELETE"
                          aria-label={t('myPage.settings.dangerZone.deleteAccount')}
                          style={{
                            flex: '1 1 160px',
                            minWidth: 0,
                            background: 'var(--color-bg-primary)',
                            border: '1px solid color-mix(in srgb, var(--color-status-danger) 30%, transparent)',
                            borderRadius: 'var(--radius-control)',
                            padding: '0 var(--space-3)',
                            color: 'var(--color-text-primary)',
                            // 16px floor: below that, iOS Safari zooms on focus.
                            fontSize: 'var(--text-body)',
                            fontFamily: 'var(--font-mono)',
                            minHeight: 'var(--touch-target-min)',
                            boxSizing: 'border-box',
                          }}
                        />
                        <button
                          className="os-button"
                          onClick={async () => {
                            setDeletingAccount(true);
                            setOwnedTopicsError(null);
                            try {
                              const res = await apiFetch('/api/account', { method: 'DELETE' });
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
                          disabled={!canDelete || deletingAccount}
                          style={{
                            background: canDelete ? 'var(--color-status-danger)' : 'var(--color-bg-tertiary)',
                            borderColor: canDelete ? 'var(--color-status-danger)' : 'var(--color-border-default)',
                            color: canDelete ? 'var(--color-text-inverted)' : 'var(--color-text-tertiary)',
                            cursor: canDelete ? 'pointer' : 'not-allowed',
                            opacity: deletingAccount ? 0.5 : 1,
                          }}
                        >
                          {deletingAccount ? t('myPage.settings.dangerZone.deleting') : t('myPage.settings.dangerZone.confirm')}
                        </button>
                        <button
                          className="os-button"
                          onClick={() => { setShowDeleteAccount(false); setDeleteConfirmText(''); setOwnedTopicsError(null); }}
                        >
                          {t('common.cancel')}
                        </button>
                      </div>
                    </div>
                  )
                }
              />
            </SettingsList>
          </SettingsSection>
        </div>
      )}
    </CommunityLayout>
  );
}
