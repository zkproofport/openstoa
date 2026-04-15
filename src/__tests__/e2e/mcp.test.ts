import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE_URL = process.env.E2E_BASE_URL || 'https://stg-community.zkproofport.app';
const MCP_URL = new URL('/mcp', BASE_URL);

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

  it('authenticate tool phase 1 returns pending_user_login with device URL + code', async () => {
    const result = await client.callTool({ name: 'authenticate', arguments: {} });
    expect(result.isError).not.toBe(true);

    const content = (result.content as Array<{ type: string; text: string }>)[0];
    expect(content.type).toBe('text');

    const payload = JSON.parse(content.text) as {
      status?: string;
      verificationUrl?: string;
      userCode?: string;
      instructions?: string;
      error?: string;
    };

    expect(payload.error).toBeUndefined();
    expect(payload.status).toBe('pending_user_login');
    expect(payload.verificationUrl).toMatch(/^https:\/\/(www\.)?google\.com\/device/);
    expect(payload.userCode).toMatch(/^[A-Z0-9-]{6,}$/);
    expect(payload.instructions).toContain('browser');
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

  // ─── Smoke test: every parameter-less tool reaches the backend ─────────────
  // Iterates through all registered tools that require no arguments and invokes
  // each one. We only assert that the MCP adapter returns a well-formed response
  // (either success content or an error payload) — individual endpoint behaviour
  // is covered by the REST E2E suites.
  it('smoke: every parameter-less tool is invokable via MCP', async () => {
    const { tools } = await client.listTools();

    const paramless = tools.filter((t) => {
      // authenticate spawns a ~5-minute Google device flow subprocess as a
      // side effect, so skip it here — phase 1 is already covered above and
      // the full flow is covered by the manual MCP e2e script.
      if (t.name === 'authenticate') return false;
      const schema = t.inputSchema as { required?: string[] } | undefined;
      return !schema?.required || schema.required.length === 0;
    });

    expect(paramless.length).toBeGreaterThan(5);

    const failures: string[] = [];
    for (const tool of paramless) {
      try {
        const result = await client.callTool({ name: tool.name, arguments: {} });
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        if (!Array.isArray(content) || content.length === 0) {
          failures.push(`${tool.name}: missing content array`);
          continue;
        }
        const first = content[0];
        if (first.type !== 'text' || typeof first.text !== 'string') {
          failures.push(`${tool.name}: first content block is not text`);
          continue;
        }
        // Must be JSON (success payload or { error })
        JSON.parse(first.text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${tool.name}: ${msg}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`Smoke test failures:\n${failures.join('\n')}`);
    }
  });
});
