'use client';

import { useEffect, useState } from 'react';
import { usePostMutations, type ReactionSummary } from '@/hooks/usePostMutations';

interface ReactionRowProps {
  postId: string;
  reactions?: ReactionSummary[];
  /** Detail surfaces show the emoji picker. List rows show stats only. */
  interactive?: boolean;
  /** Guests can't react — picker is hidden. */
  disabled?: boolean;
  /** Skip the initial GET fetch (parent already has the reactions). */
  initialKnown?: boolean;
  onChange?: (next: ReactionSummary[]) => void;
}

const REACTION_EMOJIS = ['👍', '❤️', '🔥', '😂', '🎉', '😮'];

// Reaction strip — read-only stats on list rows, full picker on detail.
// Same visual recipe in both modes so the badge styles stay identical
// after a user reacts and the cache trickles back into the list.
export default function ReactionRow({
  postId,
  reactions,
  interactive = false,
  disabled,
  initialKnown,
  onChange,
}: ReactionRowProps) {
  const [state, setState] = useState<ReactionSummary[]>(reactions ?? []);
  const [showPicker, setShowPicker] = useState(false);
  const [pending, setPending] = useState(false);
  const { toggleReaction } = usePostMutations(postId);

  useEffect(() => {
    if (reactions !== undefined) setState(reactions);
  }, [reactions]);

  useEffect(() => {
    if (initialKnown || reactions !== undefined) return;
    let cancelled = false;
    fetch(`/api/posts/${postId}/reactions`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.reactions) setState(data.reactions);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [postId, initialKnown, reactions]);

  const visible = state.filter((r) => r.count > 0);

  if (visible.length === 0 && (!interactive || disabled)) return null;

  const pick = async (emoji: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (pending || disabled) return;
    setShowPicker(false);
    const prev = state;
    setPending(true);
    try {
      const next = await toggleReaction(emoji, prev);
      setState(next);
      onChange?.(next);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
      }}
    >
      {visible.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={(e) => pick(r.emoji, e)}
          disabled={!interactive || disabled || pending}
          style={{
            background: r.userReacted ? 'var(--color-brand-primary-muted)' : 'var(--color-bg-secondary)',
            border: r.userReacted ? '1px solid var(--color-brand-primary)' : '1px solid var(--color-border-default)',
            borderRadius: 9999,
            padding: interactive ? '4px 12px' : '2px 8px',
            fontSize: interactive ? 14 : 12,
            cursor: interactive && !disabled ? 'pointer' : 'default',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            color: r.userReacted ? 'var(--accent)' : 'var(--color-text-secondary)',
            transition: 'all 0.12s',
          }}
        >
          <span>{r.emoji}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', fontSize: interactive ? 13 : 12 }}>
            {r.count}
          </span>
        </button>
      ))}
      {interactive && !disabled && (
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setShowPicker((v) => !v);
            }}
            aria-label="Add reaction"
            style={{
              background: showPicker ? 'var(--color-bg-tertiary)' : 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border-default)',
              borderRadius: 9999,
              padding: '4px 12px',
              fontSize: 14,
              cursor: 'pointer',
              color: 'var(--color-text-tertiary)',
              transition: 'all 0.12s',
            }}
          >
            +
          </button>
          {showPicker && (
            <div
              style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                marginBottom: 6,
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 10,
                padding: '6px 8px',
                display: 'flex',
                gap: 2,
                zIndex: 10,
                boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
              }}
            >
              {REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={(e) => pick(emoji, e)}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: 20,
                    cursor: 'pointer',
                    padding: '6px 8px',
                    borderRadius: 6,
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-tertiary)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = 'none';
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
