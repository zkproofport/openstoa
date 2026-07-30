'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import CommunityLayout from '@/components/CommunityLayout';
import Avatar from '@/components/Avatar';
import Badge from '@/components/Badge';
import Spinner from '@/components/Spinner';
import UserCard from '@/components/UserCard';
import { useChatRail } from '@/lib/chatRailContext';
import { invalidateDmCandidates } from '@/lib/dmCandidatesCache';
import { useTranslation } from '@/lib/i18n/I18nProvider';

interface Member {
  userId: string;
  nickname: string;
  role: 'owner' | 'admin' | 'member';
  profileImage?: string | null;
  badges?: Array<{ type: string; label: string; domain?: string; country?: string }>;
}

interface JoinRequest {
  id: string;
  userId: string;
  nickname: string;
  profileImage?: string | null;
  status: string;
  createdAt: string;
}

interface Topic {
  id: string;
  title: string;
  visibility?: string;
}

const AVATAR_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#22c55e', '#06b6d4', '#eab308'];

function TopicAvatar({ title, size = 40 }: { title: string; size?: number }) {
  const colorIndex = title.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % AVATAR_COLORS.length;
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: '50%',
      background: AVATAR_COLORS[colorIndex],
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: size * 0.45,
      fontWeight: 700,
      color: '#fff',
      flexShrink: 0,
    }}>
      {title.slice(0, 1).toUpperCase()}
    </div>
  );
}

export default function MembersPage() {
  const params = useParams();
  const router = useRouter();
  const { t, locale } = useTranslation();
  const topicId = params.topicId as string;

  const [topic, setTopic] = useState<Topic | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmKick, setConfirmKick] = useState<string | null>(null);
  const [confirmTransfer, setConfirmTransfer] = useState<string | null>(null);
  const [transferLoading, setTransferLoading] = useState(false);
  const [tab, setTab] = useState<'members' | 'requests'>('members');
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestActionLoading, setRequestActionLoading] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  // userId whose DM is being started — drives the button's pending look.
  const [dmLoading, setDmLoading] = useState<string | null>(null);
  // The actual in-flight guard. It must be a ref, not the state above: React
  // batches state updates inside an event handler, so two clicks landing in the
  // same batch would both still observe `dmLoading === null` and fire two POSTs
  // (idempotent server-side, but they race two navigations).
  const dmInFlightRef = useRef(false);
  // In-page error for a failed DM start — replaces the `alert()` this used to
  // use, matching the pattern the rest of this file already leans on
  // (inline text, not a blocking browser dialog).
  const [dmError, setDmError] = useState<string | null>(null);
  // The single app-wide chat rail (present whenever this page renders inside
  // `CommunityLayout`, which it always does — see the fallback note in
  // `handleStartDm` for the one case it wouldn't be).
  const chatRail = useChatRail();

  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (!data?.userId) { router.replace('/'); return; }
        setSessionUserId(data.userId);
      })
      .catch(() => router.replace('/'));
  }, [router]);

  useEffect(() => {
    loadTopic();
    loadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId]);

  async function loadTopic() {
    try {
      const res = await fetch(`/api/topics/${topicId}`);
      if (res.status === 401) { router.replace('/'); return; }
      if (res.status === 403) { router.replace(`/topics/${topicId}/join`); return; }
      if (!res.ok) throw new Error(t('membersPage.topicNotFound'));
      const data = await res.json();
      setTopic(data.topic);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('membersPage.loadTopicFailed'));
    }
  }

  async function loadMembers() {
    try {
      const res = await fetch(`/api/topics/${topicId}/members`);
      if (!res.ok) throw new Error(t('membersPage.loadMembersFailed'));
      const data = await res.json();
      setMembers(data.members ?? []);
      if (data.currentUserRole) {
        setCurrentUserRole(data.currentUserRole);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('membersPage.loadMembersFailed'));
    } finally {
      setLoading(false);
    }
  }

  // Derive current user role from members list
  useEffect(() => {
    if (sessionUserId && members.length > 0) {
      const me = members.find((m) => m.userId === sessionUserId);
      setCurrentUserRole(me?.role ?? null);
    }
  }, [sessionUserId, members]);

  // Load requests when switching to requests tab (owner/admin only)
  useEffect(() => {
    if (tab === 'requests' && (currentUserRole === 'owner' || currentUserRole === 'admin')) {
      loadRequests();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, currentUserRole]);

  async function loadRequests() {
    setRequestsLoading(true);
    try {
      const res = await fetch(`/api/topics/${topicId}/requests`);
      if (!res.ok) throw new Error(t('membersPage.loadRequestsFailed'));
      const data = await res.json();
      setRequests(data.requests ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('membersPage.loadRequestsFailed'));
    } finally {
      setRequestsLoading(false);
    }
  }

  async function handleRequestAction(requestId: string, action: 'approve' | 'reject') {
    setRequestActionLoading(requestId);
    try {
      const res = await fetch(`/api/topics/${topicId}/requests`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, action }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? t('membersPage.processRequestFailed'));
      }
      await loadRequests();
      if (action === 'approve') {
        await loadMembers();
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : t('membersPage.genericFailed'));
    } finally {
      setRequestActionLoading(null);
    }
  }

  /**
   * Start (or reopen) a 1:1 DM with a member and land in it.
   *
   * `POST /api/dm` is idempotent on the canonical participant pair, so pressing
   * this on a member you already message returns the SAME topicId instead of
   * creating a second channel. The server also rejects a self-DM (400) and an
   * unknown user (404); the button is not rendered for your own row, and any
   * server rejection surfaces rather than navigating to a dead conversation.
   *
   * Lands in the conversation via the chat rail (open + focus), not a
   * full-page navigation — pressing "DM" from a member row should not throw
   * the reader out of the member list into an unrelated page.
   */
  async function handleStartDm(userId: string, nickname: string, profileImage?: string | null) {
    if (dmInFlightRef.current) return;
    dmInFlightRef.current = true;
    setDmLoading(userId);
    setDmError(null);
    try {
      const res = await fetch('/api/dm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? t('membersPage.openConversationFailed'));
      if (!d.topicId) throw new Error(t('membersPage.openConversationFailed'));
      // See ChatRail.tsx's startDm — the server now excludes this person from
      // future candidate fetches (FIX9); invalidate so isDmCandidate()/the
      // picker reflect that immediately instead of the cached pre-DM state.
      invalidateDmCandidates();
      if (chatRail) {
        chatRail.openRail({ kind: 'dm', topicId: d.topicId, title: nickname, profileImage: profileImage ?? null });
      } else {
        // No rail reachable (should not happen — this page always renders
        // inside CommunityLayout — but never leave the DM unreachable over a
        // context-resolution edge case).
        router.push(`/dm/${d.topicId}`);
      }
    } catch (err) {
      setDmError(err instanceof Error ? err.message : t('membersPage.openConversationFailed'));
    } finally {
      dmInFlightRef.current = false;
      setDmLoading(null);
    }
  }

  async function handleRoleChange(userId: string, newRole: 'admin' | 'member') {
    setActionLoading(userId);
    try {
      const res = await fetch(`/api/topics/${topicId}/members`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, role: newRole }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? t('membersPage.updateRoleFailed'));
      }
      await loadMembers();
    } catch (err) {
      alert(err instanceof Error ? err.message : t('membersPage.genericFailed'));
    } finally {
      setActionLoading(null);
    }
  }

  async function handleKick(userId: string) {
    if (confirmKick !== userId) {
      setConfirmKick(userId);
      return;
    }
    setActionLoading(userId);
    setConfirmKick(null);
    try {
      const res = await fetch(`/api/topics/${topicId}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? t('membersPage.kickFailed'));
      }
      await loadMembers();
    } catch (err) {
      alert(err instanceof Error ? err.message : t('membersPage.genericFailed'));
    } finally {
      setActionLoading(null);
    }
  }

  async function handleTransferOwnership(userId: string) {
    if (confirmTransfer !== userId) {
      setConfirmTransfer(userId);
      return;
    }
    setTransferLoading(true);
    setConfirmTransfer(null);
    try {
      const res = await fetch(`/api/topics/${topicId}/members`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, role: 'owner' }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? t('membersPage.transferFailed'));
      }
      await loadMembers();
    } catch (err) {
      alert(err instanceof Error ? err.message : t('membersPage.genericFailed'));
    } finally {
      setTransferLoading(false);
    }
  }

  const isOwner = currentUserRole === 'owner';
  const isOwnerOrAdmin = currentUserRole === 'owner' || currentUserRole === 'admin';

  if (loading) {
    return (
      <CommunityLayout isGuest={false} sessionChecked={true}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
          <Spinner />
        </div>
      </CommunityLayout>
    );
  }

  if (error || !topic) {
    return (
      <CommunityLayout isGuest={false} sessionChecked={true}>
        <div style={{ padding: '40px 0', textAlign: 'center' }}>
          <p style={{ color: '#ef4444', fontFamily: 'monospace', fontSize: 'var(--text-body-sm)' }}>
            {error ?? t('membersPage.topicNotFound')}
          </p>
          <Link href="/topics" style={{ color: 'var(--accent)', fontSize: 'var(--text-body-sm)' }}>
            {t('membersPage.backToTopics')}
          </Link>
        </div>
      </CommunityLayout>
    );
  }

  return (
    <CommunityLayout isGuest={false} sessionChecked={true}>
      {/* 1.5rem = space-5; 36px/80px vertical rhythm has no exact scale match, kept literal. */}
      <div style={{ paddingTop: 36, paddingBottom: 80, maxWidth: 560, margin: '0 auto', padding: '36px var(--space-5) 80px' }}>
        {/* Topic info card */}
        <div style={{
          padding: '16px var(--space-5)',
          background: 'var(--surface, #0c0e18)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 'var(--radius-card)',
          marginBottom: 'var(--space-5)',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}>
          <TopicAvatar title={topic.title} size={44} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{
              fontSize: 'var(--text-heading-sm)',
              fontWeight: 800,
              letterSpacing: '-0.03em',
              margin: 0,
              color: '#e5e7eb',
            }}>
              {topic.title}
            </h1>
            <p style={{ fontSize: 'var(--text-body-sm)', color: '#6b7280', margin: '4px 0 0', fontFamily: 'monospace' }}>
              {members.length} {members.length === 1 ? t('rightSidebar.member') : t('rightSidebar.members')}
            </p>
          </div>
          {/* Invite button */}
          <button
            onClick={async () => {
              const url = `${window.location.origin}/topics/${topicId}/join`;
              await navigator.clipboard.writeText(url);
              setInviteCopied(true);
              setTimeout(() => setInviteCopied(false), 2000);
            }}
            style={{
              background: inviteCopied ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.06)',
              color: inviteCopied ? '#22c55e' : '#6b7280',
              border: `1px solid ${inviteCopied ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.08)'}`,
              borderRadius: 'var(--radius-control)',
              padding: '8px 14px',
              fontSize: 'var(--text-body-sm)',
              cursor: 'pointer',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              transition: 'all 0.15s',
              flexShrink: 0,
              minHeight: 'var(--touch-target-min)',
            }}
          >
            {inviteCopied ? t('membersPage.copied') : t('membersPage.invite')}
          </button>
        </div>

        {/* In-page DM-start failure — replaces the old alert() dialog. */}
        {dmError && (
          <div
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-3)',
              padding: '10px 14px',
              marginBottom: 'var(--space-4)',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: 'var(--radius-control)',
              color: '#ef4444',
              fontSize: 'var(--text-caption)',
            }}
          >
            <span>{dmError}</span>
            <button
              type="button"
              onClick={() => setDmError(null)}
              aria-label={t('membersPage.dismiss')}
              style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 'var(--text-body)', lineHeight: 1, padding: 0 }}
            >
              ×
            </button>
          </div>
        )}

        {/* Tabs (only show if owner/admin) */}
        {isOwnerOrAdmin && (
          <div
            style={{
              display: 'flex',
              gap: 0,
              borderBottom: '1px solid var(--border)',
              marginBottom: 20,
            }}
          >
            {(['members', 'requests'] as const).map((tabId) => (
              <button
                key={tabId}
                onClick={() => setTab(tabId)}
                style={{
                  background: 'none',
                  border: 'none',
                  borderBottom: tab === tabId ? '2px solid var(--accent)' : '2px solid transparent',
                  color: tab === tabId ? 'var(--accent)' : 'var(--muted)',
                  cursor: 'pointer',
                  fontSize: 'var(--text-body-sm)',
                  fontWeight: tab === tabId ? 600 : 400,
                  padding: '8px var(--space-4)',
                  marginBottom: -1,
                  transition: 'color 0.15s',
                  minHeight: 'var(--touch-target-min)',
                }}
              >
                {tabId === 'members' ? t('membersPage.tabs.members') : `${t('membersPage.tabs.requests')}${requests.length > 0 ? ` (${requests.length})` : ''}`}
              </button>
            ))}
          </div>
        )}

        {/* Requests tab */}
        {tab === 'requests' && isOwnerOrAdmin && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {requestsLoading && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
                <Spinner />
              </div>
            )}
            {!requestsLoading && requests.length === 0 && (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--muted)', fontSize: 'var(--text-body-sm)' }}>
                {t('membersPage.noPendingRequests')}
              </div>
            )}
            {!requestsLoading && requests.map((req) => (
              <div
                key={req.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-3) var(--space-4)',
                  background: 'var(--surface, #0c0e18)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: 'var(--radius-card)',
                }}
              >
                <Avatar src={req.profileImage} name={req.nickname} size={40} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 'var(--text-body)', fontWeight: 600, color: '#e5e7eb' }}>
                    {req.nickname}
                  </span>
                  <p style={{ fontSize: 'var(--text-caption)', color: '#6b7280', margin: '2px 0 0', fontFamily: 'monospace' }}>
                    {new Date(req.createdAt).toLocaleDateString(locale === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric' })}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => handleRequestAction(req.id, 'approve')}
                    disabled={requestActionLoading === req.id}
                    style={{
                      fontSize: 'var(--text-body-sm)',
                      fontWeight: 600,
                      background: 'rgba(34,197,94,0.12)',
                      color: '#22c55e',
                      border: '1px solid rgba(34,197,94,0.25)',
                      borderRadius: 'var(--radius-control)',
                      padding: '5px 14px',
                      cursor: requestActionLoading === req.id ? 'not-allowed' : 'pointer',
                      opacity: requestActionLoading === req.id ? 0.5 : 1,
                      transition: 'opacity 0.12s',
                      minHeight: 'var(--touch-target-min)',
                    }}
                  >
                    {t('membersPage.approve')}
                  </button>
                  <button
                    onClick={() => handleRequestAction(req.id, 'reject')}
                    disabled={requestActionLoading === req.id}
                    style={{
                      fontSize: 'var(--text-body-sm)',
                      fontWeight: 600,
                      background: 'rgba(239,68,68,0.1)',
                      color: '#ef4444',
                      border: '1px solid rgba(239,68,68,0.2)',
                      borderRadius: 'var(--radius-control)',
                      padding: '5px 14px',
                      cursor: requestActionLoading === req.id ? 'not-allowed' : 'pointer',
                      opacity: requestActionLoading === req.id ? 0.5 : 1,
                      transition: 'opacity 0.12s',
                      minHeight: 'var(--touch-target-min)',
                    }}
                  >
                    {t('membersPage.reject')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Member list */}
        {tab === 'members' && <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {members.map((member) => (
            <div
              key={member.userId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                padding: 'var(--space-3) var(--space-4)',
                background: 'var(--surface, #0c0e18)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 'var(--radius-card)',
                transition: 'background 0.12s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#0d0d0d'; }}
            >
              <UserCard
                userId={member.userId}
                nickname={member.nickname}
                profileImage={member.profileImage}
                badges={member.badges}
                viewerUserId={sessionUserId}
              >
                <Avatar src={member.profileImage} name={member.nickname} size={40} />
              </UserCard>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 'var(--text-body)', fontWeight: 600, color: '#e5e7eb' }}>
                    {member.nickname}
                  </span>
                  {member.badges && member.badges.length > 0 && member.badges.map((b, i) => (
                    <Badge key={i} type={b.type} label={b.label} domain={b.domain} country={b.country} />
                  ))}
                </div>
              </div>

              {/* DM — starts (or reopens) a 1:1 conversation with this member.
                  Rendered only once the session is known and never on your own
                  row: /api/dm rejects a self-DM with 400, so offering it would
                  be a button whose only outcome is an error. */}
              {sessionUserId && member.userId !== sessionUserId && (
                <button
                  onClick={() => handleStartDm(member.userId, member.nickname, member.profileImage)}
                  disabled={dmLoading !== null}
                  aria-label={t('membersPage.dmAriaLabel', { nickname: member.nickname })}
                  style={{
                    fontSize: 'var(--text-body-sm)',
                    fontWeight: 500,
                    background: 'rgba(120,140,255,0.1)',
                    color: 'var(--accent)',
                    border: '1px solid rgba(120,140,255,0.2)',
                    borderRadius: 'var(--radius-control)',
                    padding: '4px 10px',
                    cursor: dmLoading !== null ? 'not-allowed' : 'pointer',
                    opacity: dmLoading !== null ? 0.5 : 1,
                    transition: 'opacity 0.12s',
                    flexShrink: 0,
                    minHeight: 'var(--touch-target-min)',
                  }}
                >
                  {dmLoading === member.userId ? '...' : t('membersPage.dm')}
                </button>
              )}

              {/* Role badge */}
              {member.role === 'owner' && (
                <span style={{
                  fontSize: 'var(--text-body-sm)',
                  fontWeight: 600,
                  background: 'rgba(234,179,8,0.15)',
                  color: '#eab308',
                  border: '1px solid rgba(234,179,8,0.3)',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-pill)',
                  flexShrink: 0,
                }}>
                  {t('membersPage.roleOwner')}
                </span>
              )}
              {member.role === 'admin' && (
                <span style={{
                  fontSize: 'var(--text-body-sm)',
                  fontWeight: 600,
                  background: 'rgba(59,130,246,0.15)',
                  color: 'var(--accent)',
                  border: '1px solid rgba(59,130,246,0.3)',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-pill)',
                  flexShrink: 0,
                }}>
                  {t('membersPage.roleAdmin')}
                </span>
              )}

              {/* Admin can kick regular members */}
              {!isOwner && currentUserRole === 'admin' && member.role === 'member' && member.userId !== sessionUserId && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => handleKick(member.userId)}
                    disabled={actionLoading === member.userId}
                    style={{
                      fontSize: 'var(--text-body-sm)',
                      fontWeight: 500,
                      background: confirmKick === member.userId ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.08)',
                      color: '#ef4444',
                      border: `1px solid ${confirmKick === member.userId ? 'rgba(239,68,68,0.4)' : 'rgba(239,68,68,0.15)'}`,
                      borderRadius: 'var(--radius-control)',
                      padding: '4px 10px',
                      cursor: 'pointer',
                      opacity: actionLoading === member.userId ? 0.5 : 1,
                      transition: 'all 0.12s',
                      minHeight: 'var(--touch-target-min)',
                    }}
                  >
                    {confirmKick === member.userId ? t('membersPage.confirmQuestion') : t('membersPage.kick')}
                  </button>
                </div>
              )}

              {/* Actions (owner only, not on self/owner) */}
              {isOwner && member.userId !== sessionUserId && member.role !== 'owner' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  {member.role === 'member' ? (
                    <button
                      onClick={() => handleRoleChange(member.userId, 'admin')}
                      disabled={actionLoading === member.userId}
                      style={{
                        fontSize: 'var(--text-body-sm)',
                        fontWeight: 500,
                        background: 'rgba(59,130,246,0.1)',
                        color: 'var(--accent)',
                        border: '1px solid rgba(59,130,246,0.2)',
                        borderRadius: 'var(--radius-control)',
                        padding: '4px 10px',
                        cursor: 'pointer',
                        opacity: actionLoading === member.userId ? 0.5 : 1,
                        transition: 'opacity 0.12s',
                        minHeight: 'var(--touch-target-min)',
                      }}
                    >
                      {t('membersPage.makeAdmin')}
                    </button>
                  ) : (
                    <button
                      onClick={() => handleRoleChange(member.userId, 'member')}
                      disabled={actionLoading === member.userId}
                      style={{
                        fontSize: 'var(--text-body-sm)',
                        fontWeight: 500,
                        background: 'rgba(255,255,255,0.05)',
                        color: '#9ca3af',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 'var(--radius-control)',
                        padding: '4px 10px',
                        cursor: 'pointer',
                        opacity: actionLoading === member.userId ? 0.5 : 1,
                        transition: 'opacity 0.12s',
                        minHeight: 'var(--touch-target-min)',
                      }}
                    >
                      {t('membersPage.removeAdmin')}
                    </button>
                  )}
                  <button
                    onClick={() => handleTransferOwnership(member.userId)}
                    disabled={transferLoading}
                    style={{
                      fontSize: 'var(--text-body-sm)',
                      fontWeight: 500,
                      background: confirmTransfer === member.userId ? 'rgba(234,179,8,0.2)' : 'rgba(234,179,8,0.08)',
                      color: '#eab308',
                      border: `1px solid ${confirmTransfer === member.userId ? 'rgba(234,179,8,0.4)' : 'rgba(234,179,8,0.15)'}`,
                      borderRadius: 'var(--radius-control)',
                      padding: '4px 10px',
                      cursor: 'pointer',
                      opacity: transferLoading ? 0.5 : 1,
                      transition: 'all 0.12s',
                      minHeight: 'var(--touch-target-min)',
                    }}
                  >
                    {confirmTransfer === member.userId ? t('membersPage.confirmQuestion') : t('membersPage.transfer')}
                  </button>
                  <button
                    onClick={() => handleKick(member.userId)}
                    disabled={actionLoading === member.userId}
                    style={{
                      fontSize: 'var(--text-body-sm)',
                      fontWeight: 500,
                      background: confirmKick === member.userId ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.08)',
                      color: '#ef4444',
                      border: `1px solid ${confirmKick === member.userId ? 'rgba(239,68,68,0.4)' : 'rgba(239,68,68,0.15)'}`,
                      borderRadius: 'var(--radius-control)',
                      padding: '4px 10px',
                      cursor: 'pointer',
                      opacity: actionLoading === member.userId ? 0.5 : 1,
                      transition: 'all 0.12s',
                      minHeight: 'var(--touch-target-min)',
                    }}
                  >
                    {confirmKick === member.userId ? t('membersPage.confirmQuestion') : t('membersPage.kick')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>}
      </div>
    </CommunityLayout>
  );
}

