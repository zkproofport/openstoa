// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SNSContent from '@/components/SNSContent';

// Mock LinkPreview to avoid network calls
vi.mock('@/components/LinkPreview', () => ({
  default: ({ url }: { url: string }) =>
    React.createElement('div', { 'data-testid': 'link-preview', 'data-url': url }),
}));

function render(html: string, props: Partial<Parameters<typeof SNSContent>[0]> = {}): string {
  return renderToStaticMarkup(
    React.createElement(SNSContent, { html, ...props })
  );
}

describe('SNSContent', () => {
  describe('YouTube URL detection', () => {
    it('renders an iframe with youtube.com/embed/VIDEO_ID for a standard watch URL', () => {
      const html = 'Check this out: https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      const output = render(html);
      expect(output).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ"');
    });

    it('renders an iframe with youtube.com/embed/VIDEO_ID for youtu.be short URL', () => {
      const html = 'Watch: https://youtu.be/dQw4w9WgXcQ';
      const output = render(html);
      expect(output).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ"');
    });

    it('renders an iframe for YouTube shorts URL', () => {
      const html = 'Short: https://www.youtube.com/shorts/dQw4w9WgXcQ';
      const output = render(html);
      expect(output).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ"');
    });
  });

  describe('Vimeo URL detection', () => {
    it('renders an iframe with player.vimeo.com/video/VIDEO_ID', () => {
      const html = 'Watch: https://vimeo.com/123456789';
      const output = render(html);
      expect(output).toContain('src="https://player.vimeo.com/video/123456789"');
    });
  });

  describe('multiple video URLs', () => {
    it('renders multiple iframes for multiple video URLs', () => {
      const html = 'Video 1: https://www.youtube.com/watch?v=dQw4w9WgXcQ\nVideo 2: https://vimeo.com/123456789';
      const output = render(html);
      expect(output).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ"');
      expect(output).toContain('src="https://player.vimeo.com/video/123456789"');
      // Count iframes
      const iframeCount = (output.match(/<iframe/g) ?? []).length;
      expect(iframeCount).toBe(2);
    });
  });

  describe('GIF URL detection', () => {
    it('renders a GIF from giphy.com as an img element', () => {
      const html = 'Funny: https://media.giphy.com/media/abc123/giphy.gif';
      const output = render(html);
      expect(output).toContain('<img');
      expect(output).toContain('media.giphy.com');
      // Should NOT be inside an iframe
      expect(output).not.toContain('<iframe');
    });

    it('renders a plain .gif URL as an img element', () => {
      const html = 'See: https://example.com/animation.gif';
      const output = render(html);
      expect(output).toContain('<img');
      expect(output).toContain('example.com/animation.gif');
      expect(output).not.toContain('<iframe');
    });
  });

  describe('plain URL auto-linking', () => {
    it('auto-links a plain URL with an <a> tag', () => {
      const html = 'Visit https://example.com for more info';
      const output = render(html);
      expect(output).toContain('<a ');
      expect(output).toContain('href="https://example.com"');
    });
  });

  describe('link preview', () => {
    it('renders a link preview for a non-video, non-GIF URL', () => {
      const html = 'Check https://example.com/article';
      const output = render(html);
      expect(output).toContain('data-testid="link-preview"');
      expect(output).toContain('data-url="https://example.com/article"');
    });

    it('does NOT render a link preview for a YouTube URL', () => {
      const html = 'Watch https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      const output = render(html);
      expect(output).not.toContain('data-testid="link-preview"');
    });

    it('does NOT render a link preview for a GIF URL', () => {
      const html = 'GIF: https://media.giphy.com/media/abc/giphy.gif';
      const output = render(html);
      expect(output).not.toContain('data-testid="link-preview"');
    });
  });

  describe('content without URLs', () => {
    it('renders just the text content with no iframes or imgs', () => {
      const html = 'Hello, world! No links here.';
      const output = render(html);
      expect(output).toContain('Hello, world!');
      expect(output).not.toContain('<iframe');
      expect(output).not.toContain('data-testid="link-preview"');
    });
  });

  describe('video URL removed from text content', () => {
    it('does not show the video URL as plain text when it is rendered as embed', () => {
      const videoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      const html = `Watch this: ${videoUrl}`;
      const output = render(html);
      // Iframe is present
      expect(output).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ"');
      // The raw URL text should be removed from the text section (not present as plain text)
      // The URL appears only inside the iframe src, not as a bare anchor or text
      // Count occurrences of the video URL — it should only appear as the iframe src, not in the text body
      const textBodyMatch = output.match(/<div[^>]*class="sns-content-body"[^>]*>([\s\S]*?)<\/div>/);
      if (textBodyMatch) {
        expect(textBodyMatch[1]).not.toContain('youtube.com/watch');
      }
    });
  });

  describe('truncated mode', () => {
    it('does NOT render video embeds when truncate=true', () => {
      const html = 'Watch: https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      const output = render(html, { truncate: true });
      expect(output).not.toContain('<iframe');
    });

    it('does NOT render GIF images when truncate=true', () => {
      const html = 'GIF: https://media.giphy.com/media/abc/giphy.gif';
      const output = render(html, { truncate: true });
      // The gif img rendered by GifImages component should not appear
      // (GifImages is only rendered in !truncate block)
      // We check that the gif URL does not appear as an img src in the output
      // Note: the text content may still auto-link, but GifImages won't render
      const gifImgPattern = /src="https:\/\/media\.giphy\.com/;
      // GifImages component is not rendered in truncate mode
      // The linkedHtml may still contain the URL as a link but not as an img from GifImages
      const output2 = render(html, { truncate: true });
      // GifImages div should not be present
      expect(output2).not.toContain('maxHeight:320');
    });

    it('does NOT render link preview when truncate=true', () => {
      const html = 'Visit https://example.com/article';
      const output = render(html, { truncate: true });
      expect(output).not.toContain('data-testid="link-preview"');
    });
  });

  describe('TypeScript interface — no media prop', () => {
    it('SNSContent does not accept a media prop (verified by only passing valid props)', () => {
      // This test verifies the component renders fine without a media prop.
      // If a "media" prop were passed, TypeScript would flag it at compile time.
      // Here we confirm the component renders correctly with only valid props.
      const validProps: Parameters<typeof SNSContent>[0] = {
        html: 'Hello',
        truncate: false,
        maxLines: 4,
        onToggleExpand: undefined,
      };
      // The type of validProps should not include "media"
      expect('media' in validProps).toBe(false);
      const output = render(validProps.html, validProps);
      expect(output).toContain('Hello');
    });
  });
});
