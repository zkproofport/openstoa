'use client';

import { useEffect, useRef, useState } from 'react';

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ChevronLeft() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

interface ImageLightboxProps {
  /** Single image — kept for backwards compatibility. */
  src?: string;
  /** Multi-image lightbox: full URL list + which one to open first. */
  images?: string[];
  initialIndex?: number;
  onClose: () => void;
}

// Multi-image swipeable lightbox. Matches the mobile MediaGallery UX:
// arrow keys / on-screen arrows / touch swipe move between images, the
// dot indicator shows position, Escape closes. Falls back to single
// image mode when `src` is passed.
export default function ImageLightbox({ src, images, initialIndex = 0, onClose }: ImageLightboxProps) {
  const list = images && images.length > 0 ? images : src ? [src] : [];
  const [index, setIndex] = useState(() =>
    Math.max(0, Math.min(initialIndex, list.length - 1)),
  );
  const touchStartX = useRef<number | null>(null);

  // Reset index when the underlying list changes (e.g. a new lightbox is
  // opened with a different post's gallery).
  useEffect(() => {
    setIndex(Math.max(0, Math.min(initialIndex, list.length - 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialIndex, list.length]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
      else if (e.key === 'ArrowRight') setIndex((i) => Math.min(list.length - 1, i + 1));
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, list.length]);

  if (list.length === 0) return null;

  const hasMany = list.length > 1;
  const current = list[index];

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchStartX.current) - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 40) return;
    if (dx < 0) setIndex((i) => Math.min(list.length - 1, i + 1));
    else setIndex((i) => Math.max(0, i - 1));
  };

  const arrowBtnStyle: React.CSSProperties = {
    position: 'absolute',
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'rgba(255,255,255,0.1)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '50%',
    width: 40,
    height: 40,
    color: '#fff',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1001,
  };

  return (
    <div
      onClick={onClose}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.9)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 8,
          color: '#fff',
          cursor: 'pointer',
          padding: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 0,
          zIndex: 1001,
        }}
      >
        <CloseIcon />
      </button>

      {hasMany && index > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIndex((i) => Math.max(0, i - 1));
          }}
          aria-label="Previous image"
          style={{ ...arrowBtnStyle, left: 16 }}
        >
          <ChevronLeft />
        </button>
      )}

      {hasMany && index < list.length - 1 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIndex((i) => Math.min(list.length - 1, i + 1));
          }}
          aria-label="Next image"
          style={{ ...arrowBtnStyle, right: 16 }}
        >
          <ChevronRight />
        </button>
      )}

      <img
        src={current}
        alt=""
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '92vw',
          maxHeight: '88vh',
          objectFit: 'contain',
          borderRadius: 8,
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
          userSelect: 'none',
        }}
        draggable={false}
      />

      {hasMany && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'rgba(0,0,0,0.4)',
            padding: '6px 12px',
            borderRadius: 9999,
          }}
        >
          {list.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Image ${i + 1}`}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                border: 'none',
                background: i === index ? '#fff' : 'rgba(255,255,255,0.35)',
                cursor: 'pointer',
                padding: 0,
                transition: 'background 0.12s',
              }}
            />
          ))}
          <span
            style={{
              color: 'rgba(255,255,255,0.7)',
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              marginLeft: 6,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {index + 1} / {list.length}
          </span>
        </div>
      )}
    </div>
  );
}
