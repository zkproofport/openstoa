'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from '@/lib/i18n/I18nProvider';

interface OGData {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  favicon: string | null;
  url: string;
}

interface LinkPreviewProps {
  url: string;
}

export default function LinkPreview({ url }: LinkPreviewProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<OGData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [faviconError, setFaviconError] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setData(null);
    setImgError(false);
    setFaviconError(false);

    fetch(`/api/og?url=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: OGData) => {
        if (!cancelled) {
          // Must have at least a title to be worth showing
          if (!d.title) {
            setFailed(true);
          } else {
            setData(d);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [url]);

  if (loading) {
    return (
      <div style={{
        marginTop: 10,
        borderRadius: 10,
        border: '1px solid var(--color-border-default)',
        background: 'var(--color-bg-primary)',
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        overflow: 'hidden',
      }}>
        {/* Skeleton */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ height: 12, width: '60%', background: 'var(--color-bg-tertiary)', borderRadius: 4, animation: 'skeletonPulse 1.4s ease-in-out infinite' }} />
          <div style={{ height: 10, width: '85%', background: 'var(--color-bg-secondary)', borderRadius: 4, animation: 'skeletonPulse 1.4s ease-in-out infinite 0.2s' }} />
          <div style={{ height: 10, width: '40%', background: 'var(--color-bg-secondary)', borderRadius: 4, animation: 'skeletonPulse 1.4s ease-in-out infinite 0.4s' }} />
        </div>
        <style>{`
          @keyframes skeletonPulse {
            0%, 100% { opacity: 0.5; }
            50% { opacity: 1; }
          }
        `}</style>
      </div>
    );
  }

  if (failed || !data) return null;

  const hasImage = data.image && !imgError;
  const displayHost = (() => {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return data.siteName ?? url;
    }
  })();

  // OG card uses a div + onClick to open in a new tab instead of a nested
  // <a>. PostCard already wraps the body in <Link>, and nesting anchors is
  // invalid HTML — browsers collapse the inner <a> so the card click was
  // navigating to the post detail instead of the external URL.
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick(e as unknown as React.MouseEvent);
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={t('linkPreview.openInNewTab', { url })}
      style={{
        display: 'block',
        marginTop: 10,
        borderRadius: 10,
        border: `1px solid ${hovered ? 'var(--color-bg-tertiary)' : 'var(--color-bg-tertiary)'}`,
        background: hovered ? 'var(--color-bg-secondary)' : 'var(--color-bg-primary)',
        overflow: 'hidden',
        textDecoration: 'none',
        color: 'inherit',
        cursor: 'pointer',
        transition: 'border-color 0.15s, background 0.15s',
      }}
    >
      {/* Banner image */}
      {hasImage && (
        <div style={{
          width: '100%',
          height: 160,
          overflow: 'hidden',
          background: 'var(--color-bg-primary)',
          position: 'relative',
        }}>
          <img
            src={data.image!}
            alt=""
            onError={() => setImgError(true)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        </div>
      )}

      {/* Meta content */}
      <div style={{ padding: '10px 14px 12px' }}>
        {/* Site name + favicon row */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          marginBottom: 4,
        }}>
          {data.favicon && !faviconError && (
            <img
              src={data.favicon}
              alt=""
              width={14}
              height={14}
              onError={() => setFaviconError(true)}
              style={{ borderRadius: 2, flexShrink: 0 }}
            />
          )}
          <span style={{
            fontSize: 11,
            color: 'var(--color-text-tertiary)',
            fontFamily: 'var(--font-mono)',
            textTransform: 'lowercase',
            letterSpacing: '0.01em',
          }}>
            {displayHost}
          </span>
        </div>

        {/* Title */}
        <div style={{
          fontSize: 'var(--text-caption)',
          fontWeight: 600,
          color: 'var(--color-text-primary)',
          lineHeight: 1.4,
          marginBottom: data.description ? 3 : 0,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical' as const,
          overflow: 'hidden',
        }}>
          {data.title}
        </div>

        {/* Description */}
        {data.description && (
          <div style={{
            fontSize: 'var(--text-label)',
            color: 'var(--color-text-tertiary)',
            lineHeight: 1.5,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical' as const,
            overflow: 'hidden',
          }}>
            {data.description}
          </div>
        )}
      </div>
    </div>
  );
}
