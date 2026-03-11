'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';
import Avatar from '@/components/Avatar';

interface Member {
  userId: string;
  nickname: string;
  role: 'owner' | 'admin' | 'member';
  profileImage?: string | null;
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

export default function MembersPage() {
  const params = useParams();
  const router = useRouter();
  const topicId = params.topicId as string;

  const [topic, setTopic] = useState<Topic | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmKick, setConfirmKick] = useState<string | null>(null);
  const [tab, setTab] = useState<'members' | 'requests'>('members');
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestActionLoading, setRequestActionLoading] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) { router.replace('/'); return; }
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
      if (!res.ok) throw new Error('Topic not found');
      const data = await res.json();
      setTopic(data.topic);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load topic');
    }
  }

  async function loadMembers() {
    try {
      const res = await fetch(`/api/topics/${topicId}/members`);
      if (!res.ok) throw new Error('Failed to load members');
      const data = await res.json();
      setMembers(data.members ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members');
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
      if (!res.ok) throw new Error('Failed to load requests');
      const data = await res.json();
      setRequests(data.requests ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load requests');
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
        throw new Error(d.error ?? 'Failed to process request');
      }
      await loadRequests();
      if (action === 'approve') {
        await loadMembers();
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
    } finally {
      setRequestActionLoading(null);
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
        throw new Error(d.error ?? 'Failed to update role');
      }
      await loadMembers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
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
        throw new Error(d.error ?? 'Failed to kick member');
      }
      await loadMembers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
    } finally {
      setActionLoading(null);
    }
  }

  const isOwner = currentUserRole === 'owner';
  const isOwnerOrAdmin = currentUserRole === 'owner' || currentUserRole === 'admin';

  if (loading) {
    return (
      <>
        <Header />
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
          <Spinner />
        </div>
      </>
    );
  }

  if (error || !topic) {
    return (
      <>
        <Header />
        <div style={{ padding: '40px 0', textAlign: 'center' }}>
          <p style={{ color: '#ef4444', fontFamily: 'monospace', fontSize: 14 }}>
            {error ?? 'Topic not found'}
          </p>
          <Link href="/topics" style={{ color: 'var(--accent)', fontSize: 14 }}>
            Back to topics
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <Header />
      <div style={{ paddingTop: 36, paddingBottom: 80, maxWidth: 560 }}>
        {/* Breadcrumb */}
        <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link
            href={`/topics/${topicId}`}
            style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 13 }}
          >
            Back to Topic
          </Link>
        </div>

        {/* Title */}
        <div style={{ marginBottom: 20 }}>
          <h1 style={{
            fontSize: 24,
            fontWeight: 800,
            letterSpacing: '-0.03em',
            margin: 0,
            color: '#e5e7eb',
          }}>
            Members
          </h1>
          <p style={{ fontSize: 13, color: '#6b7280', marginTop: 6, fontFamily: 'monospace' }}>
            {members.length} member{members.length !== 1 ? 's' : ''} in {topic.title}
          </p>
        </div>

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
            {(['members', 'requests'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  background: 'none',
                  border: 'none',
                  borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
                  color: tab === t ? 'var(--accent)' : 'var(--muted)',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: tab === t ? 600 : 400,
                  padding: '8px 16px',
                  marginBottom: -1,
                  transition: 'color 0.15s',
                }}
              >
                {t === 'members' ? 'Members' : `Requests${requests.length > 0 ? ` (${requests.length})` : ''}`}
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
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--muted)', fontSize: 14 }}>
                No pending join requests
              </div>
            )}
            {!requestsLoading && requests.map((req) => (
              <div
                key={req.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 16px',
                  background: '#0d0d0d',
                  border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: 10,
                }}
              >
                <Avatar src={req.profileImage} name={req.nickname} size={40} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: '#e5e7eb' }}>
                    {req.nickname}
                  </span>
                  <p style={{ fontSize: 11, color: '#6b7280', margin: '2px 0 0', fontFamily: 'monospace' }}>
                    {new Date(req.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => handleRequestAction(req.id, 'approve')}
                    disabled={requestActionLoading === req.id}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      background: 'rgba(34,197,94,0.12)',
                      color: '#22c55e',
                      border: '1px solid rgba(34,197,94,0.25)',
                      borderRadius: 6,
                      padding: '5px 14px',
                      cursor: requestActionLoading === req.id ? 'not-allowed' : 'pointer',
                      opacity: requestActionLoading === req.id ? 0.5 : 1,
                      transition: 'opacity 0.12s',
                    }}
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handleRequestAction(req.id, 'reject')}
                    disabled={requestActionLoading === req.id}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      background: 'rgba(239,68,68,0.1)',
                      color: '#ef4444',
                      border: '1px solid rgba(239,68,68,0.2)',
                      borderRadius: 6,
                      padding: '5px 14px',
                      cursor: requestActionLoading === req.id ? 'not-allowed' : 'pointer',
                      opacity: requestActionLoading === req.id ? 0.5 : 1,
                      transition: 'opacity 0.12s',
                    }}
                  >
                    Reject
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
                gap: 12,
                padding: '12px 16px',
                background: '#0d0d0d',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 10,
                transition: 'background 0.12s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#0d0d0d'; }}
            >
              <Avatar src={member.profileImage} name={member.nickname} size={40} />

              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: '#e5e7eb' }}>
                  {member.nickname}
                </span>
              </div>

              {/* Role badge */}
              {member.role === 'owner' && (
                <span style={{
                  fontSize: 11,
                  fontWeight: 600,
                  background: 'rgba(234,179,8,0.15)',
                  color: '#eab308',
                  border: '1px solid rgba(234,179,8,0.3)',
                  padding: '2px 8px',
                  borderRadius: 9999,
                  flexShrink: 0,
                }}>
                  Owner
                </span>
              )}
              {member.role === 'admin' && (
                <span style={{
                  fontSize: 11,
                  fontWeight: 600,
                  background: 'rgba(59,130,246,0.15)',
                  color: 'var(--accent)',
                  border: '1px solid rgba(59,130,246,0.3)',
                  padding: '2px 8px',
                  borderRadius: 9999,
                  flexShrink: 0,
                }}>
                  Admin
                </span>
              )}

              {/* Actions (owner only, not on self/owner) */}
              {isOwner && member.userId !== sessionUserId && member.role !== 'owner' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  {member.role === 'member' ? (
                    <button
                      onClick={() => handleRoleChange(member.userId, 'admin')}
                      disabled={actionLoading === member.userId}
                      style={{
                        fontSize: 11,
                        fontWeight: 500,
                        background: 'rgba(59,130,246,0.1)',
                        color: 'var(--accent)',
                        border: '1px solid rgba(59,130,246,0.2)',
                        borderRadius: 6,
                        padding: '4px 10px',
                        cursor: 'pointer',
                        opacity: actionLoading === member.userId ? 0.5 : 1,
                        transition: 'opacity 0.12s',
                      }}
                    >
                      Make Admin
                    </button>
                  ) : (
                    <button
                      onClick={() => handleRoleChange(member.userId, 'member')}
                      disabled={actionLoading === member.userId}
                      style={{
                        fontSize: 11,
                        fontWeight: 500,
                        background: 'rgba(255,255,255,0.05)',
                        color: '#9ca3af',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 6,
                        padding: '4px 10px',
                        cursor: 'pointer',
                        opacity: actionLoading === member.userId ? 0.5 : 1,
                        transition: 'opacity 0.12s',
                      }}
                    >
                      Remove Admin
                    </button>
                  )}
                  <button
                    onClick={() => handleKick(member.userId)}
                    disabled={actionLoading === member.userId}
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      background: confirmKick === member.userId ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.08)',
                      color: '#ef4444',
                      border: `1px solid ${confirmKick === member.userId ? 'rgba(239,68,68,0.4)' : 'rgba(239,68,68,0.15)'}`,
                      borderRadius: 6,
                      padding: '4px 10px',
                      cursor: 'pointer',
                      opacity: actionLoading === member.userId ? 0.5 : 1,
                      transition: 'all 0.12s',
                    }}
                  >
                    {confirmKick === member.userId ? 'Confirm?' : 'Kick'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>}
      </div>
    </>
  );
}

function Spinner() {
  return (
    <svg
      width={28}
      height={28}
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
