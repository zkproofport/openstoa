'use client';

import { useEffect, useState } from 'react';
import { ArrowUpIcon, ArrowDownIcon } from '@/components/icons';
import { usePostMutations, type VoteState } from '@/hooks/usePostMutations';
import { useTranslation } from '@/lib/i18n/I18nProvider';

interface VotePillProps {
  postId: string;
  upvoteCount: number;
  userVoted?: number | null;
  /** Guests can't vote — pill still renders but clicks are no-ops. */
  disabled?: boolean;
  /** Optional notifier so parent screens can update list-level totals
   *  (e.g. profile / topic feed) after a vote. */
  onChange?: (next: VoteState) => void;
  /** Compact = smaller font / icons for inline list rows. */
  size?: 'sm' | 'md';
}

// Reddit/HN-style vote pill — interactive everywhere (list AND detail)
// so the user gets the same upvote / downvote affordance on every
// surface. Owns its own optimistic state; falls back to props if the
// parent re-renders with a fresh value.
export default function VotePill({
  postId,
  upvoteCount,
  userVoted,
  disabled,
  onChange,
  size = 'md',
}: VotePillProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<VoteState>({
    userVoted: (userVoted ?? null) as 1 | -1 | null,
    upvoteCount,
  });
  const [pending, setPending] = useState(false);
  const { vote } = usePostMutations(postId);

  // Sync from props when the parent refreshes the underlying post.
  useEffect(() => {
    setState({
      userVoted: (userVoted ?? null) as 1 | -1 | null,
      upvoteCount,
    });
  }, [userVoted, upvoteCount]);

  const apply = async (value: 1 | -1, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled || pending) return;
    // Optimistic toggle — mirror the server's logic so the visible
    // count moves before the round-trip.
    const prev = state;
    let nextVote: 1 | -1 | null;
    let delta: number;
    if (prev.userVoted === value) {
      nextVote = null;
      delta = value === 1 ? -1 : 1;
    } else if (prev.userVoted === null) {
      nextVote = value;
      delta = value === 1 ? 1 : -1;
    } else {
      nextVote = value;
      delta = value === 1 ? 2 : -2;
    }
    const optimistic: VoteState = {
      userVoted: nextVote,
      upvoteCount: Math.max(0, prev.upvoteCount + delta),
    };
    setState(optimistic);
    onChange?.(optimistic);

    setPending(true);
    try {
      const res = await vote(value, prev);
      if (res.ok) {
        setState(res.next);
        onChange?.(res.next);
      } else {
        // Roll back on failure.
        setState(prev);
        onChange?.(prev);
        if (res.error === 'not_member') {
          window.alert('Join this topic to vote on its posts.');
        }
      }
    } finally {
      setPending(false);
    }
  };

  const iconSize = size === 'sm' ? 14 : 16;
  const fontSize = size === 'sm' ? 13 : 14;
  const padding = size === 'sm' ? '4px 10px' : '4px 10px';

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding,
        borderRadius: 16,
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border-default)',
      }}
    >
      <button
        type="button"
        onClick={(e) => apply(1, e)}
        disabled={disabled || pending}
        aria-label={t('a11y.upvote')}
        style={{
          background: 'none',
          border: 'none',
          cursor: disabled ? 'default' : 'pointer',
          padding: 2,
          display: 'flex',
          alignItems: 'center',
          color: state.userVoted === 1 ? 'var(--color-brand-accent)' : 'var(--muted)',
        }}
      >
        <ArrowUpIcon size={iconSize} filled={state.userVoted === 1} />
      </button>
      <span
        style={{
          fontSize,
          fontFamily: 'var(--font-mono)',
          minWidth: 16,
          textAlign: 'center',
          fontWeight: state.userVoted ? 700 : 600,
          fontVariantNumeric: 'tabular-nums',
          color:
            state.userVoted === 1
              ? 'var(--color-brand-accent)'
              : state.userVoted === -1
              ? 'var(--color-brand-primary)'
              : 'var(--muted)',
        }}
      >
        {state.upvoteCount}
      </span>
      <button
        type="button"
        onClick={(e) => apply(-1, e)}
        disabled={disabled || pending}
        aria-label={t('a11y.downvote')}
        style={{
          background: 'none',
          border: 'none',
          cursor: disabled ? 'default' : 'pointer',
          padding: 2,
          display: 'flex',
          alignItems: 'center',
          color: state.userVoted === -1 ? 'var(--color-brand-primary)' : 'var(--muted)',
        }}
      >
        <ArrowDownIcon size={iconSize} filled={state.userVoted === -1} />
      </button>
    </div>
  );
}
