'use client';

import React from 'react';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Embed {
  type: 'youtube' | 'vimeo';
  url: string;
  videoId: string;
}

interface SNSContentProps {
  text: string;
  media?: { images?: string[]; embeds?: Embed[] } | null;
}

// ─── URL Auto-linking ───────────────────────────────────────────────────────

const URL_REGEX = /(https?:\/\/[^\s<]+)/g;

function linkifyText(text: string): (string | React.ReactElement)[] {
  const parts: (string | React.ReactElement)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const url = match[1];
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: 'var(--accent)',
          textDecoration: 'underline',
          textUnderlineOffset: 2,
          textDecorationColor: 'rgba(59,130,246,0.4)',
          transition: 'text-decoration-color 0.12s',
          wordBreak: 'break-all',
        }}
      >
        {url}
      </a>
    );
    lastIndex = match.index + url.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

// ─── Image Grid ─────────────────────────────────────────────────────────────

function ImageGrid({ images }: { images: string[] }) {
  if (images.length === 0) return null;

  if (images.length === 1) {
    return (
      <div style={{ marginTop: 12 }}>
        <img
          src={images[0]}
          alt=""
          style={{
            width: '100%',
            maxHeight: 480,
            objectFit: 'cover',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.06)',
            display: 'block',
          }}
        />
      </div>
    );
  }

  if (images.length === 2) {
    return (
      <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, borderRadius: 10, overflow: 'hidden' }}>
        {images.map((url, i) => (
          <img
            key={url + i}
            src={url}
            alt=""
            style={{
              width: '100%',
              height: 240,
              objectFit: 'cover',
              display: 'block',
            }}
          />
        ))}
      </div>
    );
  }

  // 3+ images: grid
  return (
    <div style={{
      marginTop: 12,
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: 4,
      borderRadius: 10,
      overflow: 'hidden',
    }}>
      {images.map((url, i) => (
        <img
          key={url + i}
          src={url}
          alt=""
          style={{
            width: '100%',
            height: 160,
            objectFit: 'cover',
            display: 'block',
          }}
        />
      ))}
    </div>
  );
}

// ─── Video Embeds ───────────────────────────────────────────────────────────

function VideoEmbeds({ embeds }: { embeds: Embed[] }) {
  if (embeds.length === 0) return null;

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {embeds.map((embed) => {
        const src = embed.type === 'youtube'
          ? `https://www.youtube.com/embed/${embed.videoId}`
          : `https://player.vimeo.com/video/${embed.videoId}`;

        return (
          <div
            key={embed.videoId}
            style={{
              position: 'relative',
              width: '100%',
              paddingBottom: '56.25%',
              borderRadius: 10,
              overflow: 'hidden',
              background: '#0a0a0a',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <iframe
              src={src}
              title={`${embed.type} video`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                border: 'none',
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function SNSContent({ text, media }: SNSContentProps) {
  const images = media?.images ?? [];
  const embeds = media?.embeds ?? [];

  // Split text into lines, linkify each
  const lines = text.split('\n');

  return (
    <div style={{
      fontSize: 15,
      lineHeight: 1.8,
      color: 'var(--foreground)',
      wordBreak: 'break-word',
      fontFamily: "-apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif",
    }}>
      {/* Text with pre-wrap and auto-linked URLs */}
      <div style={{ whiteSpace: 'pre-wrap' }}>
        {lines.map((line, i) => (
          <span key={i}>
            {linkifyText(line)}
            {i < lines.length - 1 ? '\n' : ''}
          </span>
        ))}
      </div>

      {/* Images */}
      <ImageGrid images={images} />

      {/* Video embeds */}
      <VideoEmbeds embeds={embeds} />
    </div>
  );
}
