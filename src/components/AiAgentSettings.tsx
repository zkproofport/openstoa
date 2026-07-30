'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CMD_LABELS,
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

// Font-size/weight/family + the language-conditional uppercase+tracking come
// from the `.os-label` utility class (globals.css) — apply that class
// alongside this style object at each usage site (mirrors LeftSidebar's
// sectionHeadingStyle pattern).
const sectionTitleStyle: React.CSSProperties = {
  color: '#6b7280',
  margin: '0 0 12px',
};
const subCardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 10,
  padding: 'var(--space-4)',
};
const inputStyle: React.CSSProperties = {
  flex: 1,
  background: 'var(--surface, #0c0e18)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  padding: '9px 12px',
  color: '#e5e7eb',
  // var(--text-body) = 16px: below that, iOS Safari zooms on focus.
  fontSize: 'var(--text-body)',
  outline: 'none',
};
const primaryBtn = (enabled: boolean): React.CSSProperties => ({
  background: 'var(--accent)',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  padding: '9px 20px',
  fontSize: 'var(--text-body-sm)',
  fontWeight: 600,
  cursor: enabled ? 'pointer' : 'not-allowed',
  opacity: enabled ? 1 : 0.5,
  transition: 'opacity 0.12s',
});
const secondaryBtn = (enabled: boolean): React.CSSProperties => ({
  background: 'rgba(255,255,255,0.06)',
  color: '#e5e7eb',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  padding: '4px 12px',
  fontSize: 'var(--text-caption)',
  fontWeight: 600,
  cursor: enabled ? 'pointer' : 'not-allowed',
  opacity: enabled ? 1 : 0.5,
});

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {allowedCmd.map((cmd) => {
        const id = `${idPrefix}-${cmd}`;
        return (
          <label
            key={cmd}
            htmlFor={id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 4px',
              cursor: 'pointer',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
            }}
          >
            <input
              id={id}
              type="checkbox"
              checked={selected.has(cmd)}
              onChange={() => onToggle(cmd)}
              style={{ width: 16, height: 16, accentColor: 'var(--accent)', flexShrink: 0 }}
            />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 'var(--text-body-sm)', color: '#e5e7eb', display: 'block' }}>{cmdLabel(cmd)}</span>
              <span style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>{cmd}</span>
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
      <span style={{ fontSize: 'var(--text-body-sm)', fontWeight: 600, color: '#e5e7eb' }}>{k.name}</span>
      <code style={{ fontSize: 'var(--text-label)', color: '#6b7280', fontFamily: 'monospace' }}>{k.prefix}…</code>
      {revoked && (
        <span style={{ fontSize: 11, fontWeight: 600, color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 4, padding: '1px 6px' }}>
          {t('aiAgentSettings.revoked')}
        </span>
      )}
    </>
  );
}

/** History-grant chip selector (shared). */
function HistoryScopeChips({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {HISTORY_SCOPES.map((s) => {
        const active = value === s.key;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onChange(s.key)}
            style={{
              padding: '7px 14px',
              borderRadius: 8,
              fontSize: 'var(--text-caption)',
              fontWeight: active ? 600 : 400,
              cursor: 'pointer',
              background: active ? 'var(--accent)' : 'rgba(255,255,255,0.03)',
              color: active ? '#fff' : '#9ca3af',
              border: `1px solid ${active ? 'var(--accent)' : 'rgba(255,255,255,0.12)'}`,
              transition: 'all 0.12s',
            }}
          >
            {s.label}
          </button>
        );
      })}
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
      const keysRes = await fetch('/api/profile/api-keys');
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
      const res = await fetch('/api/profile/api-keys', {
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
      const res = await fetch(`/api/profile/api-keys/${keyId}`, {
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
      const res = await fetch(`/api/profile/api-keys/${id}`, { method: 'DELETE' });
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
    return <div style={{ fontSize: 'var(--text-body-sm)', color: '#6b7280', padding: '8px 0' }}>{t('aiAgentSettings.loadingSettings')}</div>;
  }
  if (loadError) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 'var(--text-body-sm)', color: '#f87171' }}>{loadError}</div>
        <button type="button" onClick={() => void loadAll()} style={{ ...primaryBtn(true), alignSelf: 'flex-start' }}>
          {t('common.retry')}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <p style={{ fontSize: 'var(--text-caption)', color: '#9ca3af', lineHeight: 1.6, margin: 0 }}>
        {t('aiAgentSettings.intro')}
      </p>

      {/* ── API keys — the only unit of AI capability scope ────────────────── */}
      <div>
        <h3 className="os-label" style={sectionTitleStyle}>{t('aiAgentSettings.apiKeys')}</h3>
        <p style={{ fontSize: 'var(--text-label)', color: '#6b7280', margin: '0 0 12px', lineHeight: 1.5 }}>
          {t('aiAgentSettings.keyDescPre')} <span style={{ fontFamily: 'monospace' }}>osk_…</span> {t('aiAgentSettings.keyDescMid')}{' '}
          <span style={{ fontFamily: 'monospace' }}>OPENSTOA_API_KEY</span>{t('aiAgentSettings.keyDescPost')}
        </p>

        {/* Raw key — shown exactly once */}
        {rawKey && (
          <div
            style={{
              ...subCardStyle,
              background: 'rgba(52,211,153,0.06)',
              border: '1px solid rgba(52,211,153,0.3)',
              marginBottom: 16,
            }}
          >
            <p style={{ fontSize: 'var(--text-caption)', fontWeight: 700, color: '#34d399', margin: '0 0 6px' }}>
              {t('aiAgentSettings.copyKeyNow')}
            </p>
            <p style={{ fontSize: 'var(--text-label)', color: '#9ca3af', margin: '0 0 10px', lineHeight: 1.5 }}>
              {t('aiAgentSettings.hashOnlyStored')}
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code
                style={{
                  flex: 1,
                  fontFamily: 'monospace',
                  fontSize: 'var(--text-caption)',
                  color: '#e5e7eb',
                  background: 'rgba(0,0,0,0.4)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 'var(--radius-control)',
                  padding: '10px 12px',
                  wordBreak: 'break-all',
                }}
              >
                {rawKey}
              </code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(rawKey);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                style={{ ...primaryBtn(true), flexShrink: 0 }}
              >
                {copied ? t('aiAgentSettings.copied') : t('aiAgentSettings.copy')}
              </button>
            </div>
            <button
              type="button"
              onClick={() => { setRawKey(null); setCopied(false); }}
              style={{
                marginTop: 10,
                background: 'none',
                border: 'none',
                color: '#6b7280',
                fontSize: 'var(--text-caption)',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {t('aiAgentSettings.dismissSavedKey')}
            </button>
          </div>
        )}

        {/* Create form */}
        <div style={subCardStyle}>
          <p style={{ fontSize: 'var(--text-caption)', fontWeight: 600, color: '#e5e7eb', margin: '0 0 10px' }}>{t('aiAgentSettings.createNewKey')}</p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <input
              type="text"
              value={newName}
              onChange={(e) => { setNewName(e.target.value); setCreateError(null); }}
              placeholder={t('aiAgentSettings.keyNamePlaceholder')}
              maxLength={MAX_API_KEY_NAME_LEN}
              style={{ ...inputStyle, borderColor: nameError ? '#ef4444' : 'rgba(255,255,255,0.12)' }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-label)', marginBottom: 12 }}>
            <span style={{ color: nameError ? '#f87171' : '#6b7280' }}>
              {nameError ?? t('aiAgentSettings.keyNameHint')}
            </span>
            <span style={{ color: '#6b7280' }}>{newName.length}/{MAX_API_KEY_NAME_LEN}</span>
          </div>

          <p style={{ fontSize: 'var(--text-caption)', color: '#9ca3af', margin: '0 0 6px' }}>{t('aiAgentSettings.keyScope')}</p>
          <CapabilityGrid allowedCmd={allowedCmd} selected={newCmd} onToggle={toggleNewCmd} idPrefix="new" />

          <div style={{ marginTop: 14 }}>
            <p style={{ fontSize: 'var(--text-caption)', color: '#9ca3af', margin: '0 0 8px' }}>{t('aiAgentSettings.keyHistoryBackfill')}</p>
            <HistoryScopeChips value={newHistory} onChange={setNewHistory} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
            <button type="button" onClick={createKey} disabled={!canCreate} style={primaryBtn(canCreate)}>
              {creating ? t('aiAgentSettings.creating') : t('aiAgentSettings.createKey')}
            </button>
            {createError && <span style={{ fontSize: 'var(--text-caption)', color: '#f87171' }}>{createError}</span>}
          </div>
        </div>

        {/* Existing keys — each row IS the scope; edit or revoke per key */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
          {keys.length === 0 ? (
            <div style={{ fontSize: 'var(--text-body-sm)', color: '#6b7280', padding: '4px 0' }}>{t('aiAgentSettings.noApiKeys')}</div>
          ) : (
            keys.map((k) => {
              const revoked = !!k.revokedAt;
              const isEditing = editingId === k.id;
              return (
                <div key={k.id} style={{ ...subCardStyle, opacity: revoked ? 0.55 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <ApiKeyMetaSummary k={k} />
                    <span style={{ flex: 1 }} />
                    {!revoked && !isEditing && (
                      <button
                        type="button"
                        onClick={() => startEdit(k)}
                        style={secondaryBtn(true)}
                      >
                        {t('aiAgentSettings.editScope')}
                      </button>
                    )}
                    {!revoked && (
                      confirmingRevoke === k.id ? (
                        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontSize: 'var(--text-label)', color: '#f87171' }}>{t('aiAgentSettings.revokeConfirm')}</span>
                          <button
                            type="button"
                            onClick={() => revokeKey(k.id)}
                            disabled={revokingId === k.id}
                            style={{ background: '#ef4444', color: '#fff', border: 'none', borderRadius: 'var(--radius-control)', padding: '4px 12px', fontSize: 'var(--text-caption)', fontWeight: 600, cursor: 'pointer', opacity: revokingId === k.id ? 0.5 : 1 }}
                          >
                            {revokingId === k.id ? '…' : t('aiAgentSettings.confirm')}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setConfirmingRevoke(null); setRevokeError(null); }}
                            style={{ background: 'rgba(255,255,255,0.06)', color: '#6b7280', border: 'none', borderRadius: 'var(--radius-control)', padding: '4px 10px', fontSize: 'var(--text-caption)', cursor: 'pointer' }}
                          >
                            {t('common.cancel')}
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => { setConfirmingRevoke(k.id); setRevokeError(null); }}
                          style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 'var(--radius-control)', padding: '4px 12px', fontSize: 'var(--text-caption)', fontWeight: 600, cursor: 'pointer' }}
                        >
                          {t('aiAgentSettings.revoke')}
                        </button>
                      )
                    )}
                  </div>

                  {isEditing ? (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                      <p style={{ fontSize: 'var(--text-caption)', color: '#9ca3af', margin: '0 0 6px' }}>{t('aiAgentSettings.keyScope')}</p>
                      <CapabilityGrid allowedCmd={allowedCmd} selected={editCmd} onToggle={toggleEditCmd} idPrefix={`edit-${k.id}`} />
                      <div style={{ marginTop: 14 }}>
                        <p style={{ fontSize: 'var(--text-caption)', color: '#9ca3af', margin: '0 0 8px' }}>{t('aiAgentSettings.keyHistoryBackfill')}</p>
                        <HistoryScopeChips value={editHistory} onChange={setEditHistory} />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
                        <button type="button" onClick={() => saveEdit(k.id)} disabled={savingEdit} style={primaryBtn(!savingEdit)}>
                          {savingEdit ? t('aiAgentSettings.saving') : t('aiAgentSettings.saveScope')}
                        </button>
                        <button type="button" onClick={cancelEdit} disabled={savingEdit} style={secondaryBtn(!savingEdit)}>
                          {t('common.cancel')}
                        </button>
                        {editError && <span style={{ fontSize: 'var(--text-caption)', color: '#f87171' }}>{editError}</span>}
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 'var(--text-label)', color: '#6b7280', marginTop: 8, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
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
          {revokeError && <div style={{ fontSize: 'var(--text-label)', color: '#f87171' }}>{revokeError}</div>}
        </div>
      </div>
    </div>
  );
}
