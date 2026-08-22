'use client';

import { apiFetch, UPLOAD_REQUEST_TIMEOUT_MS } from '@/lib/apiFetch';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getMlsSessionStore } from '@/lib/mls/webTransport';
import Link from 'next/link';
import CommunityLayout from '@/components/CommunityLayout';
import SNSEditor from '@/components/SNSEditor';
import SNSContent from '@/components/SNSContent';
import TagInput from '@/components/TagInput';
import PostCard from '@/components/PostCard';
import Badge from '@/components/Badge';
import Spinner from '@/components/Spinner';
import TopicAvatar from '@/components/TopicAvatar';
import ImageLightbox from '@/components/ImageLightbox';
import PollEditor, { type PollEditorValue } from '@/components/PollEditor';
import PollRenderer from '@/components/PollRenderer';
import MediaGallery from '@/components/post/MediaGallery';
import ArchiveRetentionNotice from '@/components/ArchiveRetentionNotice';
import { useTranslation } from '@/lib/i18n/I18nProvider';
import InviteDialog from '@/components/InviteDialog';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Topic {
  id: string;
  title: string;
  description?: string;
  image?: string;
  memberCount: number;
  requiresCountryProof: boolean;
  visibility?: string;
  isMember: boolean;
  creatorId?: string;
  createdAt: string;
  blindedAt?: string | null;
  blindedBy?: string | null;
  // Absent on an older payload, which means unlimited — see ArchiveRetentionNotice.
  chatArchiveRetentionDays?: number;
}

interface Reaction {
  emoji: string;
  count: number;
  userReacted: boolean;
}

interface Post {
  id: string;
  title: string;
  content: string;
  authorNickname: string;
  authorProfileImage?: string | null;
  authorId: string;
  commentCount?: number;
  upvoteCount?: number;
  viewCount?: number;
  isPinned?: boolean;
  reactions?: Reaction[];
  userVoted?: number | null;
  createdAt: string;
  /** Whether the signed-in viewer is a member of this post's topic — used
   *  by PostCard to render the green "Joined" pill (W03). Server hydrates
   *  this in `/api/topics/:id/posts` based on the membership check that
   *  gates the read. */
  isJoinedTopic?: boolean;
}

const PAGE_SIZE = 20;

// ─── SVG Icons ──────────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block', animation: spinning ? 'spin 0.7s linear infinite' : 'none' }}
    >
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

// ─── Sort chips ─────────────────────────────────────────────────────────────

/** The four sort affordances, as data. They were four near-identical 25-line
 *  inline-styled buttons; the styling now comes from `.os-chip` and the only
 *  per-chip difference left is its key, its label and its glyph. */
const SORT_OPTIONS = [
  {
    key: 'new',
    labelKey: 'topicPage.sort.new',
    path: <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>,
  },
  {
    key: 'popular',
    labelKey: 'topicPage.sort.popular',
    path: <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />,
  },
  {
    key: 'recorded',
    labelKey: 'topicPage.sort.recorded',
    path: <path d="M20 6L9 17l-5-5" />,
  },
  {
    key: 'pinned',
    labelKey: 'topicPage.sort.pinned',
    path: <><path d="M12 17v5" /><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" /></>,
  },
] as const;

function SortIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function TopicPageClient() {
  const params = useParams();
  const router = useRouter();
  const { t } = useTranslation();
  const topicId = params.topicId as string;

  const [topic, setTopic] = useState<Topic | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [postsLoading, setPostsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Guest mode
  const [isGuest, setIsGuest] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);

  // Sort — "pinned" is client-side only; the API request still uses 'new'
  // and the response is filtered in memory to isPinned=true posts.
  const [sortBy, setSortBy] = useState<'new' | 'popular' | 'recorded' | 'pinned'>('new');

  // Tag filter
  const [popularTags, setPopularTags] = useState<{ id: string; name: string; slug: string; postCount: number }[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // Tag search
  const [tagSearch, setTagSearch] = useState('');
  const [tagSuggestions, setTagSuggestions] = useState<{ slug: string; name: string; postCount: number }[]>([]);
  const [showTagSuggestions, setShowTagSuggestions] = useState(false);
  const tagSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tagSearchRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Composer
  const [composing, setComposing] = useState(false);
  const [postTitle, setPostTitle] = useState('');
  const [postContent, setPostContent] = useState('');
  const [postImages, setPostImages] = useState<string[]>([]);
  const [postVideos, setPostVideos] = useState<string[]>([]);
  const [postTags, setPostTags] = useState<string[]>([]);
  const [postPoll, setPostPoll] = useState<PollEditorValue | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  /** Write / Preview toggle — mirrors the mobile PostCreateScreen
   *  segmented control so the user can see the rendered post before
   *  submitting. The mode is purely client-side; the submit button
   *  works from both Write AND Preview so Preview isn't a dead-end. */
  const [composeMode, setComposeMode] = useState<'write' | 'preview'>('write');
  /** Snapshot of the image set that was already attached when composing
   *  started. Used by Reset so the R2 cleanup never deletes media that
   *  belong elsewhere (today it's always empty because the topic page
   *  composer only handles brand-new posts, but the snapshot pattern
   *  matches the mobile screen and survives future edit reuse). */
  const initialImagesRef = useRef<string[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  function handleImageClick(src: string) {
    if (window.innerWidth <= 768 || 'ontouchstart' in window) {
      setLightboxSrc(src);
    } else {
      window.open(src, '_blank');
    }
  }

  useEffect(() => {
    apiFetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (data?.userId) {
          setSessionUserId(data.userId);
        } else {
          setIsGuest(true);
        }
      })
      .catch(() => {
        setIsGuest(true);
      })
      .finally(() => {
        setSessionChecked(true);
      });
  }, []);

  useEffect(() => {
    loadTopic();
    loadPosts(0, true, null, 'new');
    apiFetch(`/api/tags?topicId=${topicId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data?.tags) setPopularTags(data.tags); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId]);

  // One-time cleanup: remove any stale openstoa-draft-* keys left by the
  // old topic-scoped draft feature so they don't linger in localStorage.
  useEffect(() => {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('openstoa-draft-')) keysToRemove.push(key);
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch {}
  }, []);

  // Close tag suggestions on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (tagSearchRef.current && !tagSearchRef.current.contains(e.target as Node)) {
        setShowTagSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function loadTopic() {
    try {
      const res = await apiFetch(`/api/topics/${topicId}`);
      if (res.status === 401) {
        if (isGuest) { router.replace('/topics'); return; }
        router.replace('/');
        return;
      }
      if (res.status === 403) {
        if (isGuest) {
          const data = await res.json().catch(() => ({}));
          if (data.topic) {
            setTopic(data.topic);
          }
          setError('private');
          setLoading(false);
          return;
        }
        router.replace(`/topics/${topicId}/join`);
        return;
      }
      if (res.status === 404) {
        setError(t('topicPage.topicNotFound'));
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(t('topicPage.topicNotFound'));
      const data = await res.json();
      setTopic(data.topic);
      if (data.currentUserRole) setCurrentUserRole(data.currentUserRole);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('topicPage.loadTopicFailed'));
    } finally {
      setLoading(false);
    }
  }

  const loadPosts = useCallback(async (currentOffset: number, replace: boolean, tag: string | null, currentSort: string) => {
    setPostsLoading(true);
    try {
      const tagParam = tag ? `&tag=${encodeURIComponent(tag)}` : '';
      // 'pinned' is a client-side filter — request newest, then filter in memory.
      const apiSort = currentSort === 'popular' ? 'hot' : currentSort === 'pinned' ? 'new' : currentSort;
      const res = await apiFetch(
        `/api/topics/${topicId}/posts?limit=${PAGE_SIZE}&offset=${currentOffset}&sort=${apiSort}${tagParam}`,
        { cache: 'no-store' }
      );
      if (!res.ok) return;
      const data = await res.json();
      const rawPosts: Post[] = data.posts ?? [];
      const newPosts = currentSort === 'pinned'
        ? rawPosts.filter((p) => p.isPinned)
        : rawPosts;
      setPosts((prev) => (replace ? newPosts : [...prev, ...newPosts]));
      // hasMore tracks the raw page size — keep paginating even when the
      // pinned filter eats most of the page.
      setHasMore(rawPosts.length === PAGE_SIZE);
      setOffset(currentOffset + rawPosts.length);
    } finally {
      setPostsLoading(false);
    }
  }, [topicId]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !postsLoading) {
          loadPosts(offset, false, activeTag, sortBy);
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, postsLoading, offset, activeTag, sortBy, loadPosts]);

  function handleTagSelect(slug: string | null) {
    setActiveTag(slug);
    setTagSearch('');
    setTagSuggestions([]);
    setShowTagSuggestions(false);
    setOffset(0);
    loadPosts(0, true, slug, sortBy);
  }

  function handleSortChange(newSort: 'new' | 'popular' | 'recorded' | 'pinned') {
    if (newSort === sortBy) return;
    setSortBy(newSort);
    setOffset(0);
    loadPosts(0, true, activeTag, newSort);
  }

  function handleTagSearchChange(value: string) {
    setTagSearch(value);
    if (tagSearchTimer.current) clearTimeout(tagSearchTimer.current);
    if (!value.trim()) {
      setTagSuggestions([]);
      setShowTagSuggestions(false);
      return;
    }
    tagSearchTimer.current = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/tags?topicId=${topicId}&q=${encodeURIComponent(value.trim())}`);
        if (!res.ok) return;
        const data = await res.json();
        setTagSuggestions(data.tags ?? []);
        setShowTagSuggestions(true);
      } catch {}
    }, 300);
  }

  function handlePinPost(postId: string) {
    loadPosts(0, true, activeTag, sortBy);
  }


  /**
   * Leave the topic.
   *
   * Two-step, like the kick and transfer controls on the members page: the
   * first press asks, the second acts. Leaving costs this device its view of
   * the chat history, so it should not be one stray tap away.
   *
   * The local group state goes too. Nobody else can reach into this device to
   * delete it, and holding a live ratchet for a room you left is exactly what a
   * later compromise of this device would open. Best-effort: the membership row
   * is what gates access, so a storage failure must not block the exit.
   */
  async function handleLeave() {
    if (!confirmLeave) {
      setConfirmLeave(true);
      return;
    }
    setLeaving(true);
    try {
      const res = await apiFetch(`/api/topics/${topicId}/leave`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 409 is the owner case and deserves the instruction, not the generic
        // failure — "failed to leave" tells an owner nothing about what to do.
        throw new Error(
          res.status === 409
            ? t('membersPage.leaveOwnerBlocked')
            : (data.error ?? t('membersPage.leaveFailed')),
        );
      }
      try {
        await getMlsSessionStore().forgetTopic(topicId);
      } catch {
        /* the membership row is gone either way */
      }
      router.push('/topics/explore');
    } catch (err) {
      setLeaveError(err instanceof Error ? err.message : t('membersPage.leaveFailed'));
      setConfirmLeave(false);
    } finally {
      setLeaving(false);
    }
  }

  function isComposerEmpty(): boolean {
    return !postContent.trim() && postImages.length === 0 && postVideos.length === 0;
  }

  /** Did the user fill in anything besides the blank-form default?
   *  Used to skip the Reset confirmation dialog when the composer is
   *  already empty. */
  function hasComposerContent(): boolean {
    return !!(
      postTitle.trim() ||
      postContent.trim() ||
      postTags.length > 0 ||
      postImages.length > 0 ||
      postVideos.length > 0 ||
      postPoll
    );
  }

  /** Wipe every composer field + draft + best-effort R2 cleanup. Mirrors
   *  the mobile Reset button: any images uploaded **during this composing
   *  session** (i.e. not present in the initial snapshot) are deleted from
   *  R2 so they don't leak as orphans. Failure is silent — cleanup runs
   *  fire-and-forget, the user-facing reset isn't blocked on the network. */
  function handleComposerReset() {
    if (!hasComposerContent()) return;
    const ok = window.confirm(t('topicPage.composer.resetConfirm'));
    if (!ok) return;

    const initial = new Set(initialImagesRef.current);
    const orphans = postImages.filter((u) => !initial.has(u));
    if (orphans.length > 0) {
      // Fire-and-forget — same pattern as the mobile screen's R2 sweep.
      void apiFetch('/api/upload', {
      // A multi-megabyte body going up: the ordinary deadline covers the
      // WHOLE exchange, so 15s would cut off a transfer that is making progress.
      timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: orphans }),
      }).catch(() => {});
    }

    setPostTitle('');
    setPostContent('');
    setPostTags([]);
    setPostImages([]);
    setPostVideos([]);
    setPostPoll(null);
    setComposeMode('write');
    setPostError(null);
  }

  async function handlePostSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!postTitle.trim() || isComposerEmpty()) return;
    setSubmitting(true);
    setPostError(null);
    try {
      // Strip empty option strings before submit — backend rejects polls with
      // fewer than 2 non-empty options, surface that as a friendlier inline
      // error before we even POST.
      let pollPayload: { question?: string; options: string[]; multipleChoice: boolean; closesAt?: string } | undefined;
      if (postPoll) {
        const opts = postPoll.options.map((o) => o.trim()).filter((o) => o.length > 0 && o.length <= 80);
        if (opts.length < 2 || opts.length > 4) {
          throw new Error(t('topicPage.composer.pollOptionsError'));
        }
        pollPayload = {
          options: opts,
          multipleChoice: postPoll.multipleChoice,
          ...(postPoll.question?.trim() ? { question: postPoll.question.trim() } : {}),
          ...(postPoll.closesAt ? { closesAt: postPoll.closesAt } : {}),
        };
      }

      const res = await apiFetch(`/api/topics/${topicId}/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: postTitle.trim(),
          content: postContent,
          media: { images: postImages, videos: postVideos },
          tags: postTags.length > 0 ? postTags : undefined,
          ...(pollPayload ? { poll: pollPayload } : {}),
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? t('topicPage.composer.postFailed'));
      }
      setPostTitle('');
      setPostContent('');
      setPostImages([]);
      setPostVideos([]);
      setPostTags([]);
      setPostPoll(null);
      setComposeMode('write');
      setComposing(false);
      loadPosts(0, true, activeTag, sortBy);
    } catch (err) {
      setPostError(err instanceof Error ? err.message : t('editTopicPage.unknownError'));
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Loading state ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <CommunityLayout isGuest={isGuest} sessionChecked={sessionChecked}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-7) 0' }}>
          <Spinner />
        </div>
      </CommunityLayout>
    );
  }

  // ─── Guest + private topic ────────────────────────────────────────────────
  if (isGuest && error === 'private') {
    return (
      <CommunityLayout isGuest={isGuest} sessionChecked={sessionChecked}>
        <div style={{ marginBottom: 'var(--space-5)' }}>
          <Link href="/topics" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 'var(--text-caption)' }}>
            {'\u2190'} {t('topicPage.topicsBreadcrumb')}
          </Link>
        </div>
        <div style={{
          textAlign: 'center',
          padding: 'var(--space-7) var(--space-5)',
          border: '1px dashed var(--border)',
          borderRadius: 'var(--radius-modal)',
        }}>
          <p style={{ fontSize: 'var(--text-heading-lg)', margin: '0 0 var(--space-3)' }}>{'\uD83D\uDD12'}</p>
          <p style={{ fontSize: 'var(--text-body-lg)', fontWeight: 600, letterSpacing: '-0.02em', margin: '0 0 var(--space-2)' }}>
            {t('topicPage.privateTopic.title')}
          </p>
          {/* Prose measure, centred: the explanation is running text, and at
              1600px it would otherwise stretch the full column width. */}
          <p style={{
            fontSize: 'var(--text-body)',
            color: 'var(--muted)',
            margin: '0 auto var(--space-5)',
            maxWidth: 'var(--read-max)',
          }}>
            {t('topicPage.privateTopic.body')}
          </p>
          <Link href="/" className="os-button os-button-primary">
            {t('header.signIn')}
          </Link>
        </div>
      </CommunityLayout>
    );
  }

  // ─── Error state ──────────────────────────────────────────────────────────
  if (error || !topic) {
    return (
      <CommunityLayout isGuest={isGuest} sessionChecked={sessionChecked}>
        <div style={{ padding: 'var(--space-6) 0', textAlign: 'center' }}>
          <p style={{ color: 'var(--color-status-danger)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-body-sm)', margin: '0 0 var(--space-3)' }}>
            {error ?? t('topicPage.topicNotFound')}
          </p>
          <Link href="/topics" style={{ color: 'var(--accent)', fontSize: 'var(--text-body-sm)' }}>
            {'\u2190'} {t('editTopicPage.backToTopics')}
          </Link>
        </div>
      </CommunityLayout>
    );
  }

  // ─── Main render ──────────────────────────────────────────────────────────
  return (
    <CommunityLayout
      isGuest={isGuest}
      sessionChecked={sessionChecked}
      topicId={topicId}
      topicTitle={topic.title}
      topicDescription={topic.description}
      topicMemberCount={topic.memberCount}
      isMember={topic?.isMember}
    >
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}

      {/* Breadcrumb */}
      <div style={{ marginBottom: 'var(--space-5)' }}>
        <Link href="/topics" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 'var(--text-caption)' }}>
          {'\u2190'} {t('topicPage.topicsBreadcrumb')}
        </Link>
      </div>

      {/* Guest banner */}
      {isGuest && (
        <div
          style={{
            padding: 'var(--space-3) var(--space-4)',
            background: 'color-mix(in srgb, var(--color-brand-primary) 6%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-brand-primary) 12%, transparent)',
            borderRadius: 'var(--radius-control)',
            marginBottom: 'var(--space-5)',
            fontSize: 'var(--text-body-sm)',
            color: 'var(--color-text-secondary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
          }}
        >
          <span>{t('topicPage.guestBanner')}</span>
          <Link
            href="/"
            style={{
              color: 'var(--accent)',
              textDecoration: 'none',
              fontWeight: 600,
              fontSize: 'var(--text-caption)',
              whiteSpace: 'nowrap',
            }}
          >
            {t('header.signIn')}
          </Link>
        </div>
      )}

      {/* Blinded banner */}
      {topic.blindedAt && (
        <div
          style={{
            padding: 'var(--space-3) var(--space-4)',
            background: 'color-mix(in srgb, var(--color-status-danger) 6%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-status-danger) 15%, transparent)',
            borderRadius: 'var(--radius-control)',
            marginBottom: 'var(--space-4)',
            fontSize: 'var(--text-body-sm)',
            color: 'var(--color-status-danger)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
          }}
        >
          <span>{topic.blindedBy === 'admin' ? t('topicPage.blindedByAdmin') : t('topicPage.blindedGeneric')}</span>
        </div>
      )}

      {/* ── Topic header ──────────────────────────────────────────────────
          The prototype's `.topichdr`: no card, a page heading at the top of
          the scale, prose capped at the reading measure, the facts on ONE
          meta line, and the join/invite action as a real `.os-button`
          instead of a bespoke 7px-padded control. The block is separated
          from the feed by a rule, not by a filled panel — the posts below
          are the content, and a tinted box around the header competed with
          them for weight. */}
      <header
        style={{
          borderBottom: '1px solid var(--color-border-default)',
          paddingBottom: 'var(--space-4)',
          marginBottom: 'var(--space-5)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
          <TopicAvatar
            name={topic.title}
            image={topic.image}
            size={44}
            onClick={topic.image ? () => handleImageClick(topic.image!) : undefined}
          />
          {/* `minWidth: 0` so a long unbroken title shrinks inside the flex
              row instead of pushing the avatar off the 320px viewport. No
              nowrap/ellipsis: the title is the one thing on this page that
              must be readable in full, in any language. */}
          <h1
            style={{
              fontSize: 'var(--text-heading-lg)',
              fontWeight: 800,
              letterSpacing: '-0.02em',
              lineHeight: 'var(--leading-tight)',
              margin: 0,
              minWidth: 0,
              color: 'var(--color-text-primary)',
            }}
          >
            {topic.title}
          </h1>
        </div>

        {topic.description && (
          <p
            style={{
              margin: '0 0 var(--space-3)',
              maxWidth: 'var(--read-max)',
              fontSize: 'var(--text-body)',
              color: 'var(--color-text-secondary)',
            }}
          >
            {topic.description}
          </p>
        )}

        {/* Facts + actions on one meta line. Wraps at phone widths; the
            action group keeps to the trailing edge on desktop. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
            fontSize: 'var(--text-caption)',
            color: 'var(--color-text-secondary)',
          }}
        >
          {!isGuest ? (
            <Link
              href={`/topics/${topicId}/members`}
              style={{ color: 'inherit', textDecoration: 'none' }}
            >
              <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)' }}>{topic.memberCount}</b>
              {' '}
              {topic.memberCount === 1 ? t('rightSidebar.member') : t('rightSidebar.members')}
            </Link>
          ) : (
            <span>
              <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)' }}>{topic.memberCount}</b>
              {' '}
              {topic.memberCount === 1 ? t('rightSidebar.member') : t('rightSidebar.members')}
            </span>
          )}

          {/* Evidence chips — ONE treatment. The proof requirement is a
              verified-tone claim, so it goes through `Badge` like every
              other claim on the surface instead of a hand-rolled tinted
              pill that only this page knew about. */}
          {topic.requiresCountryProof && (
            <Badge type="country" label={t('joinPage.proofBadge.country')} />
          )}
          {!isGuest && topic.isMember && (
            <span
              className="os-label"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                // Same outline-on-transparent as Badge's verified tone —
                // there is no accent-muted step, so a tint would be a
                // second treatment for the same meaning.
                color: 'var(--color-brand-accent)',
                background: 'transparent',
                border: '1px solid var(--color-brand-accent)',
                borderRadius: 'var(--radius-control)',
                padding: '1px 6px',
                lineHeight: 1.2,
              }}
              aria-label={t('topicPage.joinedTopicAriaLabel')}
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {t('postCard.joined')}
            </span>
          )}

          {/* Members live with the window; the admin who chose it does not have
              to tell them. Shown to members only — it describes the chat room,
              which is members-only in every tier. */}
          {!isGuest && topic.isMember && (
            <ArchiveRetentionNotice days={topic.chatArchiveRetentionDays} />
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              flexWrap: 'wrap',
              marginLeft: 'auto',
            }}
          >
            {!isGuest && currentUserRole === 'owner' && (
              <Link href={`/topics/${topicId}/edit`} className="os-button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
                {t('topicPage.edit')}
              </Link>
            )}
            {!isGuest && (currentUserRole === 'owner' || currentUserRole === 'admin') && (
              <Link href={`/topics/${topicId}/members`} className="os-button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                {t('topicPage.manage')}
              </Link>
            )}
            {/* Who sees an Invite button.
                On a non-public topic the invite route answers 403 to anyone
                but the owner or an admin, so showing the control to a plain
                member offers an action that always fails — the same reasoning
                as the missing Leave button below. */}
            {!isGuest && topic.isMember &&
              (topic.visibility === 'public' || currentUserRole === 'owner' || currentUserRole === 'admin') && (
              <button
                type="button"
                onClick={() => setInviteOpen(true)}
                className="os-button"
              >
                {t('membersPage.invite')}
              </button>
            )}
            {!isGuest && !topic.isMember && (
              <Link href={`/topics/${topicId}/join`} className="os-button os-button-primary">
                {t('explorePage.join')}
              </Link>
            )}
            {/* The owner has no leave button: leaving would strand a topic
                nobody can administer, and the route refuses it anyway. Showing
                a control that always fails is worse than not showing it. */}
            {!isGuest && topic.isMember && topic.creatorId !== sessionUserId && (
              <button
                type="button"
                onClick={handleLeave}
                onBlur={() => setConfirmLeave(false)}
                disabled={leaving}
                className="os-button"
                style={confirmLeave ? { color: 'var(--color-status-danger)', borderColor: 'var(--color-status-danger)' } : undefined}
                title={confirmLeave ? t('membersPage.leaveExplain') : undefined}
              >
                {leaving
                  ? t('membersPage.leaving')
                  : confirmLeave
                    ? t('membersPage.leaveConfirm')
                    : t('membersPage.leave')}
              </button>
            )}
          </div>
          {/* Surfaced inline rather than in an alert(): the owner case is an
              instruction ("transfer ownership first"), and an instruction the
              user has to dismiss before they can act on it is worse than one
              they can read while they act. */}
          {leaveError && (
            <p
              role="alert"
              style={{
                margin: 'var(--space-2) 0 0',
                color: 'var(--color-status-danger)',
                fontSize: 'var(--text-body-sm)',
              }}
            >
              {leaveError}
            </p>
          )}
        </div>
      </header>

      {/* ── Tag search + filter bar ── */}
      <div style={{ marginBottom: 'var(--space-3)' }}>
        {/* Tag search input — `.os-input` carries the 16px floor (below it,
            iOS Safari zooms the page on focus) and the 44px target. */}
        <div ref={tagSearchRef} style={{ position: 'relative', marginBottom: 'var(--space-2)' }}>
          <input
            type="text"
            className="os-input"
            placeholder={t('topicPage.searchTagsPlaceholder')}
            value={tagSearch}
            onChange={(e) => handleTagSearchChange(e.target.value)}
            onFocus={() => { if (tagSuggestions.length > 0) setShowTagSuggestions(true); }}
          />
          {showTagSuggestions && tagSuggestions.length > 0 && (
            <div style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              marginTop: 'var(--space-1)',
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border-default)',
              borderRadius: 'var(--radius-control)',
              overflow: 'hidden',
              zIndex: 20,
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            }}>
              {tagSuggestions.map((tag) => (
                <button
                  key={tag.slug}
                  onClick={() => handleTagSelect(tag.slug)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    minHeight: 'var(--touch-target-min)',
                    background: 'none',
                    border: 'none',
                    padding: 'var(--space-2) var(--space-4)',
                    color: 'var(--color-text-primary)',
                    fontSize: 'var(--text-body-sm)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-tertiary)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none'; }}
                >
                  <span>#{tag.name}</span>
                  <span style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>{tag.postCount}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Popular tag chips — `.os-chip`, the one filter-chip treatment.
            Selection reads as "raised" (`aria-pressed`), not as a row of
            brand-filled pills shouting over the posts they filter. */}
        {popularTags.length > 0 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            flexWrap: 'wrap',
          }}>
            <button
              type="button"
              className="os-chip"
              aria-pressed={activeTag === null}
              onClick={() => handleTagSelect(null)}
            >
              {t('topicPage.allTags')}
            </button>
            {popularTags.slice(0, 8).map((tag) => (
              <button
                key={tag.id}
                type="button"
                className="os-chip"
                aria-pressed={activeTag === tag.slug}
                onClick={() => handleTagSelect(tag.slug)}
              >
                #{tag.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Sort chips ────────────────────────────────────────────────────
          The prototype's `.tools`: a bare row on the page ground. The
          previous brand-tinted panel (R09) wrapped the row in a second
          container so the filters read as "within this topic" — the topic
          header above now says that far more directly, and a tinted box
          here re-introduced exactly the panel-around-controls idiom this
          screen is losing everywhere else. Selection is `.os-chip`'s quiet
          raised state, carried by `aria-pressed` so it is announced, not
          just seen. */}
      {/* eslint-disable-next-line react/no-unknown-property */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{
        marginBottom: 'var(--space-4)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        flexWrap: 'wrap',
      }}>
        {SORT_OPTIONS.map(({ key, labelKey, path }) => (
          <button
            key={key}
            type="button"
            className="os-chip"
            aria-pressed={sortBy === key}
            onClick={() => handleSortChange(key)}
          >
            <SortIcon>{path}</SortIcon>
            {t(labelKey)}
          </button>
        ))}
        {/* Manual refresh — resets to page 0 and re-fetches with no-store */}
        <button
          type="button"
          className="os-chip"
          onClick={() => { setOffset(0); loadPosts(0, true, activeTag, sortBy); }}
          disabled={postsLoading}
          title={t('topicPage.refreshPosts')}
          aria-label={t('topicPage.refreshPosts')}
          style={{ marginLeft: 'auto', flexShrink: 0 }}
        >
          <RefreshIcon spinning={postsLoading} />
        </button>
      </div>

      {/* ── Feed ── */}
      <div>
        {/* Composer (expanded) -- hidden for guests */}
        {sessionChecked && !isGuest && topic?.isMember && composing && (
          <div style={{
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-brand-primary)',
            borderRadius: 'var(--radius-card)',
            padding: 'var(--space-5)',
            marginBottom: 'var(--space-2)',
          }}>
            <form onSubmit={handlePostSubmit}>
              {/* Header row — title + Write/Preview toggle + Reset button.
                  Mirrors the mobile PostCreateScreen's segmentRow so the
                  composer feels the same across platforms. The toggle is
                  client-side only; submit lives outside it so the user can
                  post directly from Preview without round-tripping back to
                  Write just to tap the button. */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 'var(--space-4)',
                gap: 'var(--space-3)',
                flexWrap: 'wrap',
              }}>
                <h3 style={{ fontSize: 'var(--text-body)', fontWeight: 700, margin: 0, letterSpacing: '-0.02em', color: 'var(--color-text-primary)' }}>
                  {t('topicPage.composer.newPost')}
                </h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <div
                    role="tablist"
                    aria-label={t('topicPage.composer.modeAriaLabel')}
                    style={{
                      display: 'inline-flex',
                      background: 'var(--color-bg-secondary)',
                      border: '1px solid var(--color-border-default)',
                      borderRadius: 'var(--radius-control)',
                      padding: 2,
                      gap: 2,
                    }}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={composeMode === 'write'}
                      onClick={() => setComposeMode('write')}
                      style={{
                        background: composeMode === 'write' ? 'var(--color-brand-primary-muted)' : 'transparent',
                        color: composeMode === 'write' ? 'var(--accent)' : 'var(--color-text-secondary)',
                        border: 'none',
                        borderRadius: 'var(--radius-control)',
                        padding: 'var(--space-2) var(--space-3)',
                        fontSize: 'var(--text-caption)',
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontFamily: 'var(--font-mono)',
                        letterSpacing: '0.02em',
                        transition: 'all 0.12s',
                      }}
                    >
                      {t('topicPage.composer.write')}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={composeMode === 'preview'}
                      onClick={() => setComposeMode('preview')}
                      style={{
                        background: composeMode === 'preview' ? 'var(--color-brand-primary-muted)' : 'transparent',
                        color: composeMode === 'preview' ? 'var(--accent)' : 'var(--color-text-secondary)',
                        border: 'none',
                        borderRadius: 'var(--radius-control)',
                        padding: 'var(--space-2) var(--space-3)',
                        fontSize: 'var(--text-caption)',
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontFamily: 'var(--font-mono)',
                        letterSpacing: '0.02em',
                        transition: 'all 0.12s',
                      }}
                    >
                      {t('topicPage.composer.preview')}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleComposerReset}
                    disabled={!hasComposerContent()}
                    title={t('topicPage.composer.reset')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 'var(--space-1)',
                      background: 'transparent',
                      color: hasComposerContent() ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)',
                      border: '1px solid var(--color-border-default)',
                      borderRadius: 'var(--radius-control)',
                      padding: 'var(--space-2) var(--space-3)',
                      fontSize: 'var(--text-caption)',
                      fontWeight: 600,
                      cursor: hasComposerContent() ? 'pointer' : 'not-allowed',
                      fontFamily: 'var(--font-mono)',
                      letterSpacing: '0.02em',
                      transition: 'all 0.12s',
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1 4 1 10 7 10" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                    {t('topicPage.composer.reset')}
                  </button>
                </div>
              </div>

              {composeMode === 'write' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                  <input
                    type="text"
                    value={postTitle}
                    onChange={(e) => setPostTitle(e.target.value)}
                    placeholder={t('topicPage.composer.postTitlePlaceholder')}
                    autoFocus
                    style={{
                      width: '100%',
                      background: 'var(--color-bg-secondary)',
                      border: '1px solid var(--color-border-default)',
                      borderRadius: 'var(--radius-control)',
                      padding: 'var(--space-3) var(--space-4)',
                      color: 'var(--color-text-primary)',
                      // var(--text-body) = 16px: below that, iOS Safari zooms the page on focus.
                      fontSize: 'var(--text-body)',
                      fontWeight: 600,
                      outline: 'none',
                      boxSizing: 'border-box',
                      minHeight: 'var(--touch-target-min)',
                    }}
                  />
                  <SNSEditor
                    topicId={topicId}
                    placeholder={t('topicPage.composer.writePostPlaceholder')}
                    onChange={(state) => {
                      setPostContent(state.content);
                      setPostImages(state.images);
                      setPostVideos(state.videos);
                    }}
                    minHeight={180}
                  />
                  <div style={{ marginTop: 'var(--space-1)' }}>
                    <TagInput tags={postTags} onChange={setPostTags} topicId={topicId} />
                  </div>

                  {/* Poll toggle + editor */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <button
                      type="button"
                      onClick={() => {
                        if (postPoll) {
                          setPostPoll(null);
                        } else {
                          setPostPoll({
                            question: '',
                            options: ['', ''],
                            multipleChoice: false,
                            closesAt: null,
                          });
                        }
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 'var(--space-1)',
                        background: postPoll ? 'var(--color-brand-primary-muted)' : 'var(--color-bg-secondary)',
                        color: postPoll ? 'var(--accent)' : 'var(--color-text-secondary)',
                        border: postPoll ? '1px solid var(--color-brand-primary)' : '1px solid var(--color-border-default)',
                        borderRadius: 'var(--radius-control)',
                        padding: 'var(--space-2) var(--space-3)',
                        fontSize: 'var(--text-caption)',
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontFamily: 'var(--font-mono)',
                        transition: 'all 0.12s',
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="3" width="12" height="2.5" rx="0.5" />
                        <rect x="2" y="6.75" width="9" height="2.5" rx="0.5" />
                        <rect x="2" y="10.5" width="6" height="2.5" rx="0.5" />
                      </svg>
                      {postPoll ? t('pollEditor.removePoll') : t('topicPage.composer.addPoll')}
                    </button>
                  </div>
                  {postPoll && (
                    <PollEditor
                      value={postPoll}
                      onChange={setPostPoll}
                      onRemove={() => setPostPoll(null)}
                    />
                  )}
                </div>
              ) : (
                // Preview mode — render the post using the same components
                // PostDetail uses so what the user sees here matches the
                // final post one-for-one (title, tags, body, media,
                // poll). Submit is below the switch, so the user can post
                // straight from this view.
                <div
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-card)',
                    padding: 'var(--space-4) var(--space-5)',
                    background: 'var(--color-bg-primary)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-3)',
                  }}
                >
                  {postTitle.trim() ? (
                    <h2 style={{
                      fontSize: 'var(--text-heading-sm)',
                      fontWeight: 800,
                      letterSpacing: '-0.03em',
                      margin: 0,
                      lineHeight: 1.3,
                      color: 'var(--color-text-primary)',
                    }}>
                      {postTitle}
                    </h2>
                  ) : (
                    <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-tertiary)', margin: 0, fontFamily: 'var(--font-mono)' }}>
                      {t('topicPage.composer.titleEmpty')}
                    </p>
                  )}
                  {postTags.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}>
                      {postTags.map((tag) => (
                        <span
                          key={tag}
                          style={{
                            background: 'color-mix(in srgb, var(--color-brand-primary) 8%, transparent)',
                            color: 'var(--accent)',
                            border: '1px solid color-mix(in srgb, var(--color-brand-primary) 15%, transparent)',
                            borderRadius: 'var(--radius-control)',
                            padding: '2px var(--space-2)',
                            fontSize: 'var(--text-label)',
                            fontFamily: 'var(--font-mono)',
                            lineHeight: 1.6,
                          }}
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {postContent.trim() || postImages.length > 0 || postVideos.length > 0 ? (
                    // Match PostDetail's exact split — text body via SNSContent
                    // (without mediaImages/mediaVideos to avoid duplication),
                    // then MediaGallery handles the swipeable carousel for
                    // both images and embedded videos. That keeps the preview
                    // pixel-identical to the post the user is about to ship.
                    <>
                      {/* Preview mirrors PostDetail exactly: text body
                          via SNSContent (with `stripInlineImages` so we
                          don't double-render images the user attached
                          via the composer toolbar — those flow through
                          MediaGallery below), then the swipeable
                          gallery. */}
                      <SNSContent html={postContent} stripInlineImages />
                      <MediaGallery images={postImages} videos={postVideos} mode="detail" />
                    </>
                  ) : (
                    <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-tertiary)', margin: 0, fontFamily: 'var(--font-mono)' }}>
                      {t('topicPage.composer.bodyEmpty')}
                    </p>
                  )}
                  {postPoll && postPoll.options.filter((o) => o.trim()).length >= 2 && (
                    <PollRenderer
                      poll={{
                        id: 'preview',
                        postId: 'preview',
                        question: postPoll.question ?? null,
                        multipleChoice: postPoll.multipleChoice,
                        closesAt: postPoll.closesAt ?? null,
                        isClosed: false,
                        totalVotes: 0,
                        userVotedOptionIds: [],
                        options: postPoll.options
                          .map((o) => o.trim())
                          .filter((o) => o.length > 0)
                          .map((text, i) => ({
                            id: `preview-${i}`,
                            text,
                            position: i,
                            voteCount: 0,
                          })),
                      }}
                      onVote={async () => { /* preview only — no submit */ }}
                      onUnvote={async () => { /* preview only */ }}
                    />
                  )}
                </div>
              )}

              {postError && (
                <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--color-status-danger)', margin: 'var(--space-3) 0 0', fontFamily: 'var(--font-mono)' }}>
                  {postError}
                </p>
              )}
              <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', marginTop: 'var(--space-3)' }}>
                <button
                  type="button"
                  onClick={() => {
                    setComposing(false);
                    setPostTitle('');
                    setPostContent('');
                    setPostImages([]);
                    setPostVideos([]);
                    setPostTags([]);
                    setPostPoll(null);
                    setComposeMode('write');
                  }}
                  className="os-button"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  className="os-button os-button-primary"
                  disabled={!postTitle.trim() || isComposerEmpty() || submitting}
                  style={{
                    opacity: (!postTitle.trim() || isComposerEmpty() || submitting) ? 0.5 : 1,
                  }}
                >
                  {submitting ? t('topicPage.composer.posting') : t('topicPage.composer.post')}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Posts sit directly on the page ground, separated by rules — the
            prototype's `article{border-top:1px solid var(--rule)}`. The old
            rounded, bordered container drew a box around the feed and made
            the posts read as contents of a widget rather than as the page
            itself. `PostCard` draws the rule below each row, so the wrapper
            supplies only the leading one. */}
        <div style={{ borderTop: '1px solid var(--color-border-default)' }}>
          {posts.length === 0 && !postsLoading ? (
            <div style={{
              textAlign: 'center',
              padding: 'var(--space-7) var(--space-5)',
            }}>
              <p style={{ fontSize: 'var(--text-body)', color: 'var(--color-text-tertiary)', margin: 0 }}>
                {isGuest ? t('topicPage.empty.guest') : t('topicPage.empty.member')}
              </p>
            </div>
          ) : (
            posts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                href={`/topics/${topicId}/posts/${post.id}`}
                showAuthor
                isPinned={post.isPinned}
                userVoted={isGuest ? null : post.userVoted}
                reactions={post.reactions}
                sessionUserId={sessionUserId}
                authorId={post.authorId}
                topicCreatorId={topic?.creatorId}
                onDelete={isGuest ? undefined : (id) => setPosts((prev) => prev.filter((p) => p.id !== id))}
                onPin={isGuest ? undefined : handlePinPost}
                expandable
              />
            ))
          )}
        </div>

        {/* Infinite scroll sentinel */}
        {hasMore && (
          <div ref={sentinelRef} style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-5) 0' }}>
            {postsLoading && <Spinner />}
          </div>
        )}
      </div>

      {/* Floating compose button -- hidden for guests */}
      {sessionChecked && !isGuest && topic?.isMember && !composing && (
        <button
          onClick={() => setComposing(true)}
          // `right` comes from CSS (CommunityLayout) so the button can step
          // aside for the live chat column instead of covering its composer.
          className="topic-compose-fab"
          style={{
            position: 'fixed',
            bottom: 32,
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: 'var(--accent)',
            color: 'var(--color-text-inverted)',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 4px 24px color-mix(in srgb, var(--color-brand-primary) 30%, transparent)',
            transition: 'transform 0.15s, box-shadow 0.15s',
            zIndex: 50,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.08)';
            e.currentTarget.style.boxShadow = '0 6px 32px color-mix(in srgb, var(--color-brand-primary) 40%, transparent)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
            e.currentTarget.style.boxShadow = '0 4px 24px color-mix(in srgb, var(--color-brand-primary) 30%, transparent)';
          }}
          title={t('topicPage.composer.writePost')}
        >
          <PlusIcon />
        </button>
      )}
      <InviteDialog
        topicId={topicId}
        visibility={topic?.visibility}
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
      />
    </CommunityLayout>
  );
}
