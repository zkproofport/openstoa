'use client';

/**
 * Peer profile card — click any wired avatar to see nickname + badges + a
 * "Message" button. Previously no such surface existed on web (avatars were
 * inert everywhere except the member list, which had its own bespoke inline
 * "Message" button but no card).
 *
 * The DM button is gated on `isDmCandidate()` (shared-topic membership, the
 * same rule `POST /api/dm` enforces server-side by rejecting the pair to no
 * shared context) so the card never offers a button that would just error.
 * It is never rendered for the viewer's own card.
 *
 * The trigger is a `<span role="button">`, NOT a `<button>` — several call
 * sites (PostCard) wrap the avatar in an outer `<Link>`, and nesting a real
 * `<button>` inside an `<a>` is invalid HTML that some browsers repair by
 * closing the anchor early, breaking the surrounding click target.
 *
 * Three honest end-states, not one blank box: an opened card with nothing
 * to say (no badges, no button) used to render as just an avatar + name,
 * which reads as broken rather than as "there's genuinely nothing else
 * here". `self`, `no badges`, and `not DM-able because no shared topic` are
 * independent and can combine (e.g. your own card is `self` + usually `no
 * badges`) — each renders its own explanatory line rather than being
 * collapsed into a single generic empty state.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Avatar from './Avatar';
import Badge from './Badge';
import { isDmCandidate } from '@/lib/dmCandidatesCache';
import { useChatRail } from '@/lib/chatRailContext';
import { useTranslation } from '@/lib/i18n/I18nProvider';

export interface UserCardBadge {
  type: string;
  label: string;
  domain?: string | null;
  country?: string | null;
}

const noteStyle: React.CSSProperties = {
  margin: '0 0 10px',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--muted)',
};

// Short-lived session cache shared by every mounted UserCard — a page that
// renders many avatars (feed, member list) must not issue one
// /api/auth/session request per card just to answer "is this me".
let viewerCache: { at: number; userId: string | null } | null = null;
const VIEWER_TTL_MS = 60_000;
async function resolveViewerUserId(): Promise<string | null> {
  if (viewerCache && Date.now() - viewerCache.at < VIEWER_TTL_MS) return viewerCache.userId;
  try {
    const r = await fetch('/api/auth/session', { credentials: 'include' });
    const d = r.ok ? await r.json() : null;
    const userId: string | null = d?.userId ?? null;
    viewerCache = { at: Date.now(), userId };
    return userId;
  } catch {
    return null;
  }
}

interface UserCardProps {
  userId: string;
  nickname: string;
  profileImage?: string | null;
  badges?: UserCardBadge[];
  /**
   * The signed-in viewer's own userId.
   *  - omitted (`undefined`)  → resolved lazily on open via the cache above,
   *    so callers that don't already track session state (PostCard, member
   *    lists) can wire this component with zero extra plumbing.
   *  - explicit `null`        → known guest; never resolves, Message button
   *    never renders.
   *  - a string                → used as-is, no fetch.
   */
  viewerUserId?: string | null;
  /** Trigger element — typically an `<Avatar>`. */
  children: React.ReactNode;
}

export default function UserCard({
  userId,
  nickname,
  profileImage,
  badges,
  viewerUserId,
  children,
}: UserCardProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [canDm, setCanDm] = useState(false);
  // Distinguishes "still checking DM eligibility" from "checked, not
  // eligible" — without this the not-DM-able note would flash on for the
  // self/guest cases too, before the check has even had a chance to run.
  const [dmChecked, setDmChecked] = useState(false);
  const [starting, setStarting] = useState(false);
  const [resolvedViewer, setResolvedViewer] = useState<string | null | undefined>(viewerUserId);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const router = useRouter();
  // The single app-wide chat rail, when this card is rendered inside
  // `CommunityLayout` (feed, member list) — `null` on any surface that isn't
  // (see `useChatRail`'s doc), in which case `startDm` falls back to a plain
  // navigation.
  const chatRail = useChatRail();

  useEffect(() => {
    setResolvedViewer(viewerUserId);
  }, [viewerUserId]);

  // Self-resolve only when the caller didn't tell us (prop omitted) and only
  // once the card is actually opened — no session fetch for cards nobody clicks.
  useEffect(() => {
    if (!open || viewerUserId !== undefined) return;
    let alive = true;
    resolveViewerUserId().then((id) => {
      if (alive) setResolvedViewer(id);
    });
    return () => {
      alive = false;
    };
  }, [open, viewerUserId]);

  const isSelf = resolvedViewer != null && resolvedViewer === userId;

  // Resolve DM eligibility lazily (only once the card is actually opened) —
  // avoids one /api/dm/candidates-backed lookup per avatar rendered on a page
  // that shows dozens of them (feed, member list).
  useEffect(() => {
    if (!open || isSelf || !resolvedViewer) {
      setCanDm(false);
      setDmChecked(false);
      return;
    }
    let alive = true;
    setDmChecked(false);
    isDmCandidate(userId).then((v) => {
      if (!alive) return;
      setCanDm(v);
      setDmChecked(true);
    });
    return () => {
      alive = false;
    };
  }, [open, userId, isSelf, resolvedViewer]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen((v) => !v);
  }, []);

  const startDm = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (starting) return;
      setStarting(true);
      try {
        const res = await fetch('/api/dm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data?.topicId) {
          setOpen(false);
          if (chatRail) {
            // Land the reader on the conversation they just started INSIDE
            // the rail, with focus — not a full-page navigation away from
            // wherever they were (feed, member list). See `ChatRail.tsx`'s
            // `openRequest` doc for the focus-on-apply behavior.
            chatRail.openRail({ kind: 'dm', topicId: data.topicId, title: nickname, profileImage: profileImage ?? null });
          } else {
            // No rail reachable from this tree (card rendered outside
            // `CommunityLayout`) — fall back to a full navigation so the DM
            // is still reachable instead of silently doing nothing.
            router.push(`/dm/${data.topicId}`);
          }
        }
      } catch {
        // best-effort — the card stays open so the user can retry
      } finally {
        setStarting(false);
      }
    },
    [starting, userId, router, chatRail, nickname, profileImage],
  );

  return (
    <span ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <span
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') toggle(e);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('userCard.viewProfile', { nickname })}
        style={{ display: 'inline-flex', cursor: 'pointer' }}
      >
        {children}
      </span>
      {open && (
        <div
          role="dialog"
          aria-label={t('userCard.profileCardLabel', { nickname })}
          data-testid="user-card-popover"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 6,
            zIndex: 60,
            width: 220,
            maxWidth: '80vw',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-card)',
            padding: 'var(--space-4)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: badges?.length ? 'var(--space-2)' : 'var(--space-3)', minWidth: 0 }}>
            <Avatar src={profileImage} name={nickname} size={40} />
            <span
              style={{
                fontSize: 'var(--text-body-sm)',
                fontWeight: 700,
                color: 'var(--foreground)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {nickname}
            </span>
          </div>
          {badges != null && badges.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 'var(--space-3)' }}>
              {badges.map((b, i) => (
                <Badge key={i} type={b.type} label={b.label} domain={b.domain ?? undefined} country={b.country ?? undefined} />
              ))}
            </div>
          ) : (
            <p data-testid="user-card-no-badges" style={noteStyle}>{t('userCard.noBadges')}</p>
          )}
          {/* Self and no-shared-topic are two different reasons the DM button
              is absent — say which one, rather than leaving a blank space
              that reads as broken. Self takes no dependency on the (still
              possibly in-flight) DM-candidacy check; not-DM-able waits for
              `dmChecked` so it never flashes on before the check has run. */}
          {isSelf && <p data-testid="user-card-self-note" style={noteStyle}>{t('userCard.self')}</p>}
          {!isSelf && resolvedViewer != null && dmChecked && !canDm && (
            <p data-testid="user-card-not-dmable" style={noteStyle}>
              {t('userCard.notDmable', { nickname })}
            </p>
          )}
          {!isSelf && resolvedViewer != null && canDm && (
            <button
              type="button"
              onClick={startDm}
              disabled={starting}
              data-testid="user-card-message"
              style={{
                width: '100%',
                background: 'var(--accent)',
                color: '#fff',
                border: 'none',
                borderRadius: 'var(--radius-control)',
                padding: '7px 0',
                fontSize: 'var(--text-caption)',
                fontWeight: 600,
                cursor: starting ? 'default' : 'pointer',
                opacity: starting ? 0.6 : 1,
                minHeight: 'var(--touch-target-min)',
              }}
            >
              {starting ? '...' : t('userCard.dmButton')}
            </button>
          )}
        </div>
      )}
    </span>
  );
}
