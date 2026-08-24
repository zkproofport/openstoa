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
 *     conversation" picker sourced from `GET /api/dm/candidates`. The tabs
 *     and their rows live in `ChatRoomList.tsx`, shared verbatim with the
 *     standalone `/chat` page this header can pop out to.
 *   - room view: the shared `ChatPanel`, with the rail's own header (back,
 *     peer/topic identity, mute, open-in-new-tab, close) — `ChatPanel` is
 *     always mounted with `hideHeader` here.
 *
 * Both levels can be popped out into their own tab, and the two targets are
 * the same idea at two scopes: `/chat` for the list, `/chat/{id}` or
 * `/dm/{id}` for a room (`newTabHref`). Opening a room from inside a
 * popped-out list navigates that tab to the room's own page — no third
 * navigation model.
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
import { apiFetch } from '@/lib/apiFetch';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import Avatar from './Avatar';
import Badge from './Badge';
import ChatPanel from './ChatPanel';
import TopicMuteToggle from './TopicMuteToggle';
import Spinner from './Spinner';
import { useConversationList } from '@/lib/useConversationList';
import TopicMembersList, { type TopicMember } from './TopicMembersList';
import ChatRoomList, {
  rowStyle,
  emptyStateStyle,
  type RailTopic,
  type RailDm,
  type ListTab,
} from './ChatRoomList';
import { newTabHref, isSameRoomAsPath, type RailRoom } from '@/lib/chatRail';
import { getDmCandidates, invalidateDmCandidates, type DmCandidate } from '@/lib/dmCandidatesCache';
import { useTranslation } from '@/lib/i18n/I18nProvider';

/** Re-exported from its new home (`ChatRoomList.tsx`, shared with the
 *  standalone `/chat` list page) so existing importers keep working. */
export { formatUnreadBadge } from './ChatRoomList';

/** One row of `GET /api/topics/{topicId}/members` — see `TopicMembersList.tsx`,
 *  which also backs the standalone members page's popped-out members overlay
 *  (`/chat/[topicId]`), so a topic room's member list looks identical
 *  wherever it appears. */
type RailMember = TopicMember;

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

interface ChatRailProps {
  /** Collapse the rail (does not clear the selected room — reopening lands
   *  back on the list, by design; see the module doc). */
  onClose: () => void;
  /** External "jump to this room" request — see the module doc. */
  openRequest?: { room: RailRoom | null; nonce: number } | null;
}

export default function ChatRail({ onClose, openRequest }: ChatRailProps) {
  const { t } = useTranslation();
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
    apiFetch(`/api/topics/${room.topicId}/members`)
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
    apiFetch('/api/auth/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive) setMyUserId(d?.userId ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // The SAME hook `/chat` uses. Both lists used to fetch and order themselves,
  // which is how the rail kept showing creation order after `/chat` was fixed.
  const {
    topics,
    dms,
    error: listError,
    needsNickname,
    reload: loadDms,
    clearUnread,
  } = useConversationList<RailTopic, RailDm>();

  const openRoom = useCallback((r: RailRoom) => {
    setRoom(r);
    setPicking(false);
    /*
     * Zero the badge now rather than on the next list load.
     *
     * The rail keeps this list mounted BESIDE the open room, so without it the
     * user sits in a conversation looking at a count for the messages in front
     * of them. The authoritative write happens in `ChatPanel` (debounced, see
     * `chatReadSync`); this is only the local cache catching up first, and the
     * next reload takes the server's number back.
     */
    clearUnread(r.topicId);
  }, [clearUnread]);

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
        const res = await apiFetch('/api/dm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: candidate.userId }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data?.topicId) {
          // The server now excludes this person from future candidate
          // fetches (FIX9) — invalidate so the picker (opened again) and
          // isDmCandidate() reflect that immediately instead of the cached
          // pre-DM state for up to 60s.
          invalidateDmCandidates();
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
        borderRadius: 'var(--radius-card)',
        overflow: 'hidden',
        outline: 'none',
      }}
    >
      {/* ── Header — a fixed-height chrome row (icon buttons kept at their
          existing scale, not bumped to --touch-target-min, so this row does
          not grow taller than the rest of the app's compact header bars). ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px var(--space-3)',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        {room ? (
          <>
            <button type="button" onClick={backToList} aria-label={t('chatRail.backAriaLabel')} style={iconBtnStyle}>
              {BackIcon}
            </button>
            <Avatar src={room.profileImage} name={room.title} size={26} />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 'var(--text-caption)',
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
                aria-label={showMembers ? t('chatRail.hideMembers') : t('chatRail.showMembers')}
                aria-pressed={showMembers}
                title={t('chatRail.members')}
                style={{ ...iconBtnStyle, color: showMembers ? 'var(--accent)' : iconBtnStyle.color }}
              >
                {MembersIcon}
              </button>
            )}
            <Link
              href={newTabHref(room)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('chatRail.openInNewTab')}
              style={{ ...iconBtnStyle, textDecoration: 'none' }}
            >
              {NewTabIcon}
            </Link>
            <button type="button" onClick={onClose} aria-label={t('chat.close')} style={iconBtnStyle}>
              {CloseIcon}
            </button>
          </>
        ) : (
          <>
            {/* `.os-label` owns the uppercase+tracking idiom and gates it to
                :lang(en) — this label translates to Korean ("채팅"), where
                tracking reads as broken kerning. */}
            <span className="os-label" style={{ color: 'var(--muted)' }}>
              {t('chat.title')}
            </span>
            <span style={{ flex: 1 }} />
            {/* Pop the LIST out, the same affordance the room header offers for
                a single room (`newTabHref` above) — same icon, same
                `target="_blank"` treatment, so the two read as one feature.
                Its target `/chat` is a real route (`src/app/chat/page.tsx`),
                not a pop-out-only shim: it renders this same two-tab list in
                the bare shell and works from a pasted URL.

                Shown at every width, phone included. The rail is a
                full-screen sheet on a phone, where a second tab is less
                obviously useful — but mobile browsers do have tabs, the
                room-level pop-out is already unconditional, and hiding one of
                the two under a breakpoint would make the pair read as an
                inconsistency rather than a considered choice. */}
            <Link
              href="/chat"
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('chatRail.openListInNewTab')}
              title={t('chatRail.openListInNewTab')}
              style={{ ...iconBtnStyle, textDecoration: 'none' }}
            >
              {NewTabIcon}
            </Link>
            {!picking && (
              <button type="button" onClick={openPicker} aria-label={t('chatRail.newConversation')} style={iconBtnStyle} title={t('chatRail.newConversation')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="16" />
                  <line x1="8" y1="12" x2="16" y2="12" />
                </svg>
              </button>
            )}
            <button type="button" onClick={onClose} aria-label={t('chat.close')} style={iconBtnStyle}>
              {CloseIcon}
            </button>
          </>
        )}
      </div>

      {/* ── Body ── */}
      {room ? (
        suppressPanel ? (
          <div style={emptyStateStyle}>
            <p style={{ margin: '0 0 12px' }}>{t('chatRail.suppressedNotice')}</p>
            <button type="button" onClick={backToList} style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-caption)' }}>
              {t('chatRail.backToList')}
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
                <TopicMembersList members={members} failed={membersFailed} onRetry={loadMembers} viewerUserId={myUserId} />
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
        <ChatRoomList
          tab={tab}
          onTabChange={setTab}
          topics={topics}
          dms={dms}
          needsNickname={needsNickname}
          loadError={listError}
          onRetry={loadDms}
          onOpenTopic={(topic) => openRoom({ kind: 'topic', topicId: topic.id, title: topic.title })}
          onOpenDm={(d) => openRoom({ kind: 'dm', topicId: d.topicId, title: d.peer.nickname, profileImage: d.peer.profileImage })}
        />
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
  borderRadius: 'var(--radius-control)',
  flexShrink: 0,
};

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
  const { t } = useTranslation();
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '8px var(--space-3)', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t('dm.searchPlaceholder')}
          maxLength={200}
          autoFocus
          style={{
            flex: 1,
            background: 'transparent',
            border: '1px solid var(--color-border-default)',
            borderRadius: 'var(--radius-control)',
            padding: '6px var(--space-3)',
            // var(--text-body) = 16px: below that, iOS Safari zooms the page
            // on focus. Was 13px.
            fontSize: 'var(--text-body)',
            color: 'var(--foreground)',
            outline: 'none',
            minHeight: 'var(--touch-target-min)',
          }}
        />
        <button type="button" onClick={onCancel} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 'var(--text-label)' }}>
          {t('common.cancel')}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {candidates === null ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '28px 0' }}>
            <Spinner />
          </div>
        ) : failed ? (
          <div style={{ padding: '28px var(--space-5)', textAlign: 'center', color: 'var(--muted)', fontSize: 'var(--text-caption)', lineHeight: 1.6 }}>
            <p style={{ margin: '0 0 12px 0' }}>{t('dm.candidatesLoadError')}</p>
            <button
              type="button"
              onClick={onRetry}
              style={{
                background: 'none',
                border: '1px solid var(--color-border-strong)',
                borderRadius: 'var(--radius-pill)',
                padding: '6px var(--space-4)',
                color: 'var(--foreground)',
                fontSize: 'var(--text-caption)',
                cursor: 'pointer',
                minHeight: 'var(--touch-target-min)',
              }}
            >
              {t('chatRail.tryAgain')}
            </button>
          </div>
        ) : candidates.length === 0 ? (
          <div style={emptyStateStyle}>
            <p style={{ margin: 0 }}>
              {t('dm.noCandidates')}
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
                    fontSize: 'var(--text-caption)',
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
                  <span style={{ display: 'block', fontSize: 'var(--text-label)', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t('dm.sharedTopicsVia', { topics: c.sharedTopics.map((s) => s.title).join(', ') })}
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
              {startingUserId === c.userId && <span style={{ fontSize: 'var(--text-label)', color: 'var(--muted)', flexShrink: 0 }}>…</span>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
