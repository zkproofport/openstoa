'use client';

/**
 * Per-topic push mute (P-S) — the bell in a chat header. Reads
 * `GET /api/topics/{topicId}/push` on mount and writes with `PATCH`.
 *
 * Shared by every surface that shows a topic's chat (the docked/expanded
 * ChatPanel header and the mobile sheet's own header bar) so the state logic
 * exists once. Guests and non-members render NOTHING: the endpoint 403s them
 * and they are never push recipients for the topic anyway.
 *
 * Until the read answers, the control is hidden rather than guessed — a bell
 * that shows "not muted" while the server says muted is worse than no bell.
 * The toggle is optimistic and reverts on failure, so the rendered state can
 * never disagree with the server for longer than one round trip.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/lib/i18n/I18nProvider';

const BellIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

const BellOffIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    <path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
    <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
    <path d="M18 8a6 6 0 0 0-9.33-5" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

export interface TopicMuteToggleProps {
  topicId: string;
  /** False for guests and non-members — the control renders nothing. */
  enabled: boolean;
  /** Extra styling for the host header (sizing differs per surface). */
  style?: React.CSSProperties;
}

export default function TopicMuteToggle({ topicId, enabled, style }: TopicMuteToggleProps) {
  const { t } = useTranslation();
  const [muted, setMuted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled || !topicId) {
      setMuted(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/topics/${topicId}/push`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { muted?: boolean } | null) => {
        if (!cancelled && d) setMuted(d.muted === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [topicId, enabled]);

  const toggle = useCallback(async () => {
    if (muted === null || busy) return;
    const next = !muted;
    setBusy(true);
    setMuted(next); // optimistic
    try {
      const res = await fetch(`/api/topics/${topicId}/push`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ muted: next }),
      });
      if (!res.ok) throw new Error(`mute toggle failed (${res.status})`);
      const d = (await res.json()) as { muted?: boolean };
      setMuted(d.muted === true);
    } catch {
      setMuted(!next); // revert — never leave a state the server rejected
    } finally {
      setBusy(false);
    }
  }, [muted, busy, topicId]);

  if (!enabled || muted === null) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={muted}
      aria-label={muted ? t('topicMuteToggle.unmute') : t('topicMuteToggle.mute')}
      title={muted ? t('topicMuteToggle.mutedTitle') : t('topicMuteToggle.mute')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        padding: 'var(--space-1) var(--space-2)',
        borderRadius: 'var(--radius-control)',
        background: muted ? 'color-mix(in srgb, var(--color-status-danger) 14%, transparent)' : 'transparent',
        color: muted ? 'var(--color-status-danger)' : 'var(--muted)',
        cursor: busy ? 'not-allowed' : 'pointer',
        opacity: busy ? 0.5 : 1,
        transition: 'background 0.12s, color 0.12s',
        // NOT bumped to --touch-target-min (44px): this control is always
        // embedded inline in a compact chat header row (ChatPanel/ChatRail,
        // ~30px tall) alongside other small icon buttons that keep the same
        // scale. Growing just this one to 44px would visibly enlarge the
        // header bar and misalign it against its siblings — a layout
        // regression, not a like-for-like token swap. See migration report.
        ...style,
      }}
    >
      {muted ? BellOffIcon : BellIcon}
    </button>
  );
}
