import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock auth to control session tokens
vi.mock('@/lib/mcp/auth', () => ({
  getSessionToken: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeMockServer() {
  const tools: Record<string, {
    handler: (params: Record<string, unknown>) => Promise<unknown>;
    schema: Record<string, unknown>;
  }> = {};
  return {
    tool: vi.fn((
      name: string,
      _desc: string,
      schema: Record<string, unknown>,
      handler: (params: Record<string, unknown>) => Promise<unknown>,
    ) => {
      tools[name] = { handler, schema };
    }),
    _getHandler: (name: string) => tools[name]?.handler,
    _getSchema: (name: string) => tools[name]?.schema,
    _getToolNames: () => Object.keys(tools),
  };
}

const minimalSpec = {
  paths: {
    '/api/topics': {
      get: { summary: 'List topics', parameters: [] },
      post: { summary: 'Create topic', requestBody: { content: { 'application/json': { schema: { properties: { title: { type: 'string' } }, required: ['title'] } } } } },
    },
    '/api/topics/{topicId}/posts': {
      post: {
        summary: 'Create post',
        parameters: [],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                properties: {
                  title: { type: 'string', description: 'Post title' },
                  content: { type: 'string' },
                  tags: { type: 'array' },
                },
                required: ['title', 'content'],
              },
            },
          },
        },
      },
    },
    '/api/topics/{topicId}': {
      delete: { summary: 'Delete topic', parameters: [] },
      get: {
        summary: 'Get topic',
        parameters: [
          { name: 'include', in: 'query', required: false, description: 'Include extra', schema: { type: 'string' } },
        ],
      },
    },
    // Excluded paths — should not be registered
    '/api/health': { get: { summary: 'Health check' } },
    '/api/auth/challenge': { post: { summary: 'Create challenge' } },
    '/api/upload': { post: { summary: 'Upload' } },
  },
};

describe('registerOpenApiTools — tool name generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates correct tool names for simple paths', async () => {
    const { registerOpenApiTools } = await import('@/lib/mcp/openapi-tools');
    const server = makeMockServer();
    registerOpenApiTools(server as never, minimalSpec as never, () => 'sid', 'http://localhost:3200');

    const names = server._getToolNames();
    expect(names).toContain('get_topics');
    expect(names).toContain('post_topics');
  });

  it('generates correct tool name for nested path with path param', async () => {
    const { registerOpenApiTools } = await import('@/lib/mcp/openapi-tools');
    const server = makeMockServer();
    registerOpenApiTools(server as never, minimalSpec as never, () => 'sid', 'http://localhost:3200');

    expect(server._getToolNames()).toContain('post_topics_topicId_posts');
  });

  it('generates correct tool name for DELETE with path param', async () => {
    const { registerOpenApiTools } = await import('@/lib/mcp/openapi-tools');
    const server = makeMockServer();
    registerOpenApiTools(server as never, minimalSpec as never, () => 'sid', 'http://localhost:3200');

    expect(server._getToolNames()).toContain('delete_topics_topicId');
  });
});

describe('registerOpenApiTools — excluded paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not register tools for EXCLUDED_PATHS entries', async () => {
    const { registerOpenApiTools } = await import('@/lib/mcp/openapi-tools');
    const server = makeMockServer();
    registerOpenApiTools(server as never, minimalSpec as never, () => 'sid', 'http://localhost:3200');

    const names = server._getToolNames();
    expect(names).not.toContain('get_health');
    expect(names).not.toContain('post_auth_challenge');
    expect(names).not.toContain('post_upload');
  });
});

describe('registerOpenApiTools — parameter schema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes path params in schema', async () => {
    const { registerOpenApiTools } = await import('@/lib/mcp/openapi-tools');
    const server = makeMockServer();
    registerOpenApiTools(server as never, minimalSpec as never, () => 'sid', 'http://localhost:3200');

    const schema = server._getSchema('post_topics_topicId_posts');
    expect(schema).toHaveProperty('topicId');
  });

  it('includes query params as optional fields in schema', async () => {
    const { registerOpenApiTools } = await import('@/lib/mcp/openapi-tools');
    const server = makeMockServer();
    registerOpenApiTools(server as never, minimalSpec as never, () => 'sid', 'http://localhost:3200');

    const schema = server._getSchema('get_topics_topicId');
    expect(schema).toHaveProperty('include');
    // Optional fields are ZodOptional wrappers
    const includeField = (schema as Record<string, { isOptional?: () => boolean }>)['include'];
    expect(typeof includeField).toBe('object');
  });

  it('includes required body fields in schema', async () => {
    const { registerOpenApiTools } = await import('@/lib/mcp/openapi-tools');
    const server = makeMockServer();
    registerOpenApiTools(server as never, minimalSpec as never, () => 'sid', 'http://localhost:3200');

    const schema = server._getSchema('post_topics_topicId_posts');
    expect(schema).toHaveProperty('title');
    expect(schema).toHaveProperty('content');
    expect(schema).toHaveProperty('tags');
  });
});

describe('registerOpenApiTools — fetch behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes Authorization header when session token exists', async () => {
    const { getSessionToken } = await import('@/lib/mcp/auth');
    vi.mocked(getSessionToken).mockReturnValue('jwt-test-token');

    const { registerOpenApiTools } = await import('@/lib/mcp/openapi-tools');
    const server = makeMockServer();
    registerOpenApiTools(server as never, minimalSpec as never, () => 'sid-auth', 'http://localhost:3200');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ topics: [] }),
    });

    const handler = server._getHandler('get_topics')!;
    await handler({});

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3200/api/topics',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-test-token' }),
      }),
    );
  });

  it('omits Authorization header when no session token', async () => {
    const { getSessionToken } = await import('@/lib/mcp/auth');
    vi.mocked(getSessionToken).mockReturnValue(undefined);

    const { registerOpenApiTools } = await import('@/lib/mcp/openapi-tools');
    const server = makeMockServer();
    registerOpenApiTools(server as never, minimalSpec as never, () => 'sid-noauth', 'http://localhost:3200');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ topics: [] }),
    });

    const handler = server._getHandler('get_topics')!;
    await handler({});

    const fetchCall = mockFetch.mock.calls[0];
    const headers = (fetchCall[1] as { headers: Record<string, string> }).headers;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('substitutes path params into the URL', async () => {
    const { getSessionToken } = await import('@/lib/mcp/auth');
    vi.mocked(getSessionToken).mockReturnValue(undefined);

    const { registerOpenApiTools } = await import('@/lib/mcp/openapi-tools');
    const server = makeMockServer();
    registerOpenApiTools(server as never, minimalSpec as never, () => 'sid', 'http://localhost:3200');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({}),
    });

    const handler = server._getHandler('delete_topics_topicId')!;
    await handler({ topicId: 'topic-abc' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3200/api/topics/topic-abc',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('returns error result on non-ok HTTP response', async () => {
    const { getSessionToken } = await import('@/lib/mcp/auth');
    vi.mocked(getSessionToken).mockReturnValue(undefined);

    const { registerOpenApiTools } = await import('@/lib/mcp/openapi-tools');
    const server = makeMockServer();
    registerOpenApiTools(server as never, minimalSpec as never, () => 'sid', 'http://localhost:3200');

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'Not found' }),
    });

    const handler = server._getHandler('get_topics')!;
    const result = await handler({}) as { isError: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('404');
  });

  it('returns error result when path param is missing', async () => {
    const { getSessionToken } = await import('@/lib/mcp/auth');
    vi.mocked(getSessionToken).mockReturnValue(undefined);

    const { registerOpenApiTools } = await import('@/lib/mcp/openapi-tools');
    const server = makeMockServer();
    registerOpenApiTools(server as never, minimalSpec as never, () => 'sid', 'http://localhost:3200');

    const handler = server._getHandler('delete_topics_topicId')!;
    // topicId not provided
    const result = await handler({}) as { isError: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('topicId');
  });
});
