'use client';

/**
 * The right-edge chat rail — replaces the old docked-column / expand-to-
 * sidebar / maximize-modal system in `RightSidebar.tsx` with a single
 * always-in-the-same-place surface, mirroring the mobile mini-app's chat tab
 * (`packages/mobile/src/navigation/stacks/ChatStack.tsx`: a list screen that
 * pushes a room screen).
 *
 * Two-level navigation, never persisted across mounts (this component itself
 * IS re-mounted on every page navigation — see CommunityLayout — so it always
 * starts at the list view; only the rail's open/closed flag persists, via
 * `src/lib/chatRail.ts`):
 *   - list view: two tabs, Topics (`GET /api/topics`, joined only — server
 *     already excludes `kind='dm'`) and Direct (`GET /api/dm`), plus a "New
 *     conversation" picker sourced from `GET /api/dm/candidates`.
 *   - room view: the shared `ChatPanel`, with the rail's own header (back,
 *     peer/topic identity, mute, open-in-new-tab, close) — `ChatPanel` is
 *     always mounted with `hideHeader` here.
 *
 * Mount-uniqueness guard: if the room open in this rail is the SAME room the
 * current page IS (the user opened `/chat/{id}` or `/dm/{id}` from the "open
 * in new tab" action, or navigated there directly, while the rail still has
 * that room selected), this component must NOT also mount `ChatPanel` for it
 * — MLS drops each message's decrypt key after first use, so two live panels
 * on one topic permanently break one of them. See `isSameRoomAsPath`.
 *
 * `openRequest` (optional) is how discovery entry points elsewhere in the app
 * — the left-nav "Chat" link, a topic page's "Open topic chat" — jump this
 * rail straight to a room (or back to the list, when `room` is `null`)
 * without owning any of this component's internal state themselves.
 * `CommunityLayout` is still the sole owner of `railOpen`; this is purely a
 * "once you're open, show me X" signal. `nonce` must change on every request
 * — including a repeat of the same target — since without it a second click
 * on an already-applied request would look like a no-op change and the
 * effect below would never re-fire.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import Avatar from './Avatar';
import Badge from './Badge';
import ChatPanel from './ChatPanel';
import TopicMuteToggle from './TopicMuteToggle';
import Spinner from './Spinner';
import UserCard from './UserCard';
import { relativeTime } from '@/lib/utils';
import type { DmChannel } from '@/lib/dm';
import { newTabHref, isSameRoomAsPath, type RailRoom } from '@/lib/chatRail';
import { getDmCandidates, type DmCandidate } from '@/lib/dmCandidatesCache';

interface RailTopic {
  id: string;
  title: string;
  memberCount?: number;
}

/** One row of `GET /api/topics/{topicId}/members` — same shape the
 *  standalone members page (`/topics/[topicId]/members`) renders, reused
 *  here so a topic room's member list looks identical wherever it appears. */
interface RailMember {
  userId: string;
  nickname: string;
  role: 'owner' | 'admin' | 'member';
  profileImage?: string | null;
  badges?: Array<{ type: string; label: string; domain?: string; country?: string }>;
}

type ListTab = 'topics' | 'dms';

const CloseIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const BackIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const NewTabIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

const MembersIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '10px 14px',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--border)',
  cursor: 'pointer',
  textAlign: 'left',
  color: 'inherit',
  font: 'inherit',
};

const emptyStateStyle: React.CSSProperties = {
  padding: '32px 20px',
  textAlign: 'center',
  fontSize: 13,
  color: 'var(--muted)',
  lineHeight: 1.6,
};

interface ChatRailProps {
  /** Collapse the rail (does not clear the selected room — reopening lands
   *  back on the list, by design; see the module doc). */
  onClose: () => void;
  /** External "jump to this room" request — see the module doc. */
  openRequest?: { room: RailRoom | null; nonce: number } | null;
}

export default function ChatRail({ onClose, openRequest }: ChatRailProps) {
  const pathname = usePathname();
  // Focus target for `openRequest` (below) — an external "open this DM/topic"
  // request (a member row's DM action, `UserCard`) should land the reader's
  // attention IN the rail, not just silently mount content somewhere on the
  // page they may not be looking at.
  const railRef = useRef<HTMLDivElement>(null);

  const [room, setRoom] = useState<RailRoom | null>(() => openRequest?.room ?? null);
  const [tab, setTab] = useState<ListTab>('topics');
  const [picking, setPicking] = useState(false);
  // Tracks the last `openRequest.nonce` already applied so a request present
  // at mount (consumed by the lazy `useState` initializer above) is not
  // re-applied a second time by this effect on the very next render.
  const appliedRequestNonce = useRef(openRequest?.nonce);

  useEffect(() => {
    if (!openRequest || openRequest.nonce === appliedRequestNonce.current) return;
    appliedRequestNonce.current = openRequest.nonce;
    setPicking(false);
    setRoom(openRequest.room);
    // Only a real room target has anywhere to send focus — a `room: null`
    // request (return to the list) leaves focus wherever it already was.
    if (openRequest.room) railRef.current?.focus();
  }, [openRequest]);

  const [topics, setTopics] = useState<RailTopic[] | null>(null);
  const [dms, setDms] = useState<DmChannel[] | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);

  const [candidates, setCandidates] = useState<DmCandidate[] | null>(null);
  /** The lookup FAILED, as opposed to legitimately returning nobody. */
  const [candidatesFailed, setCandidatesFailed] = useState(false);
  const [query, setQuery] = useState('');
  const dmInFlightRef = useRef(false);
  const [dmStarting, setDmStarting] = useState<string | null>(null);

  // Room view: an inline member list, toggled in place of `ChatPanel` — see
  // the header button below. Topic rooms only; a DM's "members" are the two
  // people already named in the header, so there is nothing to show.
  const [showMembers, setShowMembers] = useState(false);
  const [members, setMembers] = useState<RailMember[] | null>(null);
  const [membersFailed, setMembersFailed] = useState(false);

  // Leaving a room (or switching to a different one) always lands back on
  // chat, not wherever the previous room's toggle happened to be.
  useEffect(() => {
    setShowMembers(false);
    setMembers(null);
    setMembersFailed(false);
  }, [room?.topicId]);

  const loadMembers = useCallback(() => {
    if (!room || room.kind !== 'topic') return;
    setMembers(null);
    setMembersFailed(false);
    fetch(`/api/topics/${room.topicId}/members`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('failed to load members'))))
      .then((d) => setMembers(Array.isArray(d?.members) ? d.members : []))
      .catch(() => setMembersFailed(true));
  }, [room]);

  const toggleMembers = useCallback(() => {
    setShowMembers((v) => {
      const next = !v;
      if (next) loadMembers();
      return next;
    });
  }, [loadMembers]);

  useEffect(() => {
    let alive = true;
    fetch('/api/auth/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive) setMyUserId(d?.userId ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const loadTopics = useCallback(() => {
    setTopics(null);
    fetch('/api/topics')
      .then((r) => (r.ok ? r.json() : { topics: [] }))
      .then((d) => setTopics(Array.isArray(d?.topics) ? d.topics : []))
      .catch(() => setTopics([]));
  }, []);

  const loadDms = useCallback(() => {
    setDms(null);
    fetch('/api/dm')
      .then((r) => (r.ok ? r.json() : { dms: [] }))
      .then((d) => setDms(Array.isArray(d?.dms) ? d.dms : []))
      .catch(() => setDms([]));
  }, []);

  useEffect(() => {
    loadTopics();
    loadDms();
  }, [loadTopics, loadDms]);

  const openRoom = useCallback((r: RailRoom) => {
    setRoom(r);
    setPicking(false);
  }, []);

  const backToList = useCallback(() => setRoom(null), []);

  const openPicker = useCallback(() => {
    setPicking(true);
    setQuery('');
    setCandidates(null);
    setCandidatesFailed(false);
    getDmCandidates().then((res) => {
      if (!res.ok) {
        // Distinct from "no candidates". A failed lookup rendered as an empty
        // list reads as "you share no topics with anyone", which is both wrong
        // and undebuggable — and the failure is not cached, so Retry can work.
        setCandidatesFailed(true);
        setCandidates([]);
        return;
      }
      // Defensive — the server already excludes the caller, but a popover
      // that could ever offer "message yourself" is worse than a redundant
      // filter here. `myUserId` IS a dep (below) precisely so this never
      // closes over a stale `null` from before the session fetch resolved.
      setCandidates(res.data.filter((c) => c.userId !== myUserId));
    });
  }, [myUserId]);

  const startDm = useCallback(
    async (candidate: DmCandidate) => {
      if (dmInFlightRef.current) return;
      dmInFlightRef.current = true;
      setDmStarting(candidate.userId);
      try {
        const res = await fetch('/api/dm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: candidate.userId }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data?.topicId) {
          openRoom({ kind: 'dm', topicId: data.topicId, title: candidate.nickname, profileImage: candidate.profileImage });
          loadDms();
        }
      } catch {
        // best-effort — the picker stays open so the user can retry
      } finally {
        dmInFlightRef.current = false;
        setDmStarting(null);
      }
    },
    [openRoom, loadDms],
  );

  const filteredCandidates = useMemo(() => {
    if (!candidates) return null;
    const q = query.trim().toLocaleLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => c.nickname.toLocaleLowerCase().includes(q));
  }, [candidates, query]);

  // The rail must not double-mount ChatPanel for a room whose standalone
  // page is the page currently on screen (see module doc).
  const suppressPanel = isSameRoomAsPath(pathname, room);

  return (
    <div
      ref={railRef}
      data-testid="chat-rail"
      // Not part of the tab order (-1) — this is a programmatic focus target
      // for `openRequest`, not a control the reader tabs to on their own.
      tabIndex={-1}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        overflow: 'hidden',
        outline: 'none',
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        {room ? (
          <>
            <button type="button" onClick={backToList} aria-label="Back to chat list" style={iconBtnStyle}>
              {BackIcon}
            </button>
            <Avatar src={room.profileImage} name={room.title} size={26} />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 13,
                fontWeight: 700,
                color: 'var(--foreground)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {room.title}
            </span>
            <TopicMuteToggle topicId={room.topicId} enabled style={{ flexShrink: 0 }} />
            {room.kind === 'topic' && (
              <button
                type="button"
                onClick={toggleMembers}
                aria-label={showMembers ? 'Hide members' : 'Show members'}
                aria-pressed={showMembers}
                title="Members"
                style={{ ...iconBtnStyle, color: showMembers ? 'var(--accent)' : iconBtnStyle.color }}
              >
                {MembersIcon}
              </button>
            )}
            <Link
              href={newTabHref(room)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open in new tab"
              style={{ ...iconBtnStyle, textDecoration: 'none' }}
            >
              {NewTabIcon}
            </Link>
            <button type="button" onClick={onClose} aria-label="Close chat" style={iconBtnStyle}>
              {CloseIcon}
            </button>
          </>
        ) : (
          <>
            <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>
              Chat
            </span>
            <span style={{ flex: 1 }} />
            {!picking && (
              <button type="button" onClick={openPicker} aria-label="New conversation" style={iconBtnStyle} title="New conversation">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="16" />
                  <line x1="8" y1="12" x2="16" y2="12" />
                </svg>
              </button>
            )}
            <button type="button" onClick={onClose} aria-label="Close chat" style={iconBtnStyle}>
              {CloseIcon}
            </button>
          </>
        )}
      </div>

      {/* ── Body ── */}
      {room ? (
        suppressPanel ? (
          <div style={emptyStateStyle}>
            <p style={{ margin: '0 0 12px' }}>You&rsquo;re already viewing this conversation in the page behind this panel.</p>
            <button type="button" onClick={backToList} style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>
              Back to list
            </button>
          </div>
        ) : (
          /* The member list OVERLAYS the panel rather than replacing it.
             Swapping it in would unmount `ChatPanel`, which drops the SSE
             stream, loses scroll position and re-runs the initial history
             fetch on every peek at the member list — a real cost for a glance.
             An overlay is still exactly ONE mounted panel, so it does not
             reintroduce the double-mount hazard the module doc describes. */
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
            <ChatPanel topicId={room.topicId} isGuest={false} isMember fullHeight hideHeader roomy />
            {showMembers && room.kind === 'topic' && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'var(--background)',
                  display: 'flex',
                  flexDirection: 'column',
                  zIndex: 2,
                }}
              >
                <MembersList members={members} failed={membersFailed} onRetry={loadMembers} viewerUserId={myUserId} />
              </div>
            )}
          </div>
        )
      ) : picking ? (
        <NewConversationPicker
          candidates={filteredCandidates}
          failed={candidatesFailed}
          onRetry={openPicker}
          query={query}
          onQueryChange={setQuery}
          onCancel={() => setPicking(false)}
          onPick={startDm}
          startingUserId={dmStarting}
        />
      ) : (
        <>
          <div role="tablist" aria-label="Chat lists" style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <TabButton active={tab === 'topics'} onClick={() => setTab('topics')} label="Topics" />
            <TabButton active={tab === 'dms'} onClick={() => setTab('dms')} label="Direct" />
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {tab === 'topics' ? (
              <TopicList topics={topics} onOpen={(t) => openRoom({ kind: 'topic', topicId: t.id, title: t.title })} />
            ) : (
              <DmList dms={dms} onOpen={(d) => openRoom({ kind: 'dm', topicId: d.topicId, title: d.peer.nickname, profileImage: d.peer.profileImage })} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'none',
  border: 'none',
  color: 'var(--muted)',
  cursor: 'pointer',
  padding: 5,
  borderRadius: 6,
  flexShrink: 0,
};

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        flex: 1,
        background: 'none',
        border: 'none',
        borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
        color: active ? 'var(--accent)' : 'var(--muted)',
        fontWeight: active ? 700 : 500,
        fontSize: 12,
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        padding: '9px 0',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function TopicList({ topics, onOpen }: { topics: RailTopic[] | null; onOpen: (t: RailTopic) => void }) {
  if (topics === null) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '28px 0' }}>
        <Spinner />
      </div>
    );
  }
  if (topics.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <p style={{ margin: '0 0 8px' }}>You haven&rsquo;t joined any chat topics yet.</p>
        <Link href="/topics/explore" style={{ color: 'var(--accent)' }}>
          Explore topics
        </Link>
      </div>
    );
  }
  return (
    <div>
      {topics.map((t) => (
        <button key={t.id} type="button" style={rowStyle} onClick={() => onOpen(t)} data-testid="chat-rail-topic-row">
          <Avatar name={t.title} size={32} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: 'var(--foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t.title}
          </span>
        </button>
      ))}
    </div>
  );
}

function DmList({ dms, onOpen }: { dms: DmChannel[] | null; onOpen: (d: DmChannel) => void }) {
  if (dms === null) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '28px 0' }}>
        <Spinner />
      </div>
    );
  }
  if (dms.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <p style={{ margin: 0 }}>No direct messages yet.</p>
      </div>
    );
  }
  return (
    <div>
      {dms.map((d) => (
        <button key={d.topicId} type="button" style={rowStyle} onClick={() => onOpen(d)} data-testid="chat-rail-dm-row">
          <Avatar src={d.peer.profileImage} name={d.peer.nickname} size={32} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: 'var(--foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {d.peer.nickname}
          </span>
          {d.lastActivityAt && (
            <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--muted)', flexShrink: 0 }}>{relativeTime(d.lastActivityAt)}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** A row's cursor is intentionally NOT pointer-styled like `rowStyle` (the
 *  list rows elsewhere in this file) — the row itself isn't a click target,
 *  only the `UserCard` trigger inside it is, and a whole-row pointer cursor
 *  would advertise a click that does nothing outside the avatar/name. */
const memberRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '10px 14px',
  borderBottom: '1px solid var(--border)',
};

/**
 * Topic room member list, toggled in place of `ChatPanel` by the header's
 * Members button. Reuses `UserCard` for the avatar/name — including its own
 * DM button and shared-topic gating — rather than a second bespoke "message
 * this person" affordance; DMing from here is exactly the same action as
 * DMing from the standalone `/topics/{id}/members` page or a feed avatar.
 */
function MembersList({
  members,
  failed,
  onRetry,
  viewerUserId,
}: {
  members: RailMember[] | null;
  failed: boolean;
  onRetry: () => void;
  viewerUserId: string | null;
}) {
  if (members === null && !failed) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '28px 0' }}>
        <Spinner />
      </div>
    );
  }
  if (failed) {
    return (
      <div style={{ padding: '28px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
        <p style={{ margin: '0 0 12px 0' }}>Could not load the member list.</p>
        <button
          type="button"
          onClick={onRetry}
          style={{
            background: 'none',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 999,
            padding: '6px 16px',
            color: 'var(--foreground)',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </div>
    );
  }
  if (!members || members.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <p style={{ margin: 0 }}>No members found.</p>
      </div>
    );
  }
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {members.map((m) => (
        <div key={m.userId} style={memberRowStyle} data-testid="rail-member-row">
          <UserCard userId={m.userId} nickname={m.nickname} profileImage={m.profileImage} badges={m.badges} viewerUserId={viewerUserId}>
            <Avatar src={m.profileImage} name={m.nickname} size={32} />
          </UserCard>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--foreground)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {m.nickname}
          </span>
          {m.role !== 'member' && (
            <span
              style={{
                fontSize: 10,
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--muted)',
                flexShrink: 0,
              }}
            >
              {m.role}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function NewConversationPicker({
  candidates,
  failed,
  onRetry,
  query,
  onQueryChange,
  onCancel,
  onPick,
  startingUserId,
}: {
  candidates: DmCandidate[] | null;
  /** The lookup failed — render that, never as "nobody to message". */
  failed: boolean;
  onRetry: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  onCancel: () => void;
  onPick: (c: DmCandidate) => void;
  startingUserId: string | null;
}) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search people…"
          maxLength={200}
          autoFocus
          style={{
            flex: 1,
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            padding: '6px 10px',
            fontSize: 13,
            color: 'var(--foreground)',
            outline: 'none',
          }}
        />
        <button type="button" onClick={onCancel} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12 }}>
          Cancel
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {candidates === null ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '28px 0' }}>
            <Spinner />
          </div>
        ) : failed ? (
          <div style={{ padding: '28px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
            <p style={{ margin: '0 0 12px 0' }}>Could not load the list of people you can message.</p>
            <button
              type="button"
              onClick={onRetry}
              style={{
                background: 'none',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 999,
                padding: '6px 16px',
                color: 'var(--foreground)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
          </div>
        ) : candidates.length === 0 ? (
          <div style={emptyStateStyle}>
            <p style={{ margin: 0 }}>
              No one to message yet — you need to share a topic with someone before you can start a conversation with them.
            </p>
          </div>
        ) : (
          candidates.map((c) => (
            <button key={c.userId} type="button" style={rowStyle} onClick={() => onPick(c)} disabled={startingUserId != null} data-testid="dm-candidate-row">
              <Avatar src={c.profileImage} name={c.nickname} size={32} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: 'block',
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--foreground)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {c.nickname}
                </span>
                {c.sharedTopics.length > 0 && (
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    via {c.sharedTopics.map((s) => s.title).join(', ')}
                  </span>
                )}
              </span>
              {c.badges.length > 0 && (
                <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                  {c.badges.slice(0, 2).map((b, i) => (
                    <Badge key={i} type={b.type} label={b.label} domain={b.domain ?? undefined} />
                  ))}
                </span>
              )}
              {startingUserId === c.userId && <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>…</span>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
