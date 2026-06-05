'use client';

import { useRef, useState } from 'react';
import ImageLightbox from '@/components/ImageLightbox';

interface MediaGalleryProps {
  images?: string[];
  /** Embedded video URLs (YouTube / Vimeo). First one renders inline,
   *  the rest contribute to the +N badge. */
  videos?: string[];
  /** `feed` = first image only with a +N badge (compact list row).
   *  `detail` = swipeable carousel + dots + pinch-style preview. */
  mode?: 'feed' | 'detail';
}

function detectVideoEmbed(url: string): { type: 'youtube' | 'vimeo'; id: string; thumbnail: string } | null {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (yt) return { type: 'youtube', id: yt[1], thumbnail: `https://img.youtube.com/vi/${yt[1]}/mqdefault.jpg` };
  const vm = url.match(/vimeo\.com\/(\d+)/);
  if (vm) return { type: 'vimeo', id: vm[1], thumbnail: '' };
  return null;
}

// Shared media block for web posts. Mirrors the mobile MediaGallery
// so list rows and the detail page share the same affordance:
//   feed    → first image full-width, +N badge if there's more, tap
//             opens the lightbox at index 0
//   detail  → horizontal swipeable carousel, dots, click-to-zoom into
//             the lightbox at the matching index
export default function MediaGallery({ images, videos, mode = 'feed' }: MediaGalleryProps) {
  const imgs = images ?? [];
  const vids = videos ?? [];
  const total = imgs.length + vids.length;
  const [index, setIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const touchStartX = useRef<number | null>(null);

  if (total === 0) return null;

  const openLightboxAt = (i: number) => {
    setLightboxIndex(i);
    setLightboxOpen(true);
  };

  // ─── Feed mode: compact preview ─────────────────────────────────────────
  if (mode === 'feed') {
    // Prefer the first image; fall back to the first video thumbnail if
    // the post only has videos attached.
    const firstImg = imgs[0];
    const firstVid = vids[0] ? detectVideoEmbed(vids[0]) : null;
    const remaining = total - 1;

    if (!firstImg && !firstVid) return null;

    return (
      <>
        <div
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // Open the lightbox only when there's at least one image — the
            // video card surfaces inside the detail page.
            if (imgs.length > 0) openLightboxAt(0);
          }}
          style={{
            position: 'relative',
            marginTop: 8,
            borderRadius: 10,
            overflow: 'hidden',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            aspectRatio: '16 / 9',
            cursor: imgs.length > 0 ? 'zoom-in' : 'default',
          }}
        >
          {firstImg ? (
            <img
              src={firstImg}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : firstVid?.thumbnail ? (
            <img
              src={firstVid.thumbnail}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : (
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#6b7280',
                fontSize: 13,
              }}
            >
              Video
            </div>
          )}

          {firstVid && (
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: 48,
                height: 48,
                background: 'rgba(0,0,0,0.65)',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span style={{ color: '#fff', fontSize: 18, marginLeft: 3 }}>▶</span>
            </div>
          )}

          {remaining > 0 && (
            <div
              style={{
                position: 'absolute',
                bottom: 8,
                right: 8,
                background: 'rgba(0,0,0,0.65)',
                color: '#fff',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                padding: '3px 8px',
                borderRadius: 9999,
              }}
            >
              +{remaining}
            </div>
          )}
        </div>

        {lightboxOpen && imgs.length > 0 && (
          <ImageLightbox
            images={imgs}
            initialIndex={lightboxIndex}
            onClose={() => setLightboxOpen(false)}
          />
        )}
      </>
    );
  }

  // ─── Detail mode: swipeable carousel ────────────────────────────────────
  const slides: Array<
    | { kind: 'image'; src: string }
    | { kind: 'video'; embed: ReturnType<typeof detectVideoEmbed>; raw: string }
  > = [
    ...imgs.map((src) => ({ kind: 'image' as const, src })),
    ...vids.map((raw) => ({ kind: 'video' as const, embed: detectVideoEmbed(raw), raw })),
  ];

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchStartX.current) - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 40) return;
    if (dx < 0) setIndex((i) => Math.min(slides.length - 1, i + 1));
    else setIndex((i) => Math.max(0, i - 1));
  };

  const current = slides[index];
  const hasMany = slides.length > 1;

  return (
    <>
      <div style={{ marginTop: 12 }}>
        <div
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          style={{
            position: 'relative',
            borderRadius: 10,
            overflow: 'hidden',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            aspectRatio: '16 / 10',
          }}
        >
          {current.kind === 'image' ? (
            <img
              src={current.src}
              alt=""
              onClick={() => {
                const imageIdx = imgs.indexOf(current.src);
                if (imageIdx >= 0) openLightboxAt(imageIdx);
              }}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                display: 'block',
                cursor: 'zoom-in',
                background: '#000',
              }}
            />
          ) : current.embed?.type === 'youtube' ? (
            <iframe
              src={`https://www.youtube.com/embed/${current.embed.id}`}
              title="YouTube video"
              allowFullScreen
              style={{ width: '100%', height: '100%', border: 'none' }}
            />
          ) : current.embed?.type === 'vimeo' ? (
            <iframe
              src={`https://player.vimeo.com/video/${current.embed.id}`}
              title="Vimeo video"
              allowFullScreen
              style={{ width: '100%', height: '100%', border: 'none' }}
            />
          ) : (
            <a
              href={current.raw}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent)', fontSize: 13, padding: 16, display: 'block' }}
            >
              {current.raw}
            </a>
          )}

          {hasMany && index > 0 && (
            <button
              type="button"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              aria-label="Previous"
              style={arrowStyle('left')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}
          {hasMany && index < slides.length - 1 && (
            <button
              type="button"
              onClick={() => setIndex((i) => Math.min(slides.length - 1, i + 1))}
              aria-label="Next"
              style={arrowStyle('right')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          )}

          {hasMany && (
            <div
              style={{
                position: 'absolute',
                bottom: 10,
                left: '50%',
                transform: 'translateX(-50%)',
                display: 'flex',
                gap: 5,
                background: 'rgba(0,0,0,0.45)',
                padding: '4px 10px',
                borderRadius: 9999,
              }}
            >
              {slides.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setIndex(i)}
                  aria-label={`Slide ${i + 1}`}
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    border: 'none',
                    background: i === index ? '#fff' : 'rgba(255,255,255,0.4)',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {lightboxOpen && imgs.length > 0 && (
        <ImageLightbox
          images={imgs}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </>
  );
}

function arrowStyle(side: 'left' | 'right'): React.CSSProperties {
  return {
    position: 'absolute',
    top: '50%',
    [side]: 8,
    transform: 'translateY(-50%)',
    width: 32,
    height: 32,
    borderRadius: '50%',
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(0,0,0,0.5)',
    color: '#fff',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
}
