import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('session token helpers', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('setSessionToken / getSessionToken stores and retrieves a token', async () => {
    const { setSessionToken, getSessionToken } = await import('@/lib/mcp/auth');
    setSessionToken('session-1', 'jwt-abc');
    expect(getSessionToken('session-1')).toBe('jwt-abc');
  });

  it('getSessionToken returns undefined for unknown session', async () => {
    const { getSessionToken } = await import('@/lib/mcp/auth');
    expect(getSessionToken('no-such-session')).toBeUndefined();
  });

  it('clearSessionToken removes the token', async () => {
    const { setSessionToken, getSessionToken, clearSessionToken } = await import('@/lib/mcp/auth');
    setSessionToken('session-2', 'jwt-xyz');
    clearSessionToken('session-2');
    expect(getSessionToken('session-2')).toBeUndefined();
  });
});

describe('registerAuthTool', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  function makeMockServer() {
    const tools: Record<string, { handler: (params: unknown) => unknown }> = {};
    return {
      tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: (params: unknown) => unknown) => {
        tools[name] = { handler };
      }),
      _getHandler: (name: string) => tools[name]?.handler,
    };
  }

  it('registers an "authenticate" tool on the server', async () => {
    const { registerAuthTool } = await import('@/lib/mcp/auth');
    const server = makeMockServer();
    registerAuthTool(server as never, () => 'session-x', 'http://localhost:3200');
    expect(server.tool).toHaveBeenCalledOnce();
    expect(server.tool.mock.calls[0][0]).toBe('authenticate');
  });

  it('returns challenge when called with no arguments', async () => {
    const { registerAuthTool } = await import('@/lib/mcp/auth');
    const server = makeMockServer();
    registerAuthTool(server as never, () => 'session-x', 'http://localhost:3200');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ challengeId: 'chal-1', scope: 'openid email', expiresIn: 300 }),
    });

    const handler = server._getHandler('authenticate')!;
    const result = await handler({}) as { content: Array<{ text: string }> };

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3200/api/auth/challenge', { method: 'POST' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.challengeId).toBe('chal-1');
    expect(parsed.scope).toBe('openid email');
    expect(parsed.instructions).toBeDefined();
  });

  it('returns error when challenge fetch fails', async () => {
    const { registerAuthTool } = await import('@/lib/mcp/auth');
    const server = makeMockServer();
    registerAuthTool(server as never, () => 'session-x', 'http://localhost:3200');

    mockFetch.mockResolvedValueOnce({
      ok: false,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'DB unavailable' }),
    });

    const handler = server._getHandler('authenticate')!;
    const result = await handler({}) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('DB unavailable');
  });

  it('returns error when challengeId is provided but result is missing', async () => {
    const { registerAuthTool } = await import('@/lib/mcp/auth');
    const server = makeMockServer();
    registerAuthTool(server as never, () => 'session-x', 'http://localhost:3200');

    const handler = server._getHandler('authenticate')!;
    const result = await handler({ challengeId: 'chal-1' }) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('result is required');
  });

  it('verifies proof and stores token when challengeId + result are provided', async () => {
    const { registerAuthTool, getSessionToken } = await import('@/lib/mcp/auth');
    const server = makeMockServer();
    const sessionId = 'session-verify';
    registerAuthTool(server as never, () => sessionId, 'http://localhost:3200');

    const proofResult = {
      proof: '0xproof',
      publicInputs: '0xinputs',
      verification: { chainId: 8453, verifierAddress: '0xabc', rpcUrl: 'https://rpc' },
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ userId: 'user-42', needsNickname: false, token: 'jwt-token-xyz' }),
    });

    const handler = server._getHandler('authenticate')!;
    const result = await handler({ challengeId: 'chal-1', result: proofResult }) as { content: Array<{ text: string }> };

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3200/api/auth/verify/ai',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ challengeId: 'chal-1', result: proofResult }),
      }),
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.userId).toBe('user-42');
    expect(parsed.needsNickname).toBe(false);
    expect(getSessionToken(sessionId)).toBe('jwt-token-xyz');
  });

  it('includes nextStep hint when needsNickname is true', async () => {
    const { registerAuthTool } = await import('@/lib/mcp/auth');
    const server = makeMockServer();
    registerAuthTool(server as never, () => 'session-nn', 'http://localhost:3200');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ userId: 'user-99', needsNickname: true, token: 'jwt-nn' }),
    });

    const handler = server._getHandler('authenticate')!;
    const result = await handler({
      challengeId: 'chal-2',
      result: { proof: '0xp', publicInputs: '0xi', verification: { chainId: 1, verifierAddress: '0x0', rpcUrl: '' } },
    }) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.nextStep).toContain('patch_profile_nickname');
  });

  it('returns error when verification response has no token', async () => {
    const { registerAuthTool } = await import('@/lib/mcp/auth');
    const server = makeMockServer();
    registerAuthTool(server as never, () => 'session-fail', 'http://localhost:3200');

    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Invalid proof' }),
    });

    const handler = server._getHandler('authenticate')!;
    const result = await handler({
      challengeId: 'chal-bad',
      result: { proof: '0xbad', publicInputs: '0xbad', verification: { chainId: 1, verifierAddress: '0x0', rpcUrl: '' } },
    }) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('Invalid proof');
  });
});
