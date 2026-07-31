'use client';

import { useEffect, useState } from 'react';
import { RecordIcon } from '@/components/icons';
import { useTranslation } from '@/lib/i18n/I18nProvider';

interface RecordRow {
  id: string;
  recorderNickname: string | null;
  recorderProfileImage: string | null;
  txHash: string | null;
  txExplorerUrl: string | null;
  contentHash: string;
  contentHashMatch: boolean;
  createdAt: string;
}

interface RecordsResponse {
  records: RecordRow[];
  recordCount: number;
  postEdited: boolean;
}

interface Props {
  postId: string;
  /** Initial known record count from the post payload — used to gate
   *  the fetch (no point hitting the endpoint if there are zero). */
  recordCount: number;
}

/**
 * Collapsible list of on-chain record receipts for a post. Mirrors the
 * mobile PostDetailScreen.recordsSection — same data, same BaseScan
 * link affordance, same collapsed-by-default behaviour so it never
 * pushes the comments section off the page.
 */
export function PostRecordsSection({ postId, recordCount }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<RecordsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Fetch lazily on the first expand so collapsed pages stay cheap.
    if (!expanded || data || recordCount === 0) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/posts/${postId}/records`);
        if (!res.ok) return;
        const json = (await res.json()) as RecordsResponse;
        if (!cancelled) setData(json);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [expanded, data, postId, recordCount]);

  if (recordCount === 0) return null;

  return (
    <section style={{ padding: 'var(--space-3) var(--space-4)', borderTop: '1px solid var(--border)' }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '6px 0',
          background: 'transparent',
          border: 'none',
          color: 'var(--muted)',
          fontSize: 'var(--text-caption)',
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          cursor: 'pointer',
        }}
      >
        <RecordIcon size={14} />
        <span style={{ flex: 1, textAlign: 'left' }}>
          {t('postRecords.heading', { count: recordCount })}
        </span>
        <span aria-hidden style={{ fontSize: 'var(--text-body-sm)' }}>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div style={{ marginTop: 6 }}>
          {loading && !data && (
            <div style={{ fontSize: 'var(--text-label)', color: 'var(--muted)', padding: 'var(--space-2) 0' }}>
              {t('postRecords.loading')}
            </div>
          )}
          {data?.postEdited && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--color-status-warning)',
                marginBottom: 6,
              }}
            >
              {t('postRecords.editedWarning')}
            </div>
          )}
          {data?.records.map((r) => (
            <div
              key={r.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: 'var(--space-2) 0',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 'var(--text-caption)',
                    fontWeight: 600,
                    color: 'var(--foreground)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {r.recorderNickname ?? t('postRecords.anonNickname')}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                  {new Date(r.createdAt).toLocaleString()}
                  {!r.contentHashMatch && t('postRecords.editedSince')}
                </div>
              </div>
              {r.txExplorerUrl ? (
                <a
                  href={r.txExplorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--accent)',
                    textDecoration: 'none',
                    padding: 'var(--space-1) var(--space-2)',
                    borderRadius: 'var(--radius-control)',
                    background: 'var(--color-brand-primary-muted)',
                  }}
                >
                  {t('postRecords.viewOnBaseScan')}
                </a>
              ) : (
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('postRecords.pending')}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
