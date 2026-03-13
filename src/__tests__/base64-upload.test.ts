import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the r2 module
vi.mock('@/lib/r2', () => ({
  uploadToR2: vi.fn(),
}));

// Mock the logger
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { extractAndUploadBase64Images } from '@/lib/base64-upload';
import { uploadToR2 } from '@/lib/r2';

const mockUploadToR2 = vi.mocked(uploadToR2);

// Minimal valid base64 for a 1x1 pixel PNG (small, well under 10MB)
const SMALL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Minimal JPEG base64 (1x1 pixel)
const SMALL_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

// Minimal GIF base64 (1x1 pixel)
const SMALL_GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Minimal SVG+XML base64
const SMALL_SVG_BASE64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>').toString('base64');

// Generate base64 string that decodes to >10MB
function makeOversizedBase64(): string {
  const bytes = Buffer.alloc(11 * 1024 * 1024, 0x41); // 11MB of 'A'
  return bytes.toString('base64');
}

describe('extractAndUploadBase64Images', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns original content when no base64 images are present', async () => {
    const content = '<p>Hello world</p><img src="https://example.com/photo.png" />';
    const result = await extractAndUploadBase64Images(content, 'user-1');
    expect(result).toBe(content);
    expect(mockUploadToR2).not.toHaveBeenCalled();
  });

  it('extracts and replaces a single PNG base64 image', async () => {
    const cdnUrl = 'https://cdn.example.com/images/abc123.png';
    mockUploadToR2.mockResolvedValueOnce(cdnUrl);

    const content = `<p>Look at this:</p><img src="data:image/png;base64,${SMALL_PNG_BASE64}" alt="test" />`;
    const result = await extractAndUploadBase64Images(content, 'user-1');

    expect(mockUploadToR2).toHaveBeenCalledOnce();
    expect(mockUploadToR2).toHaveBeenCalledWith(
      expect.any(Buffer),
      'image/png',
      'user-1',
      'post',
    );
    expect(result).toContain(`src="${cdnUrl}"`);
    expect(result).not.toContain('data:image/png;base64,');
    expect(result).toContain('<p>Look at this:</p>');
  });

  it('extracts and replaces multiple images of different types', async () => {
    const pngUrl = 'https://cdn.example.com/images/png-img.png';
    const jpegUrl = 'https://cdn.example.com/images/jpeg-img.jpg';
    const gifUrl = 'https://cdn.example.com/images/gif-img.gif';
    mockUploadToR2
      .mockResolvedValueOnce(pngUrl)
      .mockResolvedValueOnce(jpegUrl)
      .mockResolvedValueOnce(gifUrl);

    const content = [
      `<img src="data:image/png;base64,${SMALL_PNG_BASE64}" />`,
      `<img src="data:image/jpeg;base64,${SMALL_JPEG_BASE64}" />`,
      `<img src="data:image/gif;base64,${SMALL_GIF_BASE64}" />`,
    ].join('\n');

    const result = await extractAndUploadBase64Images(content, 'user-2');

    expect(mockUploadToR2).toHaveBeenCalledTimes(3);
    expect(result).toContain(`src="${pngUrl}"`);
    expect(result).toContain(`src="${jpegUrl}"`);
    expect(result).toContain(`src="${gifUrl}"`);
    expect(result).not.toContain('data:image/');
  });

  it('handles svg+xml content type', async () => {
    const svgUrl = 'https://cdn.example.com/images/icon.svg';
    mockUploadToR2.mockResolvedValueOnce(svgUrl);

    const content = `<img src="data:image/svg+xml;base64,${SMALL_SVG_BASE64}" />`;
    const result = await extractAndUploadBase64Images(content, 'user-3');

    expect(mockUploadToR2).toHaveBeenCalledOnce();
    expect(mockUploadToR2).toHaveBeenCalledWith(
      expect.any(Buffer),
      'image/svg+xml',
      'user-3',
      'post',
    );
    expect(result).toContain(`src="${svgUrl}"`);
  });

  it('skips images whose decoded size exceeds 10MB', async () => {
    const oversized = makeOversizedBase64();
    const content = `<img src="data:image/png;base64,${oversized}" />`;

    const result = await extractAndUploadBase64Images(content, 'user-4');

    expect(mockUploadToR2).not.toHaveBeenCalled();
    // Original data URI is preserved (skipped, not replaced)
    expect(result).toContain('data:image/png;base64,');
  });

  it('leaves original data URI in place when upload fails', async () => {
    mockUploadToR2.mockRejectedValueOnce(new Error('R2 unavailable'));

    const content = `<img src="data:image/png;base64,${SMALL_PNG_BASE64}" />`;
    const result = await extractAndUploadBase64Images(content, 'user-5');

    expect(mockUploadToR2).toHaveBeenCalledOnce();
    expect(result).toContain('data:image/png;base64,');
  });

  it('handles mixed content with text, base64 images, and normal img tags', async () => {
    const cdnUrl = 'https://cdn.example.com/images/replaced.png';
    mockUploadToR2.mockResolvedValueOnce(cdnUrl);

    const normalImgTag = '<img src="https://external.com/photo.jpg" alt="external" />';
    const content = `
      <h1>Title</h1>
      <p>Some text before.</p>
      ${normalImgTag}
      <img src="data:image/png;base64,${SMALL_PNG_BASE64}" alt="embedded" />
      <p>Some text after.</p>
    `;

    const result = await extractAndUploadBase64Images(content, 'user-6');

    expect(mockUploadToR2).toHaveBeenCalledOnce();
    expect(result).toContain(`src="${cdnUrl}"`);
    expect(result).toContain(normalImgTag);
    expect(result).toContain('<h1>Title</h1>');
    expect(result).toContain('Some text before.');
    expect(result).toContain('Some text after.');
    expect(result).not.toContain('data:image/png;base64,');
  });

  it('handles single-quoted src attributes', async () => {
    const cdnUrl = 'https://cdn.example.com/images/single-quote.png';
    mockUploadToR2.mockResolvedValueOnce(cdnUrl);

    const content = `<img src='data:image/png;base64,${SMALL_PNG_BASE64}' />`;
    const result = await extractAndUploadBase64Images(content, 'user-7');

    expect(mockUploadToR2).toHaveBeenCalledOnce();
    expect(result).toContain(cdnUrl);
    expect(result).not.toContain('data:image/png;base64,');
  });

  it('preserves non-image HTML tags and surrounding content', async () => {
    const content = '<p>No images here.</p><a href="/about">About</a><ul><li>Item</li></ul>';
    const result = await extractAndUploadBase64Images(content, 'user-8');

    expect(result).toBe(content);
    expect(mockUploadToR2).not.toHaveBeenCalled();
  });
});
