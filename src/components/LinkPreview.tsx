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
  /**
   * Called when there will be no card for this URL.
   *
   * The card REPLACES the link text — showing both is the noise every messenger
   * avoids — so the row has to be told when the card is not coming, or a failed
   * preview leaves the message with nothing at all.
   */
  onUnavailable?: () => void;
}

/*
 * Card geometry, fixed for every state.
 *
 * The image block is 1.91:1 — the aspect `og:image` is authored for — and it is
 * present whether or not an image came back, so loading, with-image and
 * without-image are the same footprint and the list never moves under the
 * reader. The body underneath is three fixed rows: title, description, domain.
 */
const CARD_IMAGE_ASPECT = '1.91 / 1';

/**
 * URLs whose preview this page has already failed to fetch.
 *
 * Not every site answers a server-side fetch — reddit, for one, refuses ours
 * with a 502 — and without this the same doomed request went out again on every
 * remount of the row, filling the console and the network tab. Once is enough
 * to know; page-lifetime only, so a reload retries.
 */
const failedUrls = new Set<string>();

export default function LinkPreview({ url, compact, onUnavailable }: LinkPreviewProps) {
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

  // Tell the row there will be no card, so it can put the link text back. A
  // message must never end up with neither.
  useEffect(() => {
    if (failed) onUnavailable?.();
  }, [failed, onUnavailable]);

  if (compact && failed) return null;
  if (compact) {
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      host = url;
    }
    const image = !imgError && data?.image ? data.image : null;
    const skeleton = 'color-mix(in srgb, var(--foreground) 10%, transparent)';
    // No image block while loading: most links have no `og:image`, so
    // reserving one would make the common card SHRINK when it resolves — and a
    // card that shrinks pulls the whole conversation up with it.
    /** One grey bar, for the loading state — same rows the real text occupies. */
    const bar = (width: string) => (
      <span style={{ display: 'block', height: 11, width, borderRadius: 3, background: skeleton }} />
    );
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'block',
          borderRadius: 'var(--radius-card)',
          background: 'var(--color-bg-tertiary)',
          overflow: 'hidden',
          textDecoration: 'none',
          color: 'inherit',
        }}
      >
        {/*
          * The image block exists only when there IS an image.
          *
          * Reserving it either way left a large empty rectangle on every card
          * for a page with no `og:image`, which reads as a picture that failed
          * to load. KakaoTalk drops it: a link with no image is a compact card
          * of title, description and domain, and that is what a reader expects.
          */}
        {image && (
          <span
            style={{
              display: 'block',
              width: '100%',
              aspectRatio: CARD_IMAGE_ASPECT,
              background: skeleton,
              backgroundImage: `url("${image}")`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}
          />
        )}
        {/* Hidden loader: `background-image` has no error event, so this is what
            notices a dead image URL and falls back to the plain block. */}
        {image && (
          <img src={image} alt="" onError={() => setImgError(true)} style={{ display: 'none' }} />
        )}
        <span
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: 'var(--space-3)',
            minWidth: 0,
          }}
        >
          {loading ? (
            <>
              {bar('70%')}
              {bar('90%')}
              {bar('35%')}
            </>
          ) : (
            <>
              <span
                style={{
                  fontSize: 'var(--text-body-sm)',
                  fontWeight: 700,
                  color: 'var(--foreground)',
                  display: '-webkit-box',
                  WebkitLineClamp: 1,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {data?.title ?? host}
              </span>
              <span
                style={{
                  fontSize: 'var(--text-caption)',
                  color: 'var(--color-text-secondary)',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  // Two lines are reserved whether or not there is a
                  // description, so a site that omits one does not make a
                  // shorter card than a site that has one.
                  minHeight: 34,
                }}
              >
                {data?.description ?? ''}
              </span>
              <span
                style={{
                  fontSize: 'var(--text-label)',
                  color: 'var(--accent)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {host}
              </span>
            </>
          )}
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
