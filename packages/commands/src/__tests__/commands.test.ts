/**
 * Commands unit tests. A fake ChatClient records every SDK call so a future
 * rewiring (removing an SDK call, changing args) is caught here. Also covers the
 * auth guard, empty-input rejection, and session persistence contract.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ChatClient } from '@masselabs/openstoa';
import { Commands } from '../commands';
import { MemorySessionStore, type SessionData } from '../session';

interface Rec {
  method: string;
  args: unknown[];
}

function makeChat(overrides: Record<string, (...a: unknown[]) => unknown> = {}) {
  const calls: Rec[] = [];
  let token: string | null = 'seed-token';
  const rec = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    const fn = overrides[method];
    return Promise.resolve(fn ? fn(...args) : undefined);
  };
  const chat = {
    login: rec('login'),
    useToken: (t: string) => {
      calls.push({ method: 'useToken', args: [t] });
      token = t;
    },
    joinTopic: rec('joinTopic'),
    sendChat: rec('sendChat'),
    readChat: rec('readChat'),
    getDeviceId: rec('getDeviceId'),
    rest: {
      getToken: () => token,
      setToken: (t: string) => {
        token = t;
      },
      request: rec('request'),
      auth: { session: rec('auth.session') },
      categories: { list: rec('categories.list') },
      topics: {
        list: rec('topics.list'),
        get: rec('topics.get'),
        create: rec('topics.create'),
        update: rec('topics.update'),
        members: rec('topics.members'),
        posts: rec('topics.posts'),
        createPost: rec('topics.createPost'),
        removeMember: rec('topics.removeMember'),
      },
      posts: {
        getWithComments: rec('posts.getWithComments'),
        comments: rec('posts.comments'),
        addComment: rec('posts.addComment'),
        update: rec('posts.update'),
        remove: rec('posts.remove'),
      },
      comments: { remove: rec('comments.remove') },
      profile: { setNickname: rec('profile.setNickname') },
      uploads: { image: rec('uploads.image') },
      apiKeys: {
        create: rec('apiKeys.create'),
        list: rec('apiKeys.list'),
        revoke: rec('apiKeys.revoke'),
      },
    },
  };
  return { chat: chat as unknown as ChatClient, calls, setToken: (t: string | null) => (token = t) };
}

function build(overrides = {}, session: SessionData | null = { baseUrl: 'http://h', token: 'seed-token', userId: 'u1', nickname: 'n' }) {
  const { chat, calls, setToken } = makeChat(overrides);
  const store = new MemorySessionStore(session);
  const cmds = new Commands({ chat, sessionStore: store, baseUrl: 'http://h', session });
  return { cmds, calls, store, setToken };
}

describe('Commands dispatch → SDK', () => {
  it('login (dev-login) persists the token', async () => {
    const { cmds, calls, store } = build({ login: () => ({ userId: 'u9', nickname: 'nn', token: 'TK' }) });
    const r = await cmds.login({ nickname: 'nn' });
    expect(calls.find((c) => c.method === 'login')?.args).toEqual(['nn']);
    expect(r).toEqual({ userId: 'u9', nickname: 'nn' });
    expect((await store.read())?.token).toBe('TK');
  });

  it('login --token adopts token and reads the session', async () => {
    const { cmds, calls, store } = build({ 'auth.session': () => ({ userId: 'ua', nickname: 'na', isAI: true }) });
    const r = await cmds.login({ token: 'AITOKEN' });
    expect(calls.find((c) => c.method === 'useToken')?.args).toEqual(['AITOKEN']);
    expect(r).toEqual({ userId: 'ua', nickname: 'na', isAI: true });
    expect((await store.read())?.token).toBe('AITOKEN');
  });

  it('topics: list/get/create/join dispatch with the right args', async () => {
    const { cmds, calls } = build({
      'topics.get': (id: unknown) => ({ id }),
      'topics.create': (input: unknown) => ({ id: 't1', ...(input as object) }),
    });
    await cmds.topicsList();
    await cmds.topicGet('t7');
    await cmds.topicCreate({ title: 'Hi', visibility: 'public' });
    await cmds.topicJoin('t7');
    expect(calls.map((c) => c.method)).toEqual(
      expect.arrayContaining(['topics.list', 'topics.get', 'topics.create', 'joinTopic']),
    );
    expect(calls.find((c) => c.method === 'topics.get')?.args).toEqual(['t7']);
    expect(calls.find((c) => c.method === 'joinTopic')?.args).toEqual(['t7']);
  });

  it('leave removes the current user (server enforces the self-removal policy)', async () => {
    const { cmds, calls } = build();
    await cmds.topicLeave('t7');
    expect(calls.find((c) => c.method === 'topics.removeMember')?.args).toEqual(['t7', 'u1']);
  });

  it('topic update / members dispatch with the right args', async () => {
    const { cmds, calls } = build({ 'topics.update': (id: unknown, patch: unknown) => ({ id, ...(patch as object) }), 'topics.members': () => [{ userId: 'u1' }] });
    await cmds.topicUpdate('t7', { title: 'New', visibility: 'private' });
    await cmds.topicMembers('t7');
    expect(calls.find((c) => c.method === 'topics.update')?.args).toEqual(['t7', { title: 'New', visibility: 'private' }]);
    expect(calls.find((c) => c.method === 'topics.members')?.args).toEqual(['t7']);
  });

  it('topicJoin with proof submits proof to the join route, then MLS self-joins on 201', async () => {
    const { cmds, calls } = build({
      request: () => ({ status: 201, json: async () => ({ success: true }) }),
    });
    const r = await cmds.topicJoin('t7', { proof: '0xproof', publicInputs: '0xpub' });
    const req = calls.find((c) => c.method === 'request');
    expect(req?.args[0]).toBe('/api/topics/t7/join');
    expect(req?.args[1]).toMatchObject({ method: 'POST', raw: true, body: { proof: '0xproof', publicInputs: '0xpub' } });
    // 201 → MLS self-join runs.
    expect(calls.some((c) => c.method === 'joinTopic')).toBe(true);
    expect(r).toEqual({ topicId: 't7', joined: true });
  });

  it('topicJoin with proof returns pending on 202 and does NOT MLS-join', async () => {
    const { cmds, calls } = build({
      request: () => ({ status: 202, json: async () => ({ message: 'Join request submitted' }) }),
    });
    const r = await cmds.topicJoin('t7', { proof: '0xproof', publicInputs: '0xpub' });
    expect(calls.some((c) => c.method === 'joinTopic')).toBe(false);
    expect(r).toEqual({ topicId: 't7', joined: false, pending: true, message: 'Join request submitted' });
  });

  it('topicJoin with proof throws the server error on 402/403', async () => {
    const { cmds } = build({
      request: () => ({ status: 402, json: async () => ({ error: 'Proof required', requiredProofType: 'kyc' }) }),
    });
    await expect(cmds.topicJoin('t7', { proof: '0xp', publicInputs: '0xi' })).rejects.toThrow(/Proof required/);
  });

  it('topicJoin rejects a proof without publicInputs (and vice-versa) before any request', async () => {
    const { cmds, calls } = build();
    await expect(cmds.topicJoin('t7', { proof: '0xp' })).rejects.toThrow(/publicInputs is required/);
    await expect(cmds.topicJoin('t7', { publicInputs: '0xi' })).rejects.toThrow(/proof is required/);
    expect(calls.some((c) => c.method === 'request')).toBe(false);
  });

  it('post update / delete + comment delete dispatch', async () => {
    const { cmds, calls } = build({ 'posts.remove': (id: unknown) => ({ id, isDeleted: true }) });
    await cmds.postUpdate('p1', { title: 'T2', tags: ['a'] });
    await cmds.postDelete('p1');
    await cmds.commentDelete('c1');
    expect(calls.find((c) => c.method === 'posts.update')?.args).toEqual(['p1', { title: 'T2', tags: ['a'] }]);
    expect(calls.find((c) => c.method === 'posts.remove')?.args).toEqual(['p1']);
    expect(calls.find((c) => c.method === 'comments.remove')?.args).toEqual(['c1']);
  });

  it('commentDelete rejects an empty commentId before any dispatch', async () => {
    const { cmds, calls } = build();
    await expect(cmds.commentDelete('  ')).rejects.toThrow(/commentId is required/);
    expect(calls.some((c) => c.method === 'comments.remove')).toBe(false);
  });

  it('uploadImage forwards bytes to uploads.image and returns the publicUrl', async () => {
    const { cmds, calls } = build({ 'uploads.image': (i: unknown) => ({ publicUrl: 'https://cdn/x.png', echo: i }) });
    const data = new Uint8Array([1, 2, 3]);
    const r = await cmds.uploadImage({ data, filename: 'x.png', contentType: 'image/png', purpose: 'post' });
    expect(calls.find((c) => c.method === 'uploads.image')?.args[0]).toMatchObject({ filename: 'x.png', contentType: 'image/png', purpose: 'post' });
    expect(r.publicUrl).toBe('https://cdn/x.png');
  });

  it('uploadImage rejects non-image content type, empty data, empty filename, and >10MB before dispatch', async () => {
    const { cmds, calls } = build();
    await expect(cmds.uploadImage({ data: new Uint8Array([1]), filename: 'x.pdf', contentType: 'application/pdf' })).rejects.toThrow(/only image/);
    await expect(cmds.uploadImage({ data: new Uint8Array([]), filename: 'x.png', contentType: 'image/png' })).rejects.toThrow(/data is empty/);
    await expect(cmds.uploadImage({ data: new Uint8Array([1]), filename: '  ', contentType: 'image/png' })).rejects.toThrow(/filename is required/);
    await expect(cmds.uploadImage({ data: new Uint8Array(10 * 1024 * 1024 + 1), filename: 'big.png', contentType: 'image/png' })).rejects.toThrow(/10MB/);
    expect(calls.some((c) => c.method === 'uploads.image')).toBe(false);
  });

  it('posts + comments dispatch', async () => {
    const { cmds, calls } = build();
    await cmds.postList('t1');
    await cmds.postGet('p1');
    await cmds.postCreate('t1', { title: 'T', content: 'C' });
    await cmds.commentList('p1');
    await cmds.commentAdd('p1', 'hey');
    expect(calls.find((c) => c.method === 'topics.posts')?.args).toEqual(['t1']);
    expect(calls.find((c) => c.method === 'posts.getWithComments')?.args).toEqual(['p1']);
    expect(calls.find((c) => c.method === 'topics.createPost')?.args).toEqual(['t1', { title: 'T', content: 'C' }]);
    expect(calls.find((c) => c.method === 'posts.addComment')?.args).toEqual(['p1', 'hey']);
  });

  it('chat send joins first, then seals — and returns the message id', async () => {
    const { cmds, calls } = build({ sendChat: () => 'msg-123' });
    const r = await cmds.chatSend('t1', 'hello');
    const order = calls.map((c) => c.method).filter((m) => m === 'joinTopic' || m === 'sendChat');
    expect(order).toEqual(['joinTopic', 'sendChat']);
    expect(calls.find((c) => c.method === 'sendChat')?.args).toEqual(['t1', 'hello']);
    expect(r).toEqual({ messageId: 'msg-123' });
  });

  it('chat read joins first, then reads', async () => {
    const { cmds, calls } = build({ readChat: () => [] });
    await cmds.chatRead('t1', { limit: 5 });
    const order = calls.map((c) => c.method).filter((m) => m === 'joinTopic' || m === 'readChat');
    expect(order).toEqual(['joinTopic', 'readChat']);
    expect(calls.find((c) => c.method === 'readChat')?.args).toEqual(['t1', { limit: 5 }]);
  });

  it('profile set-nickname dispatches + persists', async () => {
    const { cmds, calls, store } = build({ 'profile.setNickname': (n: unknown) => ({ nickname: n }) });
    await cmds.profileSetNickname('newnick');
    expect(calls.find((c) => c.method === 'profile.setNickname')?.args).toEqual(['newnick']);
    expect((await store.read())?.nickname).toBe('newnick');
  });

  // ── edge cases ────────────────────────────────────────────────────────────
  it('rejects empty / whitespace chat text before any send', async () => {
    const { cmds, calls } = build();
    await expect(cmds.chatSend('t1', '')).rejects.toThrow(/text is required/);
    await expect(cmds.chatSend('t1', '   ')).rejects.toThrow(/text is required/);
    expect(calls.some((c) => c.method === 'sendChat')).toBe(false);
  });

  it('rejects empty comment and empty nickname', async () => {
    const { cmds } = build();
    await expect(cmds.commentAdd('p1', '  ')).rejects.toThrow(/content is required/);
    await expect(cmds.profileSetNickname('')).rejects.toThrow(/nickname is required/);
  });

  it('all authed ops throw a clear error when no token is set', async () => {
    const { cmds, setToken } = build({}, null);
    setToken(null);
    await expect(cmds.topicsList()).rejects.toThrow(/Not logged in/);
    await expect(cmds.chatRead('t1')).rejects.toThrow(/Not logged in/);
  });

  it('UTF-8 (Korean + emoji) text passes through untouched to sendChat', async () => {
    const spy = vi.fn(() => 'm1');
    const { cmds, calls } = build({ sendChat: spy });
    const probe = '안녕 🔐 test';
    await cmds.chatSend('t1', probe);
    expect(calls.find((c) => c.method === 'sendChat')?.args).toEqual(['t1', probe]);
  });

  // ── API keys (design §7 follow-up) ───────────────────────────────────────
  it('apiKeyCreate dispatches with the input and returns the SDK result verbatim', async () => {
    const { cmds, calls } = build({
      'apiKeys.create': (input: unknown) => ({ rawKey: 'osk_new', key: { id: 'k1', ...(input as object) } }),
    });
    const r = await cmds.apiKeyCreate({ name: 'laptop', cmd: ['/openstoa/chat/read'], historyGrant: 'none' });
    expect(calls.find((c) => c.method === 'apiKeys.create')?.args).toEqual([{ name: 'laptop', cmd: ['/openstoa/chat/read'], historyGrant: 'none' }]);
    expect(r.rawKey).toBe('osk_new');
  });
  it('apiKeyCreate rejects an empty/whitespace name before any dispatch', async () => {
    const { cmds, calls } = build();
    await expect(cmds.apiKeyCreate({ name: '', cmd: [], historyGrant: 'none' })).rejects.toThrow(/name is required/);
    await expect(cmds.apiKeyCreate({ name: '   ', cmd: [], historyGrant: 'none' })).rejects.toThrow(/name is required/);
    expect(calls.some((c) => c.method === 'apiKeys.create')).toBe(false);
  });
  it('apiKeyList dispatches with no args', async () => {
    const { cmds, calls } = build({ 'apiKeys.list': () => [{ id: 'k1' }] });
    const r = await cmds.apiKeyList();
    expect(calls.find((c) => c.method === 'apiKeys.list')?.args).toEqual([]);
    expect(r).toEqual([{ id: 'k1' }]);
  });
  it('apiKeyRevoke dispatches with the id', async () => {
    const { cmds, calls } = build({ 'apiKeys.revoke': (id: unknown) => ({ revoked: true, id }) });
    const r = await cmds.apiKeyRevoke('k1');
    expect(calls.find((c) => c.method === 'apiKeys.revoke')?.args).toEqual(['k1']);
    expect(r).toEqual({ revoked: true, id: 'k1' });
  });
  it('apiKeyRevoke rejects an empty id before any dispatch', async () => {
    const { cmds, calls } = build();
    await expect(cmds.apiKeyRevoke('')).rejects.toThrow(/id is required/);
    expect(calls.some((c) => c.method === 'apiKeys.revoke')).toBe(false);
  });
  it('apiKey ops throw "Not logged in" when no token is set (same guard as every other op)', async () => {
    const { cmds, setToken } = build({}, null);
    setToken(null);
    await expect(cmds.apiKeyList()).rejects.toThrow(/Not logged in/);
    await expect(cmds.apiKeyCreate({ name: 'k', cmd: [], historyGrant: 'none' })).rejects.toThrow(/Not logged in/);
  });
});
