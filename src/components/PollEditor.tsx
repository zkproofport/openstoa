'use client';

import { useCallback, useMemo } from 'react';
import { useTranslation } from '@/lib/i18n/I18nProvider';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PollEditorValue {
  question?: string;
  options: string[];
  multipleChoice: boolean;
  /** ISO timestamp when the poll closes. `null` / `undefined` = never. */
  closesAt?: string | null;
}

interface PollEditorProps {
  value: PollEditorValue;
  onChange: (next: PollEditorValue) => void;
  onRemove: () => void;
}

type DurationOption = 'off' | '1d' | '3d' | '7d';

const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTION_LEN = 80;
const MAX_QUESTION_LEN = 200;

// ─── Helpers ────────────────────────────────────────────────────────────────

function durationToIso(d: DurationOption): string | null {
  if (d === 'off') return null;
  const ms = d === '1d' ? 24 * 60 * 60 * 1000
    : d === '3d' ? 3 * 24 * 60 * 60 * 1000
    : 7 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ms).toISOString();
}

function isoToDuration(iso: string | null | undefined): DurationOption {
  if (!iso) return 'off';
  const remaining = new Date(iso).getTime() - Date.now();
  const day = 24 * 60 * 60 * 1000;
  if (remaining <= 1.5 * day) return '1d';
  if (remaining <= 5 * day) return '3d';
  return '7d';
}

// ─── Icons ──────────────────────────────────────────────────────────────────

const IconClose = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="3" y1="3" x2="9" y2="9" />
    <line x1="9" y1="3" x2="3" y2="9" />
  </svg>
);

const IconTrash = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 4h11" />
    <path d="M4 4v9a1.5 1.5 0 0 0 1.5 1.5h5A1.5 1.5 0 0 0 12 13V4" />
    <path d="M6 4V2.5A1 1 0 0 1 7 1.5h2a1 1 0 0 1 1 1V4" />
  </svg>
);

// ─── Main Component ─────────────────────────────────────────────────────────

export default function PollEditor({ value, onChange, onRemove }: PollEditorProps) {
  const { t } = useTranslation();
  const options = value.options.length >= MIN_OPTIONS
    ? value.options
    : [...value.options, ...Array(MIN_OPTIONS - value.options.length).fill('')];

  const duration = useMemo<DurationOption>(() => isoToDuration(value.closesAt), [value.closesAt]);

  const update = useCallback((patch: Partial<PollEditorValue>) => {
    onChange({ ...value, ...patch });
  }, [onChange, value]);

  const updateOption = useCallback((i: number, text: string) => {
    const next = [...options];
    next[i] = text.slice(0, MAX_OPTION_LEN);
    update({ options: next });
  }, [options, update]);

  const addOption = useCallback(() => {
    if (options.length >= MAX_OPTIONS) return;
    update({ options: [...options, ''] });
  }, [options, update]);

  const removeOption = useCallback((i: number) => {
    if (options.length <= MIN_OPTIONS) return;
    update({ options: options.filter((_, idx) => idx !== i) });
  }, [options, update]);

  const setDuration = useCallback((d: DurationOption) => {
    update({ closesAt: durationToIso(d) });
  }, [update]);

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-card)',
        background: 'var(--color-bg-secondary)',
        padding: '14px 16px',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 'var(--space-3)',
      }}>
        <span style={{
          fontSize: 'var(--text-label)',
          fontWeight: 600,
          color: 'var(--color-text-secondary)',
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}>
          {t('pollEditor.label')}
        </span>
        <button
          type="button"
          onClick={onRemove}
          title={t('pollEditor.removePoll')}
          aria-label={t('pollEditor.removePoll')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            background: 'transparent',
            border: '1px solid var(--color-border-default)',
            color: 'var(--color-text-secondary)',
            borderRadius: 'var(--radius-control)',
            padding: 'var(--space-1) var(--space-2)',
            fontSize: 'var(--text-label)',
            cursor: 'pointer',
            transition: 'color 0.12s, background 0.12s',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, var(--color-status-danger) 8%, transparent)';
            (e.currentTarget as HTMLElement).style.color = 'var(--color-status-danger)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'transparent';
            (e.currentTarget as HTMLElement).style.color = 'var(--color-text-secondary)';
          }}
        >
          <IconTrash />
          {t('pollEditor.remove')}
        </button>
      </div>

      {/* Question */}
      <input
        type="text"
        value={value.question ?? ''}
        onChange={(e) => update({ question: e.target.value.slice(0, MAX_QUESTION_LEN) })}
        placeholder={t('pollEditor.questionPlaceholder')}
        style={{
          width: '100%',
          background: 'var(--color-bg-primary)',
          border: '1px solid var(--color-border-default)',
          borderRadius: 8,
          padding: 'var(--space-2) var(--space-3)',
          color: 'var(--foreground)',
          // var(--text-body) = 16px: below that, iOS Safari zooms on focus.
          fontSize: 'var(--text-body)',
          outline: 'none',
          marginBottom: 10,
          boxSizing: 'border-box',
          fontFamily: 'inherit',
        }}
      />

      {/* Options */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
        {options.map((opt, i) => {
          const overflow = opt.length > MAX_OPTION_LEN;
          return (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="text"
                value={opt}
                onChange={(e) => updateOption(i, e.target.value)}
                placeholder={t('pollEditor.optionPlaceholder', { index: i + 1 })}
                maxLength={MAX_OPTION_LEN}
                style={{
                  flex: 1,
                  background: 'var(--color-bg-primary)',
                  border: `1px solid ${overflow ? 'color-mix(in srgb, var(--color-status-danger) 40%, transparent)' : 'var(--color-bg-tertiary)'}`,
                  borderRadius: 7,
                  padding: 'var(--space-2) var(--space-3)',
                  color: 'var(--color-text-primary)',
                  // var(--text-body) = 16px: below that, iOS Safari zooms on focus.
                  fontSize: 'var(--text-body)',
                  outline: 'none',
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  boxSizing: 'border-box',
                }}
              />
              <span style={{
                fontSize: 11,
                color: 'var(--color-text-tertiary)',
                fontFamily: 'var(--font-mono)',
                fontVariantNumeric: 'tabular-nums',
                minWidth: 32,
                textAlign: 'right',
              }}>
                {opt.length}/{MAX_OPTION_LEN}
              </span>
              <button
                type="button"
                onClick={() => removeOption(i)}
                disabled={options.length <= MIN_OPTIONS}
                aria-label={t('pollEditor.removeOption', { index: i + 1 })}
                title={t('pollEditor.remove')}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  background: 'var(--color-bg-secondary)',
                  border: '1px solid var(--color-border-default)',
                  color: options.length <= MIN_OPTIONS ? 'var(--color-border-strong)' : 'var(--color-text-secondary)',
                  cursor: options.length <= MIN_OPTIONS ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                  opacity: options.length <= MIN_OPTIONS ? 0.4 : 1,
                  flexShrink: 0,
                }}
              >
                <IconClose />
              </button>
            </div>
          );
        })}
      </div>

      {/* Add option */}
      {options.length < MAX_OPTIONS && (
        <button
          type="button"
          onClick={addOption}
          style={{
            background: 'var(--color-brand-primary-muted)',
            color: 'var(--accent)',
            border: '1px solid var(--color-brand-primary)',
            borderRadius: 7,
            padding: '6px 12px',
            fontSize: 'var(--text-label)',
            fontWeight: 600,
            cursor: 'pointer',
            marginBottom: 'var(--space-3)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {t('pollEditor.addOption')}
        </button>
      )}

      {/* Controls: single/multi + duration */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
        paddingTop: 10,
        borderTop: '1px solid var(--color-border-default)',
      }}>
        {/* Single / Multi toggle */}
        <div style={{ display: 'inline-flex', borderRadius: 7, overflow: 'hidden', border: '1px solid var(--color-border-default)' }}>
          {(['single', 'multi'] as const).map((mode) => {
            const active = (mode === 'multi') === value.multipleChoice;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => update({ multipleChoice: mode === 'multi' })}
                style={{
                  background: active ? 'var(--accent)' : 'transparent',
                  color: active ? 'var(--color-text-inverted)' : 'var(--color-text-secondary)',
                  border: 'none',
                  padding: '6px 14px',
                  fontSize: 'var(--text-label)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                  transition: 'background 0.12s, color 0.12s',
                }}
              >
                {mode === 'single' ? t('pollEditor.single') : t('pollEditor.multi')}
              </button>
            );
          })}
        </div>

        {/* Duration */}
        <label style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 'var(--text-label)',
          color: 'var(--color-text-secondary)',
          fontFamily: 'var(--font-mono)',
        }}>
          {t('pollEditor.duration')}
          <select
            value={duration}
            onChange={(e) => setDuration(e.target.value as DurationOption)}
            style={{
              background: 'var(--color-bg-primary)',
              border: '1px solid var(--color-border-default)',
              borderRadius: 'var(--radius-control)',
              padding: '5px 8px',
              color: 'var(--color-text-primary)',
              fontSize: 'var(--text-label)',
              fontFamily: 'var(--font-mono)',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            <option value="off">{t('pollEditor.durationOff')}</option>
            <option value="1d">{t('pollEditor.duration1d')}</option>
            <option value="3d">{t('pollEditor.duration3d')}</option>
            <option value="7d">{t('pollEditor.duration7d')}</option>
          </select>
        </label>
      </div>
    </div>
  );
}
