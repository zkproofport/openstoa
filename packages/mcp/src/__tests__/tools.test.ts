/**
 * MCP tool-dispatch unit tests. A fake ToolHost captures every registered tool;
 * a mock Commands records dispatch. Verifies each tool calls the right command
 * with the right args, that results are JSON text, and that thrown errors become
 * isError results (never a crash, never a leaked stack). No transport, no network.
 */
import { describe, it, expect } from 'vitest';
import type { Commands } from '@masselabs/openstoa-commands';
import { registerTools, type ToolHost, type ToolResult } from '../tools';

function fakeHost() {
  const handlers = new Map<string, (a: Record<string, unknown>) => Promise<ToolResult>>();
  const host: ToolHost = {
    tool: (name, _desc, _schema, handler) => {
      handlers.set(name, handler);
    },
  };
  return { host, handlers };
}

function mockCommands(overrides: Record<string, (...a: unknown[]) => unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const make = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    const fn = overrides[method];
    if (fn) return Promise.resolve(fn(...args));
    return Promise.resolve({ ok: true });
  };
  const cmds = {
    login: make('login'),
    authenticateGoogle: make('authenticateGoogle'),
    whoami: make('whoami'),
    topicsList: make('topicsList'),
    topicGet: make('topicGet'),
    topicCreate: make('topicCreate'),
    topicJoin: make('topicJoin'),
    topicLeave: make('topicLeave'),
    topicUpdate: make('topicUpdate'),
    topicMembers: make('topicMembers'),
    categoriesList: make('categoriesList'),
    postList: make('postList'),
    postGet: make('postGet'),
    postCreate: make('postCreate'),
    postUpdate: make('postUpdate'),
    postDelete: make('postDelete'),
    commentList: make('commentList'),
    commentAdd: make('commentAdd'),
    commentDelete: make('commentDelete'),
    uploadImage: make('uploadImage'),
    chatJoin: make('chatJoin'),
    chatSend: make('chatSend'),
    chatRead: make('chatRead'),
    dmStart: make('dmStart'),
    dmList: make('dmList'),
    profileGet: make('profileGet'),
    profileSetNickname: make('profileSetNickname'),
    apiKeyCreate: make('apiKeyCreate'),
    apiKeyList: make('apiKeyList'),
    apiKeyRevoke: make('apiKeyRevoke'),
  } as unknown as Commands;
  return { cmds, calls };
}

describe('MCP tools → command core', () => {
  it('registers the full tool surface (parity with the CLI)', () => {
    const { host, handlers } = fakeHost();
    const { cmds } = mockCommands();
    registerTools(host, cmds);
    for (const name of [
      'openstoa_authenticate',
      'openstoa_login',
      'openstoa_whoami',
      'openstoa_topics_list',
      'openstoa_topic_get',
      'openstoa_topic_create',
      'openstoa_topic_join',
      'openstoa_topic_leave',
      'openstoa_topic_update',
      'openstoa_topic_members',
      'openstoa_categories_list',
      'openstoa_post_list',
      'openstoa_post_get',
      'openstoa_post_create',
      'openstoa_post_update',
      'openstoa_post_delete',
      'openstoa_comment_list',
      'openstoa_comment_add',
      'openstoa_comment_delete',
      'openstoa_upload_image',
      'openstoa_chat_join',
      'openstoa_chat_send',
      'openstoa_chat_read',
      'openstoa_dm_start',
      'openstoa_dm_list',
      'openstoa_profile_get',
      'openstoa_profile_set_nickname',
      'openstoa_apikey_create',
      'openstoa_apikey_list',
      'openstoa_apikey_revoke',
    ]) {
      expect(handlers.has(name), `missing tool ${name}`).toBe(true);
    }
  });

  it('openstoa_authenticate: 2-call pending → authenticated handshake (device-flow login)', async () => {
    const { host, handlers } = fakeHost();
    let call = 0;
    const { cmds, calls } = mockCommands({
      authenticateGoogle: () => {
        call += 1;
        return call === 1
          ? { status: 'pending_user_login', verificationUrl: 'https://google.com/device', userCode: 'ABCD-1234', instructions: 'open it' }
          : { status: 'authenticated', userId: '0xnull', nickname: 'anon_null', needsNickname: true, message: 'ok' };
      },
    });
    registerTools(host, cmds);
    const first = await handlers.get('openstoa_authenticate')!({});
    expect(JSON.parse(first.content[0].text)).toMatchObject({ status: 'pending_user_login', verificationUrl: 'https://google.com/device', userCode: 'ABCD-1234' });
    const second = await handlers.get('openstoa_authenticate')!({});
    expect(JSON.parse(second.content[0].text)).toMatchObject({ status: 'authenticated', userId: '0xnull', needsNickname: true });
    expect(calls.filter((c) => c.method === 'authenticateGoogle')).toHaveLength(2);
  });

  it('openstoa_login is token-only (adopt external Bearer; dev-login not exposed)', async () => {
    const { host, handlers } = fakeHost();
    const { cmds, calls } = mockCommands({ login: () => ({ userId: 'u', nickname: 'n', isAI: true }) });
    registerTools(host, cmds);
    await handlers.get('openstoa_login')!({ token: 'JWT123' });
    expect(calls.find((c) => c.method === 'login')?.args).toEqual([{ token: 'JWT123' }]);
  });

  it('chat_send dispatches to commands.chatSend with the right args and returns JSON', async () => {
    const { host, handlers } = fakeHost();
    const { cmds, calls } = mockCommands({ chatSend: () => ({ messageId: 'm1' }) });
    registerTools(host, cmds);
    const res = await handlers.get('openstoa_chat_send')!({ topicId: 't1', text: '안녕 🔐' });
    expect(calls.find((c) => c.method === 'chatSend')?.args).toEqual(['t1', '안녕 🔐']);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toEqual({ messageId: 'm1' });
  });

  it('topic_create forwards all fields', async () => {
    const { host, handlers } = fakeHost();
    const { cmds, calls } = mockCommands({ topicCreate: (i) => ({ id: 't9', ...(i as object) }) });
    registerTools(host, cmds);
    await handlers.get('openstoa_topic_create')!({ title: 'T', visibility: 'private', categoryId: 'c1' });
    expect(calls.find((c) => c.method === 'topicCreate')?.args[0]).toMatchObject({ title: 'T', visibility: 'private', categoryId: 'c1' });
  });

  it('topic_join forwards proof + publicInputs for gated topics', async () => {
    const { host, handlers } = fakeHost();
    const { cmds, calls } = mockCommands({ topicJoin: () => ({ topicId: 't1', joined: true }) });
    registerTools(host, cmds);
    await handlers.get('openstoa_topic_join')!({ topicId: 't1', proof: '0xp', publicInputs: '0xi' });
    expect(calls.find((c) => c.method === 'topicJoin')?.args).toEqual(['t1', { proof: '0xp', publicInputs: '0xi' }]);
  });

  it('upload_image decodes base64 to bytes and forwards metadata', async () => {
    const { host, handlers } = fakeHost();
    const { cmds, calls } = mockCommands({ uploadImage: () => ({ publicUrl: 'https://cdn/x.png' }) });
    registerTools(host, cmds);
    const base64 = Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64');
    const res = await handlers.get('openstoa_upload_image')!({ base64, filename: 'x.png', contentType: 'image/png', purpose: 'post' });
    const arg = calls.find((c) => c.method === 'uploadImage')?.args[0] as { data: Uint8Array; filename: string; contentType: string; purpose: string };
    expect(arg.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(arg.data)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(arg).toMatchObject({ filename: 'x.png', contentType: 'image/png', purpose: 'post' });
    expect(JSON.parse(res.content[0].text).publicUrl).toBe('https://cdn/x.png');
  });

  it('post_delete / comment_delete dispatch with the right ids', async () => {
    const { host, handlers } = fakeHost();
    const { cmds, calls } = mockCommands();
    registerTools(host, cmds);
    await handlers.get('openstoa_post_delete')!({ postId: 'p1' });
    await handlers.get('openstoa_comment_delete')!({ commentId: 'c1' });
    expect(calls.find((c) => c.method === 'postDelete')?.args).toEqual(['p1']);
    expect(calls.find((c) => c.method === 'commentDelete')?.args).toEqual(['c1']);
  });

  it('chat_read forwards paging options', async () => {
    const { host, handlers } = fakeHost();
    const { cmds, calls } = mockCommands({ chatRead: () => [] });
    registerTools(host, cmds);
    await handlers.get('openstoa_chat_read')!({ topicId: 't1', limit: 10 });
    expect(calls.find((c) => c.method === 'chatRead')?.args).toEqual(['t1', { limit: 10, since: undefined, before: undefined }]);
  });

  it('dm_start dispatches to dmStart(userId); dm_list dispatches to dmList()', async () => {
    const { host, handlers } = fakeHost();
    const { cmds, calls } = mockCommands({
      dmStart: (userId) => ({ topicId: `dm-${userId}` }),
      dmList: () => [{ topicId: 't1', peer: { userId: 'bob', nickname: 'bob', profileImage: null }, lastActivityAt: null }],
    });
    registerTools(host, cmds);
    const started = await handlers.get('openstoa_dm_start')!({ userId: 'bob' });
    expect(calls.find((c) => c.method === 'dmStart')?.args).toEqual(['bob']);
    expect(JSON.parse(started.content[0].text)).toEqual({ topicId: 'dm-bob' });
    const listed = await handlers.get('openstoa_dm_list')!({});
    expect(calls.some((c) => c.method === 'dmList')).toBe(true);
    expect(JSON.parse(listed.content[0].text)[0].peer.nickname).toBe('bob');
  });

  it('apikey_create dispatches with defaults for cmd/historyGrant and returns { rawKey, key }', async () => {
    const { host, handlers } = fakeHost();
    const { cmds, calls } = mockCommands({ apiKeyCreate: (i) => ({ rawKey: 'osk_new', key: { id: 'k1', ...(i as object) } }) });
    registerTools(host, cmds);
    const res = await handlers.get('openstoa_apikey_create')!({ name: 'agent-key' });
    expect(calls.find((c) => c.method === 'apiKeyCreate')?.args[0]).toMatchObject({ name: 'agent-key', cmd: [], historyGrant: 'none' });
    expect(JSON.parse(res.content[0].text).rawKey).toBe('osk_new');
  });
  it('apikey_create forwards explicit cmd/historyGrant/isAI', async () => {
    const { host, handlers } = fakeHost();
    const { cmds, calls } = mockCommands({ apiKeyCreate: (i) => ({ rawKey: 'osk_new', key: { id: 'k1', ...(i as object) } }) });
    registerTools(host, cmds);
    await handlers.get('openstoa_apikey_create')!({ name: 'k', cmd: ['/openstoa/chat/read'], historyGrant: '7d', isAI: false });
    expect(calls.find((c) => c.method === 'apiKeyCreate')?.args[0]).toMatchObject({ name: 'k', cmd: ['/openstoa/chat/read'], historyGrant: '7d', isAI: false });
  });
  it('apikey_list / apikey_revoke dispatch correctly', async () => {
    const { host, handlers } = fakeHost();
    const { cmds, calls } = mockCommands({ apiKeyList: () => [{ id: 'k1' }], apiKeyRevoke: (id) => ({ revoked: true, id }) });
    registerTools(host, cmds);
    await handlers.get('openstoa_apikey_list')!({});
    await handlers.get('openstoa_apikey_revoke')!({ id: 'k1' });
    expect(calls.find((c) => c.method === 'apiKeyList')).toBeTruthy();
    expect(calls.find((c) => c.method === 'apiKeyRevoke')?.args).toEqual(['k1']);
  });

  it('a thrown command error becomes an isError result, not a crash', async () => {
    const { host, handlers } = fakeHost();
    const { cmds } = mockCommands({
      chatSend: () => {
        throw new Error('Not logged in — run `openstoa login` first.');
      },
    });
    registerTools(host, cmds);
    const res = await handlers.get('openstoa_chat_send')!({ topicId: 't1', text: 'x' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toMatch(/Not logged in/);
  });
});
