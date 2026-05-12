'use client';

import { useEffect, useState } from 'react';
import { RecordIcon } from '@/components/icons';

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
    <section style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
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
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          cursor: 'pointer',
        }}
      >
        <RecordIcon size={14} />
        <span style={{ flex: 1, textAlign: 'left' }}>
          Recorded on Base · {recordCount}
        </span>
        <span aria-hidden style={{ fontSize: 14 }}>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div style={{ marginTop: 6 }}>
          {loading && !data && (
            <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 0' }}>
              Loading on-chain records…
            </div>
          )}
          {data?.postEdited && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--warning, #d97706)',
                marginBottom: 6,
              }}
            >
              Post content has changed since these records were written; older
              hashes no longer match.
            </div>
          )}
          {data?.records.map((r) => (
            <div
              key={r.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 0',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--foreground)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {r.recorderNickname ?? 'anon'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                  {new Date(r.createdAt).toLocaleString()}
                  {!r.contentHashMatch && ' · content edited since'}
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
                    padding: '4px 8px',
                    borderRadius: 6,
                    background: 'rgba(120,140,255,0.1)',
                  }}
                >
                  View on BaseScan ↗
                </a>
              ) : (
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>pending…</span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
