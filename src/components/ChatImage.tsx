'use client';

import React, { useEffect, useState } from 'react';
import { chatMediaBox, type ChatMediaBox } from '@/lib/chatMediaLayout';

/**
 * A picture in a chat bubble, sized by the shared rule in `chatMediaLayout`.
 *
 * This exists as its own component for two reasons. The rule has to be applied
 * identically at both of `ChatPanel`'s picture sites — the encrypted attachment
 * and the legacy plaintext URL — and applying it in two places is how they
 * drift. And the mini-app has a twin of this file, so "the web and the mini-app
 * reach the same visual decision" is a property of one shared function called
 * from two thin renderers, rather than of two implementations that agree today.
 *
 * The box is a hard `width` x `height` with `object-fit: cover`. Not
 * `max-height`: capping height while width follows the intrinsic ratio is
 * precisely the bug being fixed, because it makes a tall picture NARROW, and
 * the taller the source the narrower the result.
 */

/** Picture width in a normal chat column. Signal's `media_bubble_max_width` is the same 240. */
export const CHAT_IMAGE_SLOT_WIDTH = 240;
/** …and in the maximized desktop panel, where there is room for more. */
export const CHAT_IMAGE_SLOT_WIDTH_ROOMY = 300;

export interface ChatImageNaturalSize {
  width: number;
  height: number;
}

/**
 * Read a picture's intrinsic size without putting it in the layout.
 *
 * Never rejects, and the render is never GATED on it. A picture that cannot be
 * decoded — or a host that fires neither `load` nor `error` — resolves to
 * `null`, and the shared rule turns that into the reserved square. An earlier
 * version awaited this before publishing the object URL, which read as
 * strictly better (one layout instead of two) and was strictly worse: in any
 * environment where neither event fires, the picture never appeared at all.
 */
export function probeImageSize(src: string): Promise<ChatImageNaturalSize | null> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof window.Image !== 'function') {
      resolve(null);
      return;
    }
    const probe = new window.Image();
    probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => resolve(null);
    probe.src = src;
  });
}

export interface ChatImageProps {
  src: string | null | undefined;
  alt: string;
  /** Available width. Use the exported constants unless there is a reason not to. */
  slotWidth: number;
  /** Shown only when the rule actually cropped. Owned by the caller, which owns i18n. */
  croppedLabel: string;
  'data-testid'?: string;
}

export function ChatImage({
  src,
  alt,
  slotWidth,
  croppedLabel,
  'data-testid': testId,
}: ChatImageProps) {
  const [size, setSize] = useState<ChatImageNaturalSize | null>(null);

  useEffect(() => {
    setSize(null);
    if (!src) return;
    let cancelled = false;
    void probeImageSize(src).then((measured) => {
      if (!cancelled) setSize(measured);
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  const box: ChatMediaBox = chatMediaBox(size?.width, size?.height, slotWidth);

  return (
    <span
      data-testid={testId}
      data-chat-image-cropped={box.cropped ? 'true' : 'false'}
      data-chat-image-anchor={box.anchor}
      style={{
        position: 'relative',
        display: 'block',
        // The box, stated. `overflow: hidden` is what performs the crop for the
        // badge and the fade; `object-fit` performs it for the picture itself.
        width: box.width,
        height: box.height,
        // The bubble caps its own children at 85% of the column, which on a
        // very narrow panel is less than the slot. Shrinking is the right
        // answer there; `cover` absorbs it by cropping slightly more, where
        // overflowing would put the picture outside the bubble.
        maxWidth: '100%',
        overflow: 'hidden',
        borderRadius: 'var(--radius-card)',
        border: '1px solid var(--border)',
        background: 'var(--color-background-tertiary, rgba(127,127,127,0.08))',
      }}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          style={{
            width: '100%',
            height: '100%',
            /*
             * COVER, not contain. Contain would letterbox, and a letterboxed
             * tall picture is the same illegible sliver as before with bars
             * drawn around it — strictly worse, because it also wastes the
             * space the bars occupy.
             */
            objectFit: 'cover',
            // Top for a cropped screenshot, which is read from its first line
            // down. See the rule for why this is not always `center`.
            objectPosition: box.anchor === 'top' ? 'top center' : 'center',
            display: 'block',
          }}
        />
      ) : null}
      {box.cropped ? (
        <>
          {/*
            A crop that is not announced is indistinguishable from a picture
            that simply ends there, and a reader has no way to tell they are
            looking at part of something. The fade says "continues"; the pill
            says what to do about it.
          */}
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              insetInline: 0,
              bottom: 0,
              height: 56,
              background: 'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.55) 100%)',
              pointerEvents: 'none',
            }}
          />
          <span
            data-testid="chat-image-cropped-badge"
            style={{
              position: 'absolute',
              left: 8,
              bottom: 8,
              padding: '3px 8px',
              borderRadius: 'var(--radius-pill, 999px)',
              background: 'rgba(0,0,0,0.55)',
              color: '#fff',
              fontSize: 12,
              lineHeight: 1.3,
              pointerEvents: 'none',
            }}
          >
            {croppedLabel}
          </span>
        </>
      ) : null}
    </span>
  );
}
