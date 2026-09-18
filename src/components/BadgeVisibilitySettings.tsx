'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sessionKeys } from '@/lib/queryKeys';
import { recordPublicBadgeMutation, type PublicBadge } from '@/lib/publicBadgeState';
import { readStoredSession, writeStoredSession, type Session } from '@/lib/useSession';
import { apiFetch } from '@/lib/apiFetch';
import { useTranslation } from '@/lib/i18n/I18nProvider';

type VerificationBadge = {
  type: 'kyc' | 'country' | 'oidc_domain' | 'oidc_login';
  visible: boolean;
  domain?: string;
};

const LABEL_KEYS = {
  kyc: 'badge.kyc',
  country: 'badge.country',
  oidc_domain: 'badge.workspace',
  oidc_login: 'badge.oidc',
} as const;

export default function BadgeVisibilitySettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const mounted = useRef(true);
  const syncIdentity = useCallback((result: { userId?: string; publicBadges?: PublicBadge[] }) => {
    if (!mounted.current || !result.userId || !Array.isArray(result.publicBadges)) return false;
    const cached = queryClient.getQueryData<Session | null>(sessionKeys.current());
    const session = cached === undefined ? readStoredSession() : cached;
    // An old owner's delayed response must not install a mutation snapshot
    // after logout/account switch, even while an older session read is pending.
    if (session?.userId !== result.userId) return false;
    recordPublicBadgeMutation(result.userId, result.publicBadges);
    const next = { ...session, badges: result.publicBadges };
    queryClient.setQueryData(sessionKeys.current(), next);
    writeStoredSession(next);
    return true;
  }, [queryClient]);
  const [badges, setBadges] = useState<VerificationBadge[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<'loadFailed' | 'saveFailed' | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch('/api/profile/badges', { signal });
      if (!response.ok) throw new Error('Badge load failed');
      const data = await response.json();
      if (!signal?.aborted && syncIdentity(data)) setBadges(data.badges);
    } catch {
      if (!signal?.aborted) setError('loadFailed');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [syncIdentity]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => { mounted.current = false; controller.abort(); };
  }, [load]);

  async function toggle(badge: VerificationBadge) {
    setSaving(true);
    setError(null);
    try {
      const response = await apiFetch('/api/profile/badges', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: badge.type, visible: !badge.visible }),
      });
      if (!response.ok) throw new Error('Badge save failed');
      const result = await response.json();
      if (!syncIdentity(result)) return;
      setBadges(current => current!.map(b => b.type === result.type ? { ...b, visible: result.visible } : b));
      // The mutation response is authoritative, so the mounted identity updates
      // immediately. Existing query-backed identity payloads refresh as a batch.
      void queryClient.invalidateQueries({ predicate: query =>
        ['post', 'topic', 'feed', 'profile', 'dm', 'topics', 'chat-history'].includes(String(query.queryKey[0])),
      });
    } catch {
      if (mounted.current) setError('saveFailed');
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <p style={{ margin: 0, fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)', lineHeight: 'var(--leading-base)' }}>
        {t('badgeVisibility.help')}
      </p>
      {loading && <p role="status">{t('common.loading')}</p>}
      {error && <div role="alert" style={{ color: 'var(--color-status-danger)' }}>
        {t(`badgeVisibility.${error}`)}
        {error === 'loadFailed' && <button type="button" className="os-chip" onClick={() => void load()}>{t('badgeVisibility.retry')}</button>}
      </div>}
      {!loading && badges?.length === 0 && <p>{t('badgeVisibility.empty')}</p>}
      {badges?.map(badge => {
        const label = badge.domain || t(LABEL_KEYS[badge.type]);
        return <div key={badge.type} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>{label}</span>
          <span style={{ flex: '1 1 auto', fontSize: 'var(--text-caption)', color: 'var(--color-text-tertiary)' }}>
            {t(badge.visible ? 'badgeVisibility.visible' : 'badgeVisibility.hidden')}
          </span>
          <button type="button" role="switch" aria-checked={badge.visible}
            aria-label={t('badgeVisibility.toggleLabel', { badge: label })}
            className="os-chip" disabled={saving} onClick={() => void toggle(badge)}>
            {t(badge.visible ? 'badgeVisibility.on' : 'badgeVisibility.off')}
          </button>
        </div>;
      })}
    </div>
  );
}
