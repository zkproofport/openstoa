import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE_URL = process.env.E2E_BASE_URL || 'https://stg-community.zkproofport.app';
const MCP_URL = new URL('/api/mcp', BASE_URL);

let client: Client;
let transport: StreamableHTTPClientTransport;

describe.sequential('MCP server E2E', () => {
  beforeAll(async () => {
    transport = new StreamableHTTPClientTransport(MCP_URL);
    client = new Client({ name: 'openstoa-e2e', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
  });

  it('initializes an MCP session against staging', () => {
    expect(transport.sessionId).toBeTruthy();
  });

  it('lists tools including authenticate, upload_image, and OpenAPI-derived tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('authenticate');
    expect(names).toContain('upload_image');
    expect(names).toContain('get_topics');
    expect(names).toContain('post_topics_topicId_posts');

    // OpenAPI-derived tool set should be non-trivial
    expect(tools.length).toBeGreaterThan(15);
  });

  it('lists the openstoa_usage_guide prompt', async () => {
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);
    expect(names).toContain('openstoa_usage_guide');
  });

  it('serves the openstoa_usage_guide prompt content', async () => {
    const result = await client.getPrompt({ name: 'openstoa_usage_guide' });
    expect(result.messages.length).toBeGreaterThan(0);
    const first = result.messages[0];
    expect(first.role).toBe('user');
    expect(first.content.type).toBe('text');
    const text = (first.content as { text: string }).text;
    expect(text).toContain('OpenStoa');
    expect(text).toContain('authenticate');
  });

  it('authenticate tool (step 1) returns a challengeId + scope via real /api/auth/challenge', async () => {
    const result = await client.callTool({ name: 'authenticate', arguments: {} });
    expect(result.isError).not.toBe(true);

    const content = (result.content as Array<{ type: string; text: string }>)[0];
    expect(content.type).toBe('text');

    const payload = JSON.parse(content.text) as {
      challengeId?: string;
      scope?: string;
      expiresIn?: number;
      error?: string;
    };

    expect(payload.error).toBeUndefined();
    expect(payload.challengeId).toMatch(/^[a-f0-9-]{10,}$/i);
    expect(payload.scope).toBe('zkproofport-community');
    expect(payload.expiresIn).toBeGreaterThan(0);
  });

  it('authenticate tool (step 2) rejects missing result', async () => {
    const result = await client.callTool({
      name: 'authenticate',
      arguments: { challengeId: 'some-id' },
    });
    expect(result.isError).toBe(true);
    const content = (result.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(content.text) as { error?: string };
    expect(payload.error).toMatch(/result is required/i);
  });

  it('OpenAPI tool (get_categories) calls the real API without auth', async () => {
    const { tools } = await client.listTools();
    const hasGetCategories = tools.some((t) => t.name === 'get_categories');
    if (!hasGetCategories) return;

    const result = await client.callTool({ name: 'get_categories', arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = (result.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(content.text) as { categories?: unknown[] };
    expect(Array.isArray(payload.categories)).toBe(true);
  });

  it('OpenAPI tool without auth returns 401 for protected endpoint', async () => {
    // /api/bookmarks requires a session (not guest-accessible)
    const result = await client.callTool({ name: 'get_bookmarks', arguments: {} });
    expect(result.isError).toBe(true);
    const content = (result.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(content.text) as { error?: string };
    expect(payload.error).toMatch(/HTTP 401/);
  });
});
