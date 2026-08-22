'use client';

import { apiFetch } from '@/lib/apiFetch';
import { useCallback, useEffect, useState } from 'react';
import {
  HISTORY_SCOPES,
  MAX_API_KEY_NAME_LEN,
  cmdLabel,
  orderedCmd,
  validateApiKeyName,
} from '@/lib/apiKeyForm';
import { useTranslation } from '@/lib/i18n/I18nProvider';

// Shape returned by GET /api/profile/api-keys.
interface ApiKeyMeta {
  id: string;
  name: string;
  prefix: string;
  isAI: boolean;
  cmd: string[];
  historyGrant: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

// ─── Settings surface contract ───────────────────────────────────────────────

/**
 * ONE list idiom for every settings row on this surface.
 *
 * `/my`'s Settings tab used to stack five differently-styled panels — a bare
 * section here, a bordered card there, a tinted danger box at the bottom —
 * and the two components it embeds (`AiAgentSettings`, and `AccountRecovery`
 * via `/recovery`) each carried a third and fourth look. These two objects are
 * the whole contract: a bordered list, and a row inside it.
 *
 * Mirrored VERBATIM in `src/app/my/page.tsx` and
 * `src/components/AccountRecovery.tsx`, which render into this same surface.
 * `src/__tests__/settingsSurface.test.tsx` re-parses all three files and fails
 * if any copy drifts, so "they match" is a checked fact, not a convention.
 */
const SETTINGS_LIST: React.CSSProperties = {
  background: 'var(--color-bg-secondary)',
  border: '1px solid var(--color-border-default)',
  borderRadius: 'var(--radius-card)',
  overflow: 'hidden',
};
const SETTINGS_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-4)',
  flexWrap: 'wrap',
  padding: 'var(--space-4)',
  minHeight: 'var(--touch-target-min)',
};

/** A row that holds a composition rather than one control. */
const STACKED_ROW: React.CSSProperties = {
  ...SETTINGS_ROW,
  flexDirection: 'column',
  alignItems: 'stretch',
};
const ROW_DIVIDER: React.CSSProperties = { borderTop: '1px solid var(--color-border-default)' };

/** Explanatory copy under/above a list — capped at a reading measure. */
const NOTE: React.CSSProperties = {
  fontSize: 'var(--text-caption)',
  color: 'var(--color-text-tertiary)',
  lineHeight: 'var(--leading-base)',
  maxWidth: '68ch',
  margin: '0 0 var(--space-3)',
};
const FIELD_LABEL: React.CSSProperties = {
  fontSize: 'var(--text-body-sm)',
  fontWeight: 600,
  color: 'var(--color-text-primary)',
  margin: '0 0 var(--space-2)',
};
const inputStyle: React.CSSProperties = {
  flex: '1 1 200px',
  minWidth: 0,
  background: 'var(--color-bg-primary)',
  border: '1px solid var(--color-border-default)',
  borderRadius: 'var(--radius-control)',
  padding: '0 var(--space-3)',
  color: 'var(--color-text-primary)',
  // var(--text-body) = 16px: below that, iOS Safari zooms on focus.
  fontSize: 'var(--text-body)',
  fontFamily: 'var(--font-sans)',
  minHeight: 'var(--touch-target-min)',
  boxSizing: 'border-box',
};

/** Disabled treatment for the shared `.os-button` / `.os-chip` controls. */
function disabledStyle(enabled: boolean): React.CSSProperties {
  return { cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5 };
}

function scopeLabel(scope: string): string {
  return HISTORY_SCOPES.find((s) => s.key === scope)?.label ?? scope;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

/** Reusable checkbox grid for capability selection (shared by create + edit). */
function CapabilityGrid({
  allowedCmd,
  selected,
  onToggle,
  idPrefix,
}: {
  allowedCmd: string[];
  selected: Set<string>;
  onToggle: (cmd: string) => void;
  idPrefix: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {allowedCmd.map((cmd) => {
        const id = `${idPrefix}-${cmd}`;
        return (
          <label
            key={cmd}
            htmlFor={id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              // Every row here is a tap target, so it gets the tap minimum.
              minHeight: 'var(--touch-target-min)',
              padding: 'var(--space-1) 0',
              cursor: 'pointer',
              borderBottom: '1px solid var(--color-border-default)',
            }}
          >
            <input
              id={id}
              type="checkbox"
              checked={selected.has(cmd)}
              onChange={() => onToggle(cmd)}
              style={{ width: 16, height: 16, accentColor: 'var(--color-brand-primary)', flexShrink: 0 }}
            />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 'var(--text-body-sm)', color: 'var(--color-text-primary)', display: 'block' }}>{cmdLabel(cmd)}</span>
              <span className="os-break-all" style={{ fontSize: 'var(--text-label)', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>{cmd}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * Static, non-interactive summary of one API key — metadata ONLY (never the raw
 * key). Exported + pure so the XSS-safety and metadata-only edge-case rows can
 * be asserted with a server-render harness (renderToStaticMarkup). React escapes
 * the user-controlled `name` here, and only `prefix` (a short display slice) is
 * ever emitted — never a full `osk_` secret.
 */
export function ApiKeyMetaSummary({ k }: { k: ApiKeyMeta }) {
  const { t } = useTranslation();
  const revoked = !!k.revokedAt;
  return (
    <>
      <span style={{ fontSize: 'var(--text-body-sm)', fontWeight: 600, color: 'var(--color-text-primary)' }}>{k.name}</span>
      <code style={{ fontSize: 'var(--text-label)', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>{k.prefix}…</code>
      {revoked && (
        <span style={{ fontSize: 'var(--text-label)', fontWeight: 600, color: 'var(--color-status-danger)', border: '1px solid color-mix(in srgb, var(--color-status-danger) 30%, transparent)', borderRadius: 'var(--radius-control)', padding: '1px var(--space-2)' }}>
          {t('aiAgentSettings.revoked')}
        </span>
      )}
    </>
  );
}

/** History-grant chip selector (shared). */
function HistoryScopeChips({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      {HISTORY_SCOPES.map((s) => (
        <button
          key={s.key}
          type="button"
          className="os-chip"
          // `.os-chip` styles its own selected state off aria-pressed — the
          // same quiet "raised, not highlighted" treatment the feed's sort
          // chips use, so these do not shout over the rows around them.
          aria-pressed={value === s.key}
          onClick={() => onChange(s.key)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

export default function AiAgentSettings() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [allowedCmd, setAllowedCmd] = useState<string[]>([]);

  // API keys — the only unit of AI capability scope (design §7 consolidation).
  const [keys, setKeys] = useState<ApiKeyMeta[]>([]);
  const [newName, setNewName] = useState('');
  const [newCmd, setNewCmd] = useState<Set<string>>(new Set());
  const [newHistory, setNewHistory] = useState('none');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // Inline scope edit — at most one key row editing at a time.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCmd, setEditCmd] = useState<Set<string>>(new Set());
  const [editHistory, setEditHistory] = useState('none');
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const keysRes = await apiFetch('/api/profile/api-keys');
      if (keysRes.status === 401) {
        throw new Error(t('aiAgentSettings.signInRequired'));
      }
      if (!keysRes.ok) throw new Error(t('aiAgentSettings.loadKeysFailed'));
      const keyList = (await keysRes.json()) as { apiKeys: ApiKeyMeta[]; allowedCmd?: string[] };
      setAllowedCmd(keyList.allowedCmd ?? []);
      setKeys(keyList.apiKeys ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t('aiAgentSettings.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const toggleNewCmd = useCallback((cmd: string) => {
    setNewCmd((prev) => {
      const next = new Set(prev);
      if (next.has(cmd)) next.delete(cmd);
      else next.add(cmd);
      return next;
    });
  }, []);

  const toggleEditCmd = useCallback((cmd: string) => {
    setEditCmd((prev) => {
      const next = new Set(prev);
      if (next.has(cmd)) next.delete(cmd);
      else next.add(cmd);
      return next;
    });
  }, []);

  const nameError = newName ? validateApiKeyName(newName) : null;
  const canCreate = !creating && validateApiKeyName(newName) === null;

  async function createKey() {
    const err = validateApiKeyName(newName);
    if (err) {
      setCreateError(err);
      return;
    }
    setCreating(true);
    setCreateError(null);
    setRawKey(null);
    try {
      const res = await apiFetch('/api/profile/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          cmd: orderedCmd(allowedCmd, newCmd),
          historyGrant: newHistory,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? t('aiAgentSettings.createKeyFailed'));
      }
      const data = (await res.json()) as { rawKey: string; key: ApiKeyMeta };
      // Show the raw key exactly once; the list only ever carries metadata.
      setRawKey(data.rawKey);
      setKeys((prev) => [data.key, ...prev]);
      setNewName('');
      setNewCmd(new Set());
      setNewHistory('none');
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : t('common.networkError'));
    } finally {
      setCreating(false);
    }
  }

  function startEdit(k: ApiKeyMeta) {
    setEditingId(k.id);
    setEditCmd(new Set(k.cmd));
    setEditHistory(k.historyGrant || 'none');
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function saveEdit(keyId: string) {
    setSavingEdit(true);
    setEditError(null);
    try {
      const res = await apiFetch(`/api/profile/api-keys/${keyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: orderedCmd(allowedCmd, editCmd), historyGrant: editHistory }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? t('aiAgentSettings.editKeyFailed'));
      }
      const data = (await res.json()) as { key: ApiKeyMeta };
      setKeys((prev) => prev.map((k) => (k.id === keyId ? data.key : k)));
      setEditingId(null);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : t('common.networkError'));
    } finally {
      setSavingEdit(false);
    }
  }

  async function revokeKey(id: string) {
    setRevokingId(id);
    setRevokeError(null);
    try {
      const res = await apiFetch(`/api/profile/api-keys/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? t('aiAgentSettings.revokeKeyFailed'));
      }
      // Reflect revocation locally (metadata only).
      setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, revokedAt: new Date().toISOString() } : k)));
      setConfirmingRevoke(null);
      if (editingId === id) setEditingId(null);
    } catch (e) {
      setRevokeError(e instanceof Error ? e.message : t('common.networkError'));
    } finally {
      setRevokingId(null);
    }
  }

  if (loading) {
    return <div style={{ ...SETTINGS_LIST, ...SETTINGS_ROW, color: 'var(--color-text-tertiary)', fontSize: 'var(--text-body-sm)' }}>{t('aiAgentSettings.loadingSettings')}</div>;
  }
  if (loadError) {
    return (
      <div style={{ ...SETTINGS_LIST, ...SETTINGS_ROW }}>
        <span style={{ flex: '1 1 200px', minWidth: 0, fontSize: 'var(--text-body-sm)', color: 'var(--color-status-danger)' }}>{loadError}</span>
        <button type="button" className="os-button" onClick={() => void loadAll()}>
          {t('common.retry')}
        </button>
      </div>
    );
  }

  return (
    <div>
      <p style={NOTE}>{t('aiAgentSettings.intro')}</p>
      <p style={NOTE}>
        {t('aiAgentSettings.keyDescPre')} <span style={{ fontFamily: 'var(--font-mono)' }}>osk_…</span> {t('aiAgentSettings.keyDescMid')}{' '}
        <span style={{ fontFamily: 'var(--font-mono)' }}>OPENSTOA_API_KEY</span>{t('aiAgentSettings.keyDescPost')}
      </p>

      {/* Raw key — shown exactly once, and never re-fetched. Deliberately the
          one panel on this surface that does NOT read as a settings row: it is
          a transient reveal the user must act on before it disappears, so it
          keeps the accent border that marks it as such. */}
      {rawKey && (
        <div
          style={{
            ...SETTINGS_LIST,
            background: 'color-mix(in srgb, var(--color-brand-accent) 6%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-brand-accent) 30%, transparent)',
            padding: 'var(--space-4)',
            marginBottom: 'var(--space-3)',
          }}
        >
          <p style={{ fontSize: 'var(--text-body-sm)', fontWeight: 700, color: 'var(--color-brand-accent)', margin: '0 0 var(--space-1)' }}>
            {t('aiAgentSettings.copyKeyNow')}
          </p>
          <p style={{ ...NOTE, margin: '0 0 var(--space-3)' }}>
            {t('aiAgentSettings.hashOnlyStored')}
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <code
              className="os-break-all"
              style={{
                flex: '1 1 220px',
                minWidth: 0,
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-caption)',
                color: 'var(--color-text-primary)',
                // Deliberately near-black in both themes so a shoulder-surfed
                // key stays low-contrast (see tokenSweep ALLOWLIST).
                background: 'rgba(0,0,0,0.4)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-control)',
                padding: 'var(--space-3)',
              }}
            >
              {rawKey}
            </code>
            <button
              type="button"
              className="os-button os-button-primary"
              onClick={() => {
                navigator.clipboard?.writeText(rawKey);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? t('aiAgentSettings.copied') : t('aiAgentSettings.copy')}
            </button>
          </div>
          <button
            type="button"
            className="os-chip"
            onClick={() => { setRawKey(null); setCopied(false); }}
            style={{ marginTop: 'var(--space-2)', paddingLeft: 0, paddingRight: 0 }}
          >
            {t('aiAgentSettings.dismissSavedKey')}
          </button>
        </div>
      )}

      <div style={SETTINGS_LIST}>
        {/* Create — one row, stacked because it is a form, not a switch. */}
        <div style={STACKED_ROW}>
          <p style={FIELD_LABEL}>{t('aiAgentSettings.createNewKey')}</p>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <input
              type="text"
              value={newName}
              onChange={(e) => { setNewName(e.target.value); setCreateError(null); }}
              placeholder={t('aiAgentSettings.keyNamePlaceholder')}
              aria-label={t('aiAgentSettings.createNewKey')}
              maxLength={MAX_API_KEY_NAME_LEN}
              style={{ ...inputStyle, borderColor: nameError ? 'var(--color-status-danger)' : 'var(--color-border-default)' }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', fontSize: 'var(--text-label)', margin: 'var(--space-1) 0 var(--space-4)' }}>
            <span style={{ color: nameError ? 'var(--color-status-danger)' : 'var(--color-text-tertiary)' }}>
              {nameError ?? t('aiAgentSettings.keyNameHint')}
            </span>
            <span style={{ color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{newName.length}/{MAX_API_KEY_NAME_LEN}</span>
          </div>

          <p style={FIELD_LABEL}>{t('aiAgentSettings.keyScope')}</p>
          <CapabilityGrid allowedCmd={allowedCmd} selected={newCmd} onToggle={toggleNewCmd} idPrefix="new" />

          <div style={{ marginTop: 'var(--space-4)' }}>
            <p style={FIELD_LABEL}>{t('aiAgentSettings.keyHistoryBackfill')}</p>
            <HistoryScopeChips value={newHistory} onChange={setNewHistory} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', marginTop: 'var(--space-4)' }}>
            <button type="button" className="os-button os-button-primary" onClick={createKey} disabled={!canCreate} style={disabledStyle(canCreate)}>
              {creating ? t('aiAgentSettings.creating') : t('aiAgentSettings.createKey')}
            </button>
            {createError && <span style={{ fontSize: 'var(--text-caption)', color: 'var(--color-status-danger)' }}>{createError}</span>}
          </div>
        </div>

        {/* Existing keys — each row IS the scope; edit or revoke per key */}
        {keys.length === 0 ? (
          <div style={{ ...SETTINGS_ROW, ...ROW_DIVIDER, fontSize: 'var(--text-body-sm)', color: 'var(--color-text-tertiary)' }}>
            {t('aiAgentSettings.noApiKeys')}
          </div>
        ) : (
          keys.map((k) => {
            const revoked = !!k.revokedAt;
            const isEditing = editingId === k.id;
            return (
              <div key={k.id} style={{ ...STACKED_ROW, ...ROW_DIVIDER, opacity: revoked ? 0.55 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                  <ApiKeyMetaSummary k={k} />
                  <span style={{ flex: 1 }} />
                  {!revoked && !isEditing && (
                    <button type="button" className="os-chip" onClick={() => startEdit(k)}>
                      {t('aiAgentSettings.editScope')}
                    </button>
                  )}
                  {!revoked && (
                    confirmingRevoke === k.id ? (
                      <span style={{ display: 'inline-flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 'var(--text-caption)', color: 'var(--color-status-danger)' }}>{t('aiAgentSettings.revokeConfirm')}</span>
                        <button
                          type="button"
                          className="os-chip"
                          onClick={() => revokeKey(k.id)}
                          disabled={revokingId === k.id}
                          style={{ color: 'var(--color-status-danger)', fontWeight: 600, ...disabledStyle(revokingId !== k.id) }}
                        >
                          {revokingId === k.id ? '…' : t('aiAgentSettings.confirm')}
                        </button>
                        <button
                          type="button"
                          className="os-chip"
                          onClick={() => { setConfirmingRevoke(null); setRevokeError(null); }}
                        >
                          {t('common.cancel')}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="os-chip"
                        onClick={() => { setConfirmingRevoke(k.id); setRevokeError(null); }}
                        style={{ color: 'var(--color-status-danger)' }}
                      >
                        {t('aiAgentSettings.revoke')}
                      </button>
                    )
                  )}
                </div>

                {isEditing ? (
                  <div style={{ marginTop: 'var(--space-3)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--color-border-default)' }}>
                    <p style={FIELD_LABEL}>{t('aiAgentSettings.keyScope')}</p>
                    <CapabilityGrid allowedCmd={allowedCmd} selected={editCmd} onToggle={toggleEditCmd} idPrefix={`edit-${k.id}`} />
                    <div style={{ marginTop: 'var(--space-4)' }}>
                      <p style={FIELD_LABEL}>{t('aiAgentSettings.keyHistoryBackfill')}</p>
                      <HistoryScopeChips value={editHistory} onChange={setEditHistory} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', marginTop: 'var(--space-4)' }}>
                      <button type="button" className="os-button os-button-primary" onClick={() => saveEdit(k.id)} disabled={savingEdit} style={disabledStyle(!savingEdit)}>
                        {savingEdit ? t('aiAgentSettings.saving') : t('aiAgentSettings.saveScope')}
                      </button>
                      <button type="button" className="os-button" onClick={cancelEdit} disabled={savingEdit} style={disabledStyle(!savingEdit)}>
                        {t('common.cancel')}
                      </button>
                      {editError && <span style={{ fontSize: 'var(--text-caption)', color: 'var(--color-status-danger)' }}>{editError}</span>}
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 'var(--text-label)', color: 'var(--color-text-tertiary)', marginTop: 'var(--space-2)', display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
                    <span>{t('aiAgentSettings.scopeLabel', { value: k.cmd.length === 0 ? t('aiAgentSettings.scopeNone') : k.cmd.map(cmdLabel).join(', ') })}</span>
                    <span>{t('aiAgentSettings.historyLabel', { value: scopeLabel(k.historyGrant) })}</span>
                    <span>{t('aiAgentSettings.createdLabel', { value: fmtDate(k.createdAt) })}</span>
                    <span>{t('aiAgentSettings.lastUsedLabel', { value: fmtDate(k.lastUsedAt) })}</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      {revokeError && <p style={{ ...NOTE, color: 'var(--color-status-danger)', margin: 'var(--space-3) 0 0' }}>{revokeError}</p>}
    </div>
  );
}
