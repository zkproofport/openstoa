import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock child_process.spawn so we can drive stderr/stdout/exit events ourselves.
class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    this.exitCode = 137;
    setImmediate(() => this.emit('exit', 137));
    return true;
  });
  emitStderr(text: string) {
    this.stderr.emit('data', Buffer.from(text));
  }
  emitStdout(text: string) {
    this.stdout.emit('data', Buffer.from(text));
  }
  finish(code: number) {
    this.exitCode = code;
    this.emit('exit', code);
  }
}

const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// A fake proof JSON that the mocked subprocess "emits" on stdout for phase 2.
const FAKE_PROOF = {
  circuit: 'oidc_domain',
  proofType: 'oidc_domain',
  proof: '0xproof',
  publicInputs: '0xinputs',
  verification: { chainId: 8453, verifierAddress: '0xabc', rpcUrl: 'https://rpc' },
};

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
    const tools: Record<string, { handler: (params: unknown) => Promise<unknown> }> = {};
    return {
      tool: vi.fn(
        (
          name: string,
          _desc: string,
          _schema: unknown,
          handler: (params: unknown) => Promise<unknown>,
        ) => {
          tools[name] = { handler };
        },
      ),
      _getHandler: (name: string) => tools[name]?.handler,
    };
  }

  type ToolResp = { content: Array<{ text: string }>; isError?: boolean };

  function mockChallengeOk(challengeId = 'chal-1', scope = 'zkproofport-community') {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ challengeId, scope, expiresIn: 300 }),
    });
  }

  function mockVerifyOk(body: {
    userId?: string;
    needsNickname?: boolean;
    token?: string;
  }) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => body,
    });
  }

  it('registers an "authenticate" tool on the server', async () => {
    const { registerAuthTool } = await import('@/lib/mcp/auth');
    const server = makeMockServer();
    registerAuthTool(server as never, () => 'session-x', 'http://localhost:3200');
    expect(server.tool).toHaveBeenCalledOnce();
    expect(server.tool.mock.calls[0][0]).toBe('authenticate');
  });

  it('phase 1: returns pending_user_login with device URL + code', async () => {
    const { registerAuthTool } = await import('@/lib/mcp/auth');
    const server = makeMockServer();
    registerAuthTool(server as never, () => 'session-p1', 'http://localhost:3200');

    mockChallengeOk('chal-1', 'zkproofport-community');

    const child = new MockChild();
    mockSpawn.mockReturnValueOnce(child);

    const handler = server._getHandler('authenticate')!;
    const resultPromise = handler({});
    // Simulate prove.js emitting the Google device code on stderr shortly after spawn.
    setImmediate(() => {
      child.emitStderr('\n  Open: https://www.google.com/device\n  Code: ABC-DEF-GHI\n\n  Waiting for authorization...\n');
    });

    const result = (await resultPromise) as ToolResp;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('pending_user_login');
    expect(parsed.verificationUrl).toBe('https://www.google.com/device');
    expect(parsed.userCode).toBe('ABC-DEF-GHI');
    expect(parsed.instructions).toContain('browser');

    // Challenge fetch should have been called exactly once.
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3200/api/auth/challenge',
      { method: 'POST' },
    );
    // spawn should have been called with --login-google --scope <scope> --silent.
    const spawnArgs = mockSpawn.mock.calls[0] as unknown[];
    const argv = spawnArgs[1] as string[];
    expect(argv).toContain('--login-google');
    expect(argv).toContain('--scope');
    expect(argv).toContain('zkproofport-community');
    expect(argv).toContain('--silent');

    // Clean up the subprocess so the pendingAuths Map is empty before the next test.
    const { clearSessionToken } = await import('@/lib/mcp/auth');
    clearSessionToken('session-p1');
  });

  it('phase 1: returns error when challenge fetch fails', async () => {
    const { registerAuthTool } = await import('@/lib/mcp/auth');
    const server = makeMockServer();
    registerAuthTool(server as never, () => 'session-err', 'http://localhost:3200');

    mockFetch.mockResolvedValueOnce({
      ok: false,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'DB unavailable' }),
    });

    const handler = server._getHandler('authenticate')!;
    const result = (await handler({})) as ToolResp;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('DB unavailable');
    // spawn must NOT have been called because challenge failed first.
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('phase 1: returns error when prove.js exits before emitting device code', async () => {
    const { registerAuthTool } = await import('@/lib/mcp/auth');
    const server = makeMockServer();
    registerAuthTool(server as never, () => 'session-crash', 'http://localhost:3200');

    mockChallengeOk();

    // Both spawn attempts crash immediately. The tool is configured to retry
    // once (MAX_SPAWN_ATTEMPTS = 2), so we queue two failing children.
    const child1 = new MockChild();
    const child2 = new MockChild();
    mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const handler = server._getHandler('authenticate')!;
    const resultPromise = handler({});

    setImmediate(() => {
      child1.emitStderr('boom\n');
      child1.finish(1);
    });
    // Second child also crashes, after a tick, to simulate the retry path.
    setImmediate(() => {
      setImmediate(() => {
        child2.emitStderr('boom again\n');
        child2.finish(1);
      });
    });

    const result = (await resultPromise) as ToolResp;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/Device flow failed after 2 attempts/);
    // Both spawn attempts must have happened.
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('phase 2: resumes pending auth, submits proof, and stores session token', async () => {
    const { registerAuthTool, getSessionToken } = await import('@/lib/mcp/auth');
    const server = makeMockServer();
    const sessionId = 'session-p2';
    registerAuthTool(server as never, () => sessionId, 'http://localhost:3200');

    // ── Phase 1 ────────────────────────────────────────────────────────
    mockChallengeOk('chal-p2', 'zkproofport-community');
    const child = new MockChild();
    mockSpawn.mockReturnValueOnce(child);

    const handler = server._getHandler('authenticate')!;
    const phase1Promise = handler({});
    setImmediate(() => {
      child.emitStderr('\n  Open: https://www.google.com/device\n  Code: XYZ-123-ABC\n');
    });
    const phase1 = (await phase1Promise) as ToolResp;
    const phase1Parsed = JSON.parse(phase1.content[0].text);
    expect(phase1Parsed.status).toBe('pending_user_login');

    // ── Phase 2 ────────────────────────────────────────────────────────
    // /api/auth/verify/ai returns a successful token.
    mockVerifyOk({ userId: 'user-42', needsNickname: false, token: 'jwt-token-xyz' });

    const phase2Promise = handler({});
    // Simulate prove.js finishing: stdout receives proof JSON, process exits 0.
    setImmediate(() => {
      child.emitStdout(JSON.stringify(FAKE_PROOF));
      child.finish(0);
    });
    const phase2 = (await phase2Promise) as ToolResp;
    expect(phase2.isError).toBeFalsy();
    const phase2Parsed = JSON.parse(phase2.content[0].text);
    expect(phase2Parsed.status).toBe('authenticated');
    expect(phase2Parsed.userId).toBe('user-42');
    expect(phase2Parsed.needsNickname).toBe(false);

    // /api/auth/verify/ai should have been called with the stored challengeId
    // and the proof JSON we pushed through stdout.
    const verifyCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/api/auth/verify/ai'),
    );
    expect(verifyCall).toBeDefined();
    const [, verifyInit] = verifyCall!;
    expect((verifyInit as RequestInit).method).toBe('POST');
    const verifyBody = JSON.parse((verifyInit as RequestInit).body as string);
    expect(verifyBody.challengeId).toBe('chal-p2');
    expect(verifyBody.result).toEqual(FAKE_PROOF);

    // Session token must be stored server-side.
    expect(getSessionToken(sessionId)).toBe('jwt-token-xyz');
  });

  it('phase 2: includes nextStep hint when needsNickname is true', async () => {
    const { registerAuthTool } = await import('@/lib/mcp/auth');
    const server = makeMockServer();
    registerAuthTool(server as never, () => 'session-nn', 'http://localhost:3200');

    mockChallengeOk('chal-nn');
    const child = new MockChild();
    mockSpawn.mockReturnValueOnce(child);

    const handler = server._getHandler('authenticate')!;
    const phase1Promise = handler({});
    setImmediate(() => {
      child.emitStderr('\n  Open: https://www.google.com/device\n  Code: NN-NN-NN\n');
    });
    await phase1Promise;

    mockVerifyOk({ userId: 'user-99', needsNickname: true, token: 'jwt-nn' });
    const phase2Promise = handler({});
    setImmediate(() => {
      child.emitStdout(JSON.stringify(FAKE_PROOF));
      child.finish(0);
    });
    const phase2 = (await phase2Promise) as ToolResp;
    const parsed = JSON.parse(phase2.content[0].text);
    expect(parsed.needsNickname).toBe(true);
    expect(parsed.nextStep).toMatch(/patch_profile_nickname/);
  });

  it('phase 2: returns error when verification response has no token', async () => {
    const { registerAuthTool } = await import('@/lib/mcp/auth');
    const server = makeMockServer();
    registerAuthTool(server as never, () => 'session-fail', 'http://localhost:3200');

    mockChallengeOk('chal-fail');
    const child = new MockChild();
    mockSpawn.mockReturnValueOnce(child);

    const handler = server._getHandler('authenticate')!;
    const phase1Promise = handler({});
    setImmediate(() => {
      child.emitStderr('\n  Open: https://www.google.com/device\n  Code: BAD-BAD\n');
    });
    await phase1Promise;

    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Invalid proof' }),
    });

    const phase2Promise = handler({});
    setImmediate(() => {
      child.emitStdout(JSON.stringify(FAKE_PROOF));
      child.finish(0);
    });
    const phase2 = (await phase2Promise) as ToolResp;
    expect(phase2.isError).toBe(true);
    const parsed = JSON.parse(phase2.content[0].text);
    expect(parsed.error).toBe('Invalid proof');
  });

  it('phase 2: returns error when subprocess exits with non-zero code', async () => {
    const { registerAuthTool } = await import('@/lib/mcp/auth');
    const server = makeMockServer();
    registerAuthTool(server as never, () => 'session-crash2', 'http://localhost:3200');

    mockChallengeOk('chal-crash');
    const child = new MockChild();
    mockSpawn.mockReturnValueOnce(child);

    const handler = server._getHandler('authenticate')!;
    const phase1Promise = handler({});
    setImmediate(() => {
      child.emitStderr('\n  Open: https://www.google.com/device\n  Code: OK-OK-OK\n');
    });
    await phase1Promise;

    const phase2Promise = handler({});
    setImmediate(() => {
      child.emitStderr('fatal: network error\n');
      child.finish(1);
    });
    const phase2 = (await phase2Promise) as ToolResp;
    expect(phase2.isError).toBe(true);
    const parsed = JSON.parse(phase2.content[0].text);
    expect(parsed.error).toMatch(/zkproofport-prove failed/);
    expect(parsed.error).toMatch(/fatal: network error/);
  });
});
