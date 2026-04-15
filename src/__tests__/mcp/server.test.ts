import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '@/lib/mcp/server';
import { uploadToR2 } from '@/lib/r2';

// Mock uploadToR2
vi.mock('@/lib/r2', () => ({
  uploadToR2: vi.fn(),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Helper ───────────────────────────────────────────────────────────────────
// Spy on McpServer.prototype.tool, call createMcpServer(), capture the handler
// for the named tool, then restore the spy.

type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: true;
}>;

function captureHandler(toolName: string): ToolHandler {
  const spy = vi.spyOn(McpServer.prototype, 'tool');
  createMcpServer();
  const call = spy.mock.calls.find((c) => c[0] === toolName);
  spy.mockRestore();
  if (!call) throw new Error(`Tool "${toolName}" was not registered`);
  return call[3] as ToolHandler;
}

describe('createMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an McpServer instance', () => {
    const server = createMcpServer();
    expect(server).toBeInstanceOf(McpServer);
  });

  it('registers the upload_image tool', () => {
    const spy = vi.spyOn(McpServer.prototype, 'tool');
    createMcpServer();
    const names = spy.mock.calls.map((c) => c[0] as string);
    expect(names).toContain('upload_image');
    spy.mockRestore();
  });

  it('registers the openstoa_usage_guide prompt', () => {
    const spy = vi.spyOn(McpServer.prototype, 'prompt');
    createMcpServer();
    const names = spy.mock.calls.map((c) => c[0] as string);
    expect(names).toContain('openstoa_usage_guide');
    spy.mockRestore();
  });
});

describe('upload_image tool handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls uploadToR2 with decoded buffer and returns publicUrl', async () => {
    vi.mocked(uploadToR2).mockResolvedValue('https://cdn.example.com/posts/mcp-agent/uuid/photo.jpg');

    const handler = captureHandler('upload_image');
    const base64 = Buffer.from('fake-image-data').toString('base64');

    const result = await handler({
      base64,
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      purpose: 'post',
    });

    expect(uploadToR2).toHaveBeenCalledWith(
      expect.any(Buffer),
      'image/jpeg',
      'mcp-agent',
      'post',
      'photo.jpg',
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.publicUrl).toBe('https://cdn.example.com/posts/mcp-agent/uuid/photo.jpg');
  });

  it('returns error when contentType is not image/*', async () => {
    const handler = captureHandler('upload_image');

    const result = await handler({
      base64: Buffer.from('data').toString('base64'),
      filename: 'doc.pdf',
      contentType: 'application/pdf',
      purpose: 'post',
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('Only image uploads are supported');
  });

  it('returns error when file size exceeds 10MB', async () => {
    const handler = captureHandler('upload_image');

    const overLimit = Buffer.alloc(10 * 1024 * 1024 + 1);
    const result = await handler({
      base64: overLimit.toString('base64'),
      filename: 'big.jpg',
      contentType: 'image/jpeg',
      purpose: 'post',
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('10MB');
  });

  it('returns error when uploadToR2 throws', async () => {
    vi.mocked(uploadToR2).mockRejectedValue(new Error('R2 connection refused'));

    const handler = captureHandler('upload_image');

    const result = await handler({
      base64: Buffer.from('img').toString('base64'),
      filename: 'img.png',
      contentType: 'image/png',
      purpose: 'avatar',
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('R2 connection refused');
  });
});
