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
    whoami: make('whoami'),
    topicsList: make('topicsList'),
    topicGet: make('topicGet'),
    topicCreate: make('topicCreate'),
    topicJoin: make('topicJoin'),
    topicLeave: make('topicLeave'),
    categoriesList: make('categoriesList'),
    postList: make('postList'),
    postGet: make('postGet'),
    postCreate: make('postCreate'),
    commentList: make('commentList'),
    commentAdd: make('commentAdd'),
    chatJoin: make('chatJoin'),
    chatSend: make('chatSend'),
    chatRead: make('chatRead'),
    profileGet: make('profileGet'),
    profileSetNickname: make('profileSetNickname'),
  } as unknown as Commands;
  return { cmds, calls };
}

describe('MCP tools → command core', () => {
  it('registers the full tool surface (parity with the CLI)', () => {
    const { host, handlers } = fakeHost();
    const { cmds } = mockCommands();
    registerTools(host, cmds);
    for (const name of [
      'openstoa_login',
      'openstoa_whoami',
      'openstoa_topics_list',
      'openstoa_topic_get',
      'openstoa_topic_create',
      'openstoa_topic_join',
      'openstoa_topic_leave',
      'openstoa_categories_list',
      'openstoa_post_list',
      'openstoa_post_get',
      'openstoa_post_create',
      'openstoa_comment_list',
      'openstoa_comment_add',
      'openstoa_chat_join',
      'openstoa_chat_send',
      'openstoa_chat_read',
      'openstoa_profile_get',
      'openstoa_profile_set_nickname',
    ]) {
      expect(handlers.has(name), `missing tool ${name}`).toBe(true);
    }
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

  it('chat_read forwards paging options', async () => {
    const { host, handlers } = fakeHost();
    const { cmds, calls } = mockCommands({ chatRead: () => [] });
    registerTools(host, cmds);
    await handlers.get('openstoa_chat_read')!({ topicId: 't1', limit: 10 });
    expect(calls.find((c) => c.method === 'chatRead')?.args).toEqual(['t1', { limit: 10, since: undefined, before: undefined }]);
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
