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

// Shapes returned by the (unchanged) profile routes.
interface AiPermissions {
  cmd: string[];
  historyGrant: string;
  allowedCmd: string[];
}
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

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  margin: '0 0 12px',
};
const subCardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 10,
  padding: 16,
};
const inputStyle: React.CSSProperties = {
  flex: 1,
  background: 'var(--surface, #0c0e18)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  padding: '9px 12px',
  color: '#e5e7eb',
  fontSize: 14,
  outline: 'none',
};
const primaryBtn = (enabled: boolean): React.CSSProperties => ({
  background: 'var(--accent)',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  padding: '9px 20px',
  fontSize: 14,
  fontWeight: 600,
  cursor: enabled ? 'pointer' : 'not-allowed',
  opacity: enabled ? 1 : 0.5,
  transition: 'opacity 0.12s',
});

function scopeLabel(scope: string): string {
  return HISTORY_SCOPES.find((s) => s.key === scope)?.label ?? scope;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

/** Reusable checkbox grid for capability selection (shared by perms + key create). */
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
              <span style={{ fontSize: 14, color: '#e5e7eb', display: 'block' }}>{cmdLabel(cmd)}</span>
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
  const revoked = !!k.revokedAt;
  return (
    <>
      <span style={{ fontSize: 14, fontWeight: 600, color: '#e5e7eb' }}>{k.name}</span>
      <code style={{ fontSize: 12, color: '#6b7280', fontFamily: 'monospace' }}>{k.prefix}…</code>
      {revoked && (
        <span style={{ fontSize: 11, fontWeight: 600, color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 4, padding: '1px 6px' }}>
          Revoked
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
              fontSize: 13,
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [allowedCmd, setAllowedCmd] = useState<string[]>([]);

  // AI permissions (profile-level, mirrors the mobile screen).
  const [permsCmd, setPermsCmd] = useState<Set<string>>(new Set());
  const [permsHistory, setPermsHistory] = useState('none');
  const [permsSaving, setPermsSaving] = useState(false);
  const [permsFeedback, setPermsFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  // API keys.
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

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [permRes, keysRes] = await Promise.all([
        fetch('/api/profile/ai-permissions'),
        fetch('/api/profile/api-keys'),
      ]);
      if (permRes.status === 401 || keysRes.status === 401) {
        throw new Error('Please sign in to manage AI agents.');
      }
      if (!permRes.ok) throw new Error('Failed to load AI permissions.');
      if (!keysRes.ok) throw new Error('Failed to load API keys.');
      const perm = (await permRes.json()) as AiPermissions;
      const keyList = (await keysRes.json()) as { apiKeys: ApiKeyMeta[]; allowedCmd?: string[] };
      setAllowedCmd(perm.allowedCmd ?? keyList.allowedCmd ?? []);
      setPermsCmd(new Set(perm.cmd ?? []));
      setPermsHistory(perm.historyGrant || 'none');
      setKeys(keyList.apiKeys ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const togglePermsCmd = useCallback((cmd: string) => {
    setPermsCmd((prev) => {
      const next = new Set(prev);
      if (next.has(cmd)) next.delete(cmd);
      else next.add(cmd);
      return next;
    });
    setPermsFeedback(null);
  }, []);

  const toggleNewCmd = useCallback((cmd: string) => {
    setNewCmd((prev) => {
      const next = new Set(prev);
      if (next.has(cmd)) next.delete(cmd);
      else next.add(cmd);
      return next;
    });
  }, []);

  async function savePerms() {
    setPermsSaving(true);
    setPermsFeedback(null);
    try {
      const res = await fetch('/api/profile/ai-permissions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: orderedCmd(allowedCmd, permsCmd), historyGrant: permsHistory }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to save AI permissions.');
      }
      setPermsFeedback({ ok: true, msg: 'AI permissions updated.' });
    } catch (e) {
      setPermsFeedback({ ok: false, msg: e instanceof Error ? e.message : 'Network error.' });
    } finally {
      setPermsSaving(false);
    }
  }

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
        throw new Error(d.error ?? 'Failed to create API key.');
      }
      const data = (await res.json()) as { rawKey: string; key: ApiKeyMeta };
      // Show the raw key exactly once; the list only ever carries metadata.
      setRawKey(data.rawKey);
      setKeys((prev) => [data.key, ...prev]);
      setNewName('');
      setNewCmd(new Set());
      setNewHistory('none');
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setCreating(false);
    }
  }

  async function revokeKey(id: string) {
    setRevokingId(id);
    setRevokeError(null);
    try {
      const res = await fetch(`/api/profile/api-keys/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to revoke key.');
      }
      // Reflect revocation locally (metadata only).
      setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, revokedAt: new Date().toISOString() } : k)));
      setConfirmingRevoke(null);
    } catch (e) {
      setRevokeError(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setRevokingId(null);
    }
  }

  if (loading) {
    return <div style={{ fontSize: 14, color: '#6b7280', padding: '8px 0' }}>Loading AI agent settings…</div>;
  }
  if (loadError) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 14, color: '#f87171' }}>{loadError}</div>
        <button type="button" onClick={() => void loadAll()} style={{ ...primaryBtn(true), alignSelf: 'flex-start' }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <p style={{ fontSize: 13, color: '#9ca3af', lineHeight: 1.6, margin: 0 }}>
        An AI agent logged in as you acts on your account. Choose exactly what your AI sessions may do across OpenStoa,
        and mint scoped API keys for agents / MCP. Your own actions are never restricted.
      </p>

      {/* ── AI permission scope (profile-wide) ─────────────────────────────── */}
      <div>
        <h3 style={sectionTitleStyle}>AI permission scope</h3>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px', lineHeight: 1.5 }}>
          Applies to every AI session on your account (used when a key does not carry its own scope).
        </p>
        <div style={subCardStyle}>
          <CapabilityGrid allowedCmd={allowedCmd} selected={permsCmd} onToggle={togglePermsCmd} idPrefix="perm" />
          <div style={{ marginTop: 16 }}>
            <p style={{ fontSize: 13, color: '#9ca3af', margin: '0 0 8px' }}>Chat history the AI may back-fill</p>
            <HistoryScopeChips value={permsHistory} onChange={(v) => { setPermsHistory(v); setPermsFeedback(null); }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
            <button type="button" onClick={savePerms} disabled={permsSaving} style={primaryBtn(!permsSaving)}>
              {permsSaving ? 'Saving…' : 'Save permissions'}
            </button>
            {permsFeedback && (
              <span style={{ fontSize: 13, color: permsFeedback.ok ? '#4ade80' : '#f87171' }}>{permsFeedback.msg}</span>
            )}
          </div>
        </div>
      </div>

      {/* ── Create API key ─────────────────────────────────────────────────── */}
      <div>
        <h3 style={sectionTitleStyle}>API keys</h3>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px', lineHeight: 1.5 }}>
          A key is a durable, revocable <span style={{ fontFamily: 'monospace' }}>osk_…</span> credential an agent sends
          as <span style={{ fontFamily: 'monospace' }}>OPENSTOA_API_KEY</span>. Each key carries its own scope.
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
            <p style={{ fontSize: 13, fontWeight: 700, color: '#34d399', margin: '0 0 6px' }}>
              Copy your key now — it will not be shown again
            </p>
            <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 10px', lineHeight: 1.5 }}>
              Only a hash is stored server-side. If you lose it, revoke and create a new one.
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code
                style={{
                  flex: 1,
                  fontFamily: 'monospace',
                  fontSize: 13,
                  color: '#e5e7eb',
                  background: 'rgba(0,0,0,0.4)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 6,
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
                {copied ? 'Copied!' : 'Copy'}
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
                fontSize: 13,
                cursor: 'pointer',
                padding: 0,
              }}
            >
              I&apos;ve saved it — dismiss
            </button>
          </div>
        )}

        {/* Create form */}
        <div style={subCardStyle}>
          <p style={{ fontSize: 13, fontWeight: 600, color: '#e5e7eb', margin: '0 0 10px' }}>Create a new key</p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <input
              type="text"
              value={newName}
              onChange={(e) => { setNewName(e.target.value); setCreateError(null); }}
              placeholder="Key name (e.g. laptop CLI)"
              maxLength={MAX_API_KEY_NAME_LEN}
              style={{ ...inputStyle, borderColor: nameError ? '#ef4444' : 'rgba(255,255,255,0.12)' }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 12 }}>
            <span style={{ color: nameError ? '#f87171' : '#6b7280' }}>
              {nameError ?? 'Letters, emoji, any script — sent verbatim.'}
            </span>
            <span style={{ color: '#6b7280' }}>{newName.length}/{MAX_API_KEY_NAME_LEN}</span>
          </div>

          <p style={{ fontSize: 13, color: '#9ca3af', margin: '0 0 6px' }}>Key scope (capabilities)</p>
          <CapabilityGrid allowedCmd={allowedCmd} selected={newCmd} onToggle={toggleNewCmd} idPrefix="new" />

          <div style={{ marginTop: 14 }}>
            <p style={{ fontSize: 13, color: '#9ca3af', margin: '0 0 8px' }}>Chat history this key may back-fill</p>
            <HistoryScopeChips value={newHistory} onChange={setNewHistory} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
            <button type="button" onClick={createKey} disabled={!canCreate} style={primaryBtn(canCreate)}>
              {creating ? 'Creating…' : 'Create key'}
            </button>
            {createError && <span style={{ fontSize: 13, color: '#f87171' }}>{createError}</span>}
          </div>
        </div>

        {/* Existing keys — metadata only */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
          {keys.length === 0 ? (
            <div style={{ fontSize: 14, color: '#6b7280', padding: '4px 0' }}>No API keys yet.</div>
          ) : (
            keys.map((k) => {
              const revoked = !!k.revokedAt;
              return (
                <div key={k.id} style={{ ...subCardStyle, opacity: revoked ? 0.55 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <ApiKeyMetaSummary k={k} />
                    <span style={{ flex: 1 }} />
                    {!revoked && (
                      confirmingRevoke === k.id ? (
                        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontSize: 12, color: '#f87171' }}>Revoke?</span>
                          <button
                            type="button"
                            onClick={() => revokeKey(k.id)}
                            disabled={revokingId === k.id}
                            style={{ background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: revokingId === k.id ? 0.5 : 1 }}
                          >
                            {revokingId === k.id ? '…' : 'Confirm'}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setConfirmingRevoke(null); setRevokeError(null); }}
                            style={{ background: 'rgba(255,255,255,0.06)', color: '#6b7280', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 13, cursor: 'pointer' }}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => { setConfirmingRevoke(k.id); setRevokeError(null); }}
                          style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 6, padding: '4px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                        >
                          Revoke
                        </button>
                      )
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <span>Scope: {k.cmd.length === 0 ? 'none' : k.cmd.map(cmdLabel).join(', ')}</span>
                    <span>History: {scopeLabel(k.historyGrant)}</span>
                    <span>Created: {fmtDate(k.createdAt)}</span>
                    <span>Last used: {fmtDate(k.lastUsedAt)}</span>
                  </div>
                </div>
              );
            })
          )}
          {revokeError && <div style={{ fontSize: 12, color: '#f87171' }}>{revokeError}</div>}
        </div>
      </div>
    </div>
  );
}
