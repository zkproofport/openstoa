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
  /**
   * Fixed-height card, for surfaces where a change in height is felt: a
   * bottom-anchored chat list scrolls on every content resize, so a preview
   * that grows, shrinks or disappears drags the whole conversation with it.
   *
   * In this mode the slot occupies exactly `COMPACT_HEIGHT` from first paint
   * until last, whatever happens to the fetch: loading, resolved and
   * unavailable are three paints of the SAME box. Nothing moves, so the card
   * simply appears — which is also what "show it cleanly, all at once" means in
   * practice.
   */
  compact?: boolean;
}

/** One row: a square thumbnail and two lines of text. */
const COMPACT_HEIGHT = 72;
const COMPACT_THUMB = 72;

/**
 * URLs whose preview this page has already failed to fetch.
 *
 * Not every site answers a server-side fetch — reddit, for one, refuses ours
 * with a 502 — and without this the same doomed request went out again on every
 * remount of the row, filling the console and the network tab. Once is enough
 * to know; page-lifetime only, so a reload retries.
 */
const failedUrls = new Set<string>();

export default function LinkPreview({ url, compact }: LinkPreviewProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<OGData | null>(null);
  const [loading, setLoading] = useState(() => !failedUrls.has(url));
  const [failed, setFailed] = useState(() => failedUrls.has(url));
  const [imgError, setImgError] = useState(false);
  const [faviconError, setFaviconError] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Already known not to answer — don't ask again, and don't flash a skeleton
    // for a card that will never arrive.
    if (failedUrls.has(url)) {
      setLoading(false);
      setFailed(true);
      return;
    }
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
            failedUrls.add(url);
            setFailed(true);
          } else {
            setData(d);
          }
        }
      })
      .catch(() => {
        failedUrls.add(url);
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [url]);

  if (compact) {
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      host = url;
    }
    const thumb = !imgError && data?.image ? data.image : null;
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'flex',
          alignItems: 'stretch',
          // The whole point: one height, every state.
          height: COMPACT_HEIGHT,
          border: '1px solid var(--color-border-default)',
          borderRadius: 'var(--radius-card)',
          background: 'var(--color-bg-primary)',
          overflow: 'hidden',
          textDecoration: 'none',
          color: 'inherit',
        }}
      >
        {thumb && (
          <img
            src={thumb}
            alt=""
            onError={() => setImgError(true)}
            style={{ width: COMPACT_THUMB, height: '100%', objectFit: 'cover', flexShrink: 0 }}
          />
        )}
        <span
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 2,
            padding: '0 var(--space-3)',
            minWidth: 0,
            flex: 1,
          }}
        >
          <span
            style={{
              fontSize: 'var(--text-caption)',
              fontWeight: 600,
              color: 'var(--foreground)',
              // Two lines maximum, so a long title cannot outgrow the box.
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {/* Loading and unavailable both keep the box and say what they are,
                rather than leaving a labelled hole or removing it outright. */}
            {loading ? '' : (data?.title ?? t('linkPreview.unavailable'))}
          </span>
          <span
            style={{
              fontSize: 'var(--text-label)',
              color: 'var(--color-text-tertiary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {data?.siteName ?? host}
          </span>
        </span>
      </a>
    );
  }

  if (loading) return null;

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
