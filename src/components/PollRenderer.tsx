'use client';

import { useMemo, useState } from 'react';
import type { Poll } from '@/lib/polls';
import { useTranslation } from '@/lib/i18n/I18nProvider';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PollRendererProps {
  poll: Poll;
  onVote: (optionIds: string[]) => Promise<void>;
  onUnvote: () => Promise<void>;
  loading?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function relativeFuture(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'closed';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function PollRenderer({ poll, onVote, onUnvote, loading }: PollRendererProps) {
  const { t } = useTranslation();
  const hasVoted = poll.userVotedOptionIds.length > 0;
  const isClosed = poll.isClosed;
  const showResults = hasVoted || isClosed;

  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orderedOptions = useMemo(
    () => [...poll.options].sort((a, b) => a.position - b.position),
    [poll.options],
  );

  function toggleSelect(optionId: string) {
    if (poll.multipleChoice) {
      setSelected((prev) =>
        prev.includes(optionId) ? prev.filter((id) => id !== optionId) : [...prev, optionId],
      );
    } else {
      // Single choice: select-only behavior; submission happens via Vote button
      // OR via direct first click below.
      setSelected([optionId]);
    }
  }

  async function submitVote(ids: string[]) {
    if (ids.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onVote(ids);
      setSelected([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('poll.voteFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUnvote() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onUnvote();
      setSelected([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('poll.unvoteFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  // Single-choice "click row = submit" for unvoted/open polls.
  async function handleRowClick(optionId: string) {
    if (showResults || isClosed) return;
    if (poll.multipleChoice) {
      toggleSelect(optionId);
    } else {
      await submitVote([optionId]);
    }
  }

  const disabled = submitting || loading;

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-card)',
        background: 'rgba(255,255,255,0.02)',
        padding: '14px 16px',
        marginTop: 'var(--space-3)',
        marginBottom: 'var(--space-3)',
      }}
    >
      {/* Question */}
      {poll.question && (
        <div style={{
          fontSize: 'var(--text-body-sm)',
          fontWeight: 600,
          color: '#e5e7eb',
          marginBottom: 10,
          lineHeight: 1.4,
        }}>
          {poll.question}
        </div>
      )}

      {/* Options */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {orderedOptions.map((opt) => {
          const isUserPick = poll.userVotedOptionIds.includes(opt.id);
          const isSelected = selected.includes(opt.id);
          const pct = poll.totalVotes > 0 ? Math.round((opt.voteCount / poll.totalVotes) * 100) : 0;

          if (showResults) {
            return (
              <div
                key={opt.id}
                style={{
                  position: 'relative',
                  border: `1px solid ${isUserPick ? 'rgba(59,130,246,0.4)' : 'rgba(255,255,255,0.08)'}`,
                  borderRadius: 8,
                  padding: 'var(--space-2) var(--space-3)',
                  background: '#0a0a0a',
                  overflow: 'hidden',
                }}
              >
                {/* Bar fill */}
                <div
                  aria-hidden
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: `${pct}%`,
                    background: isUserPick ? 'rgba(59,130,246,0.18)' : 'rgba(255,255,255,0.05)',
                    transition: 'width 0.3s ease-out',
                  }}
                />
                <div style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                }}>
                  <span style={{
                    fontSize: 'var(--text-caption)',
                    color: '#e5e7eb',
                    fontWeight: isUserPick ? 600 : 500,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}>
                    {isUserPick && <span style={{ marginRight: 6, color: 'var(--accent)' }}>✓</span>}
                    {opt.text}
                  </span>
                  <span style={{
                    fontSize: 'var(--text-label)',
                    color: isUserPick ? 'var(--accent)' : '#9ca3af',
                    fontFamily: 'monospace',
                    fontVariantNumeric: 'tabular-nums',
                    fontWeight: 600,
                    flexShrink: 0,
                  }}>
                    {pct}% · {opt.voteCount}
                  </span>
                </div>
              </div>
            );
          }

          // Open + not voted: tap rows
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => handleRowClick(opt.id)}
              disabled={disabled || isClosed}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                background: isSelected ? 'rgba(59,130,246,0.12)' : '#0a0a0a',
                border: `1px solid ${isSelected ? 'rgba(59,130,246,0.4)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: 8,
                padding: '10px 12px',
                color: '#e5e7eb',
                fontSize: 'var(--text-caption)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                textAlign: 'left',
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                transition: 'background 0.12s, border-color 0.12s',
                opacity: disabled ? 0.6 : 1,
              }}
            >
              {/* Radio / Checkbox indicator */}
              <span
                aria-hidden
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: poll.multipleChoice ? 4 : '50%',
                  border: `1.5px solid ${isSelected ? 'var(--accent)' : 'rgba(255,255,255,0.3)'}`,
                  background: isSelected ? 'var(--accent)' : 'transparent',
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {isSelected && (
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="2,6 5,9 10,3" />
                  </svg>
                )}
              </span>
              <span style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {opt.text}
              </span>
            </button>
          );
        })}
      </div>

      {/* Error */}
      {error && (
        <div style={{
          marginTop: 'var(--space-2)',
          fontSize: 'var(--text-label)',
          color: '#ef4444',
          fontFamily: 'monospace',
        }}>
          {error}
        </div>
      )}

      {/* Footer: status + Vote / Unvote */}
      <div style={{
        marginTop: 10,
        paddingTop: 'var(--space-2)',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        flexWrap: 'wrap',
        fontSize: 12,
        color: '#9ca3af',
        fontFamily: 'monospace',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {t('poll.voteCount', { count: poll.totalVotes, suffix: poll.totalVotes !== 1 ? 's' : '' })}
          </span>
          <span style={{ color: '#4b5563' }}>·</span>
          <span>
            {isClosed
              ? t('poll.closed')
              : poll.closesAt
                ? t('poll.closesIn', { time: relativeFuture(poll.closesAt) })
                : t('poll.open')}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Multi-choice + open + not voted yet: explicit Vote button */}
          {!showResults && poll.multipleChoice && !isClosed && (
            <button
              type="button"
              onClick={() => submitVote(selected)}
              disabled={disabled || selected.length === 0}
              style={{
                background: selected.length === 0 ? 'rgba(255,255,255,0.06)' : 'var(--accent)',
                color: selected.length === 0 ? '#6b7280' : '#fff',
                border: 'none',
                borderRadius: 'var(--radius-control)',
                padding: '5px 14px',
                fontSize: 'var(--text-label)',
                fontWeight: 600,
                cursor: disabled || selected.length === 0 ? 'not-allowed' : 'pointer',
                fontFamily: 'monospace',
                transition: 'background 0.12s',
              }}
            >
              {submitting ? t('poll.voting') : t('poll.vote')}
            </button>
          )}

          {/* Voted + open: Unvote link */}
          {hasVoted && !isClosed && (
            <button
              type="button"
              onClick={handleUnvote}
              disabled={disabled}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent)',
                fontSize: 'var(--text-label)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                padding: 0,
                fontFamily: 'monospace',
                textDecoration: 'underline',
              }}
            >
              {submitting ? '...' : t('poll.unvote')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
