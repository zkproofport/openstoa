'use client';

import { useState, useEffect } from 'react';

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
        border: '1px solid rgba(255,255,255,0.06)',
        background: '#0d0d0d',
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        overflow: 'hidden',
      }}>
        {/* Skeleton */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ height: 12, width: '60%', background: 'rgba(255,255,255,0.06)', borderRadius: 4, animation: 'skeletonPulse 1.4s ease-in-out infinite' }} />
          <div style={{ height: 10, width: '85%', background: 'rgba(255,255,255,0.04)', borderRadius: 4, animation: 'skeletonPulse 1.4s ease-in-out infinite 0.2s' }} />
          <div style={{ height: 10, width: '40%', background: 'rgba(255,255,255,0.04)', borderRadius: 4, animation: 'skeletonPulse 1.4s ease-in-out infinite 0.4s' }} />
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

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'block',
        marginTop: 10,
        borderRadius: 10,
        border: `1px solid ${hovered ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)'}`,
        background: hovered ? '#111' : '#0d0d0d',
        overflow: 'hidden',
        textDecoration: 'none',
        color: 'inherit',
        transition: 'border-color 0.15s, background 0.15s',
      }}
    >
      {/* Banner image */}
      {hasImage && (
        <div style={{
          width: '100%',
          height: 160,
          overflow: 'hidden',
          background: '#0a0a0a',
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
            color: '#6b7280',
            fontFamily: 'monospace',
            textTransform: 'lowercase',
            letterSpacing: '0.01em',
          }}>
            {displayHost}
          </span>
        </div>

        {/* Title */}
        <div style={{
          fontSize: 13,
          fontWeight: 600,
          color: '#e5e7eb',
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
            fontSize: 12,
            color: '#6b7280',
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
    </a>
  );
}
