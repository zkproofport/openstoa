/**
 * CLI unit tests: arg parsing → command-core dispatch, and the --json toggle.
 * A mock Commands (via the injected factory) records calls so wiring the wrong
 * method / args is caught. No network, no vault.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Commands, CommandConfig } from '@masselabs/openstoa-commands';
import { buildProgram } from '../cli';

function harness(overrides: Partial<Record<keyof Commands, (...a: unknown[]) => unknown>> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let lastConfig: CommandConfig | undefined;
  const make = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    const fn = overrides[method as keyof Commands];
    return Promise.resolve(fn ? (fn as (...a: unknown[]) => unknown)(...args) : {});
  };
  const cmds = {
    login: make('login'),
    logout: make('logout'),
    whoami: make('whoami'),
    topicsList: make('topicsList'),
    topicGet: make('topicGet'),
    topicCreate: make('topicCreate'),
    topicJoin: make('topicJoin'),
    topicLeave: make('topicLeave'),
    postList: make('postList'),
    postGet: make('postGet'),
    postCreate: make('postCreate'),
    commentList: make('commentList'),
    commentAdd: make('commentAdd'),
    chatJoin: make('chatJoin'),
    chatSend: make('chatSend'),
    chatRead: make('chatRead'),
    dmStart: make('dmStart'),
    dmList: make('dmList'),
    dmSend: make('dmSend'),
    dmRead: make('dmRead'),
    profileGet: make('profileGet'),
    profileSetNickname: make('profileSetNickname'),
    apiKeyCreate: make('apiKeyCreate'),
    apiKeyList: make('apiKeyList'),
    apiKeyRevoke: make('apiKeyRevoke'),
  } as unknown as Commands;
  const out: string[] = [];
  const factory = (config: CommandConfig) => {
    lastConfig = config;
    return Promise.resolve(cmds);
  };
  const program = buildProgram(factory, (s) => out.push(s));
  const parse = (args: string[]) => program.parseAsync(['node', 'openstoa', ...args]);
  return { parse, calls, out, config: () => lastConfig };
}

describe('CLI dispatch', () => {
  it('topics list → topicsList()', async () => {
    const h = harness({ topicsList: () => [{ id: 't1', title: 'Hello', visibility: 'public' }] });
    await h.parse(['topics', 'list']);
    expect(h.calls.find((c) => c.method === 'topicsList')).toBeTruthy();
    expect(h.out.join('\n')).toContain('t1');
  });

  it('topics create passes parsed flags through', async () => {
    const h = harness({ topicCreate: (input) => ({ id: 't9', ...(input as object) }) });
    await h.parse(['topics', 'create', '--title', 'My Topic', '--visibility', 'private', '--description', 'desc']);
    const call = h.calls.find((c) => c.method === 'topicCreate');
    expect(call?.args[0]).toMatchObject({ title: 'My Topic', visibility: 'private', description: 'desc' });
  });

  it('chat send joins words into one text arg', async () => {
    const h = harness({ chatSend: () => ({ messageId: 'm1' }) });
    await h.parse(['chat', 'send', 't1', 'hello', 'there', '안녕']);
    const call = h.calls.find((c) => c.method === 'chatSend');
    expect(call?.args).toEqual(['t1', 'hello there 안녕']);
    expect(h.out.join('\n')).toContain('m1');
  });

  it('chat read parses --limit as a number and forwards it', async () => {
    const h = harness({ chatRead: () => [] });
    await h.parse(['chat', 'read', 't1', '--limit', '5']);
    const call = h.calls.find((c) => c.method === 'chatRead');
    expect(call?.args).toEqual(['t1', { limit: 5, since: undefined, before: undefined }]);
  });

  // ── dm ────────────────────────────────────────────────────────────────────
  it('dm start <userId> → dmStart(userId)', async () => {
    const h = harness({ dmStart: (userId) => ({ topicId: `dm-${userId}` }) });
    await h.parse(['dm', 'start', 'bob']);
    expect(h.calls.find((c) => c.method === 'dmStart')?.args).toEqual(['bob']);
    expect(h.out.join('\n')).toContain('dm-bob');
  });

  it('dm list → dmList() and formats peers', async () => {
    const h = harness({ dmList: () => [{ topicId: 't1', peer: { userId: 'bob', nickname: 'bob', profileImage: null }, lastActivityAt: null }] });
    await h.parse(['dm', 'list']);
    expect(h.calls.some((c) => c.method === 'dmList')).toBe(true);
    expect(h.out.join('\n')).toContain('bob');
  });

  it('dm send joins words into one text arg', async () => {
    const h = harness({ dmSend: () => ({ messageId: 'm1' }) });
    await h.parse(['dm', 'send', 't1', 'hello', '안녕']);
    expect(h.calls.find((c) => c.method === 'dmSend')?.args).toEqual(['t1', 'hello 안녕']);
    expect(h.out.join('\n')).toContain('m1');
  });

  it('dm read parses --limit and forwards it', async () => {
    const h = harness({ dmRead: () => [] });
    await h.parse(['dm', 'read', 't1', '--limit', '5']);
    expect(h.calls.find((c) => c.method === 'dmRead')?.args).toEqual(['t1', { limit: 5, since: undefined, before: undefined }]);
  });

  it('--json emits the raw structured result', async () => {
    const h = harness({ topicGet: (id) => ({ id, title: 'X' }) });
    await h.parse(['--json', 'topics', 'get', 't1']);
    expect(JSON.parse(h.out[0])).toEqual({ id: 't1', title: 'X' });
  });

  it('global flags feed the Commands config', async () => {
    const h = harness({ whoami: () => ({ userId: 'u', nickname: 'n' }) });
    await h.parse(['--base-url', 'http://x:3200', '--vault-root', '/tmp/v', '--keystore', 'vault', 'whoami']);
    expect(h.config()).toEqual({ baseUrl: 'http://x:3200', vaultRoot: '/tmp/v', backend: 'vault', deviceId: undefined, apiKey: undefined });
  });

  it('--api-key feeds the Commands config (skips interactive login)', async () => {
    const h = harness({ whoami: () => ({ userId: 'u', nickname: 'n', isAI: true }) });
    await h.parse(['--api-key', 'osk_scopedkey', 'whoami']);
    expect(h.config()).toMatchObject({ apiKey: 'osk_scopedkey' });
  });

  it('login --token dispatches with the token', async () => {
    const h = harness({ login: () => ({ userId: 'u', nickname: 'n', isAI: true }) });
    await h.parse(['login', '--token', 'JWT123']);
    const call = h.calls.find((c) => c.method === 'login');
    expect(call?.args[0]).toEqual({ nickname: undefined, token: 'JWT123' });
    expect(h.out.join('\n')).toContain('[AI]');
  });

  it('comment add joins the text words', async () => {
    const h = harness({ commentAdd: () => ({ id: 'c1', authorId: 'a', content: 'nice one' }) });
    await h.parse(['comment', 'add', 'p1', 'nice', 'one']);
    expect(h.calls.find((c) => c.method === 'commentAdd')?.args).toEqual(['p1', 'nice one']);
  });

  // ── API keys ────────────────────────────────────────────────────────────
  it('apikey create parses --cmd into an array and forwards --history-grant', async () => {
    const h = harness({
      apiKeyCreate: (input) => ({ rawKey: 'osk_new', key: { id: 'k1', ...(input as object) } }),
    });
    await h.parse(['apikey', 'create', '--name', 'laptop', '--cmd', '/openstoa/chat/read, /openstoa/post/write', '--history-grant', '7d']);
    const call = h.calls.find((c) => c.method === 'apiKeyCreate');
    expect(call?.args[0]).toMatchObject({
      name: 'laptop',
      cmd: ['/openstoa/chat/read', '/openstoa/post/write'],
      historyGrant: '7d',
      isAI: true,
    });
    expect(h.out.join('\n')).toContain('osk_new');
  });
  it('apikey create defaults cmd to [] and historyGrant to none when omitted', async () => {
    const h = harness({ apiKeyCreate: (input) => ({ rawKey: 'osk_new', key: { id: 'k1', ...(input as object) } }) });
    await h.parse(['apikey', 'create', '--name', 'bare']);
    const call = h.calls.find((c) => c.method === 'apiKeyCreate');
    expect(call?.args[0]).toMatchObject({ name: 'bare', cmd: [], historyGrant: 'none', isAI: true });
  });
  it('apikey create --no-ai sets isAI:false', async () => {
    const h = harness({ apiKeyCreate: (input) => ({ rawKey: 'osk_new', key: { id: 'k1', ...(input as object) } }) });
    await h.parse(['apikey', 'create', '--name', 'human-key', '--no-ai']);
    const call = h.calls.find((c) => c.method === 'apiKeyCreate');
    expect(call?.args[0]).toMatchObject({ isAI: false });
  });
  it('apikey list → apiKeyList()', async () => {
    const h = harness({ apiKeyList: () => [{ id: 'k1', name: 'laptop', prefix: 'osk_aaaa1234', isAI: true, cmd: [], historyGrant: 'none' }] });
    await h.parse(['apikey', 'list']);
    expect(h.calls.some((c) => c.method === 'apiKeyList')).toBe(true);
    expect(h.out.join('\n')).toContain('laptop');
  });
  it('apikey revoke <id> → apiKeyRevoke(id)', async () => {
    const h = harness({ apiKeyRevoke: (id) => ({ revoked: true, id }) });
    await h.parse(['apikey', 'revoke', 'k1']);
    expect(h.calls.find((c) => c.method === 'apiKeyRevoke')?.args).toEqual(['k1']);
    expect(h.out.join('\n')).toContain('k1');
  });
});
