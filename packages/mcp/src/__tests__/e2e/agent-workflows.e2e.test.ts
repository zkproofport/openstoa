/** Live stdio MCP, not handler mocks. API-key agents interoperate with the built
 * CLI and prove decryption. Opt in only for the local stack via E2E_BASE_URL. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, LocalAgents, PNG, type Agent, type Row } from '../../../../cli/src/__tests__/e2e/agentHarness';
import { REST_OPERATIONS } from '../../../../sdk/src/rest/operations';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/server.js');
const local = new LocalAgents();
const clients: Client[] = [];
const invokedTools = new Set<string>();
let registeredTools: string[] = [];
let a: Agent;
let b: Agent;
let client: Client;
let topicId: string;
let postId: string;
const marker = `MCP↔CLI 한국어 암호화 검증 🔐 ${Date.now()}`;

async function connect(agent: Agent): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: local.env(agent), stderr: 'pipe' });
  transport.stderr?.on('data', () => {}); // Drain SDK diagnostics; never print credentials.
  const mcp = new Client({ name: 'openstoa-local-e2e', version: '1.0.0' });
  await mcp.connect(transport);
  clients.push(mcp);
  return mcp;
}
async function result(mcp: Client, name: string, args: Row = {}): Promise<{ data: any; isError: boolean }> {
  invokedTools.add(name);
  const res = await mcp.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }>;
  const text = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  return { data, isError: res.isError === true };
}
async function call<T = Row>(name: string, args: Row = {}): Promise<T> {
  const res = await result(client, name, args);
  if (res.isError) throw new Error(local.redact(`MCP ${name}: ${JSON.stringify(res.data)}`));
  return res.data as T;
}

describe.skipIf(!BASE).sequential('API-key MCP stdio + CLI interoperability (local stack)', () => {
  beforeAll(async () => {
    await local.ready();
    await fs.access(SERVER);
    a = await local.agent(await local.owner('cross_cli'));
    b = await local.agent(await local.owner('cross_mcp'));
    client = await connect(b);
  });
  afterAll(async () => {
    for (const c of clients.reverse()) await c.close();
    await local.dispose();
    expect(registeredTools.filter(name => !invokedTools.has(name)), 'Every registered MCP tool must have a live invocation').toEqual([]);
  });

  it('lists callable schemas and uses the matching login session and permission key', async () => {
    const catalogue = await client.listTools();
    registeredTools = catalogue.tools.map(tool => tool.name);
    expect(registeredTools).toHaveLength(89);
    const tools = new Map(catalogue.tools.map(t => [t.name, t]));
    for (const name of ['openstoa_whoami', 'openstoa_categories_list', 'openstoa_chat_send', 'openstoa_chat_read', 'openstoa_chat_send_media', 'openstoa_dm_start', 'openstoa_apikey_list']) expect(tools.has(name), name).toBe(true);
    for (const operation of REST_OPERATIONS) expect(tools.has(operation.tool), operation.tool).toBe(true);
    expect(tools.get('openstoa_chat_send')?.inputSchema.required).toEqual(expect.arrayContaining(['topicId', 'text']));
    expect(tools.has('openstoa_authenticate')).toBe(true);
    const session = await call('openstoa_whoami');
    expect(session.userId).toBe(b.owner.userId);
    expect(session.isAI).toBe(true);
  });

  it('exposes app login through a fresh unauthenticated MCP process', async () => {
    const anonymous = await connect({ ...b, apiKey: '', root: path.join(b.root, 'anonymous-login') });
    const consent = await result(anonymous, 'openstoa_authenticate');
    expect(consent.isError).toBe(false); expect((consent.data as Row).status).toBe('consent_required');
    const started = await result(anonymous, 'openstoa_authenticate', { method: 'app', approved: true });
    expect(started.isError).toBe(false); const pending = started.data as Row;
    expect(pending.status).toBe('pending'); expect(pending).not.toHaveProperty('token');
    const polled = await result(anonymous, 'openstoa_authenticate', { operationId: pending.operationId });
    expect((polled.data as Row).status).toBe('pending');
    const cancelled = await result(anonymous, 'openstoa_authenticate', { operationId: pending.operationId, cancel: true });
    expect((cancelled.data as Row).status).toBe('cancelled');
    expect(((await result(anonymous, 'openstoa_whoami')).data as Row).status).toBe('authentication_required');
  });

  it('requires explicit login consent and exposes pending/poll/cancel without returning credentials', async () => {
    expect((await call('openstoa_authenticate')).status).toBe('consent_required');
    const pending = await call('openstoa_authenticate', { method: 'app', approved: true });
    expect(pending.status).toBe('pending');
    expect(new URL(pending.browserUrl).origin).toBe(new URL(BASE!).origin);
    expect(new URL(pending.browserUrl).hash).toContain('approvalToken=');
    expect(pending).not.toHaveProperty('token'); expect(pending).not.toHaveProperty('codeVerifier');
    expect((await call('openstoa_authenticate', { operationId: pending.operationId })).status).toBe('pending');
    expect((await call('openstoa_authenticate', { operationId: pending.operationId, cancel: true })).status).toBe('cancelled');
    expect((await call('openstoa_whoami')).userId).toBe(b.owner.userId);
  });

  it('creates a topic over MCP and performs post/comment CRUD through stdio', async () => {
    const categories = await call<Row[]>('openstoa_categories_list');
    const topic = await call('openstoa_topic_create', { title: marker, description: 'MCP 로컬 검증', visibility: 'public', proofType: 'none', categoryId: categories[0].id });
    topicId = topic.id;
    expect((await call('openstoa_topic_get', { topicId })).title).toBe(marker);
    expect((await call<Row[]>('openstoa_topics_list')).some(t => t.id === topicId)).toBe(true);
    await local.cli(a, ['topics', 'join', topicId]);
    const post = await call('openstoa_post_create', { topicId, title: marker, content: 'MCP 첫 게시물 📝', tags: ['mcp', '검증'] });
    postId = post.id;
    await call('openstoa_post_update', { postId, content: '수정된 MCP 본문' });
    expect((await local.cli(a, ['post', 'get', postId])).post.content).toBe('수정된 MCP 본문');
    const comment = await call('openstoa_comment_add', { postId, content: 'MCP 댓글' });
    expect((await call<Row[]>('openstoa_comment_list', { postId })).find(c => c.id === comment.id)?.content).toBe('MCP 댓글');
    expect((await call('openstoa_comment_delete', { commentId: comment.id })).deleted).toBe(true);
  });

  it('requires explicit proof consent over MCP and exposes real relay pending/status/resume/cancel', async () => {
    const categories = await call<Row[]>('openstoa_categories_list');
    const title = `MCP proof continuation ${marker}`;
    const required = await call('openstoa_topic_create', {title, proofType:'kyc', categoryId:categories[0].id});
    expect(required.status).toBe('proof_required');
    expect(required.requirement.type).toBe('kyc');
    const operationId = required.operationId;
    const refused = await result(client, 'openstoa_proof_continue', {operationId, method:'app', approved:false});
    expect(refused.isError).toBe(true);
    expect((await call('openstoa_proof_status', {operationId})).status).toBe('proof_required');
    const pending = await call('openstoa_proof_continue', {operationId, method:'app', approved:true});
    expect(pending.status).toBe('pending');
    expect(pending.deepLink).toMatch(/^zkproofport:\/\/proof-request\?/);
    expect(new URL(pending.browserUrl).origin).toBe(new URL(BASE!).origin);
    expect(new URL(pending.browserUrl).hash).not.toBe('');
    expect((await call('openstoa_proof_status', {operationId})).status).toBe('pending');
    expect((await call('openstoa_proof_resume', {operationId})).status).toBe('pending');
    expect((await call('openstoa_proof_cancel', {operationId})).status).toBe('cancelled');
    expect((await call('openstoa_proof_resume', {operationId})).status).toBe('cancelled');
    expect((await call<Row[]>('openstoa_topics_list', {q:title})).some(row => row.title === title)).toBe(false);
  });

  it('starts a required app proof directly from tool options only with explicit consent', async () => {
    const categories = await call<Row[]>('openstoa_categories_list');
    const title = `MCP direct proof ${marker}`;
    const input = {title, proofType:'kyc', categoryId:categories[0].id, method:'app'};
    const required = await call('openstoa_topic_create', input);
    expect(required.status).toBe('proof_required');
    expect(required).not.toHaveProperty('browserUrl');
    expect(required).not.toHaveProperty('deepLink');
    expect((await call('openstoa_proof_cancel', {operationId:required.operationId})).status).toBe('cancelled');
    const pending = await call('openstoa_topic_create', {...input, approved:true});
    const operationId = pending.operationId;
    try {
      expect(pending.status).toBe('pending');
      expect(pending.method).toBe('app');
      expect(pending.deepLink).toMatch(/^zkproofport:\/\/proof-request\?/);
      const browser = new URL(pending.browserUrl);
      expect(browser.origin).toBe(new URL(BASE!).origin);
      expect(browser.pathname).toBe('/proof');
      expect(browser.hash).not.toBe('');
      expect(JSON.stringify(pending)).not.toContain(b.apiKey);
      expect(JSON.stringify(pending)).not.toContain(b.sessionToken);
      expect((await call('openstoa_proof_status', {operationId})).status).toBe('pending');
      expect((await call('openstoa_proof_resume', {operationId})).status).toBe('pending');
    } finally {
      expect((await call('openstoa_proof_cancel', {operationId})).status).toBe('cancelled');
    }
    expect((await call('openstoa_proof_resume', {operationId})).status).toBe('cancelled');
    expect((await call<Row[]>('openstoa_topics_list', {q:title})).some(row => row.title === title)).toBe(false);
  });

  it('decrypts CLI → MCP and MCP → CLI text, preserving newlines and UTF-8', async () => {
    await local.cli(a, ['chat', 'join', topicId]);
    await call('openstoa_chat_join', { topicId });
    const cliSent = await local.cli(a, ['chat', 'send', topicId, `${marker}\nCLI에서 보냄`]);
    expect((await call<Row[]>('openstoa_chat_read', { topicId })).find(m => m.id === cliSent.messageId)?.text).toBe(`${marker}\nCLI에서 보냄`);
    const mcpSent = await call('openstoa_chat_send', { topicId, text: `${marker}\nMCP에서 보냄` });
    expect((await local.cli<Row[]>(a, ['chat', 'read', topicId])).find(m => m.id === mcpSent.messageId)?.text).toBe(`${marker}\nMCP에서 보냄`);
    expect((await call<Row[]>('openstoa_chat_history', { topicId })).find(m => m.messageId === mcpSent.messageId)?.plaintext).toBe(`${marker}\nMCP에서 보냄`);
    expect((await call('openstoa_chat_share_keys', { topicId })).shared).toBeGreaterThanOrEqual(0);
    const raw = await local.request(b.apiKey, `/api/topics/${topicId}/chat`);
    expect(raw.status, JSON.stringify(raw.body)).toBe(200);
    const stored = raw.body.messages.find((m: Row) => m.id === mcpSent.messageId);
    expect(stored.message).toBeNull();
    // Delivery acknowledgement may already purge the live ciphertext. The
    // archival copy remains encrypted and is what history successfully opened.
    const archive = await local.request(b.apiKey, `/api/topics/${topicId}/archive`);
    expect(archive.status, JSON.stringify(archive.body)).toBe(200);
    const archived = archive.body.archive.find((m: Row) => m.messageId === mcpSent.messageId);
    expect(archived.ciphertext).toBeTruthy();
    expect(JSON.stringify(archived)).not.toContain(marker);
    if (stored.sealed) expect(JSON.stringify(stored.sealed)).not.toContain(marker);
  });

  it('uploads a post image through MCP, preserves its media on readback, and serves the image bytes', async () => {
    const upload = await call('openstoa_upload_image', {
      base64: PNG.toString('base64'), filename: 'mcp-post.png', contentType: 'image/png', purpose: 'post', topicId,
    });
    expect(typeof upload.publicUrl).toBe('string');
    local.trackUpload(b, upload.publicUrl);
    const media = { images: [upload.publicUrl], imageAlts: { [upload.publicUrl]: 'MCP 이미지 설명 🖼️' } };
    const post = await call('openstoa_post_create', { topicId, title: 'MCP 첨부 이미지', content: '이미지가 있는 게시물', media });
    const readback = await call('openstoa_post_get', { postId: post.id });
    expect(readback.post.media).toEqual(media);
    expect((await local.cli(a, ['post', 'get', post.id])).post.media).toEqual(media);
    const feed = await call('openstoa_feed', { q: 'MCP 첨부 이미지' });
    expect(feed.posts.find((row: Row) => row.id === post.id)?.media).toEqual(media);
    const imageUrl = new URL(readback.post.media.images[0], BASE);
    const response = await fetch(imageUrl, {
      // Object-storage URLs need no credential; never forward the key off-origin.
      headers: imageUrl.origin === new URL(BASE!).origin ? local.authHeaders(a) : {},
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^image\/png(?:;|$)/);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    const guest = await fetch(imageUrl);
    expect(guest.status).toBe(200);
    expect(Buffer.from(await guest.arrayBuffer())).toEqual(PNG);
    const other = await connect(a);
    const denied = await result(other, 'openstoa_post_delete', { postId: post.id });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.data)).toMatch(/403|author|own/i);
    expect((await call('openstoa_post_get', { postId: post.id })).post.media).toEqual(media);
    expect((await call('openstoa_post_delete', { postId: post.id })).isDeleted).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['malformed', Buffer.from('not an image').toString('base64')],
  ])('rejects %s post-image data through MCP', async (_label, base64) => {
    const rejected = await result(client, 'openstoa_upload_image', { base64, filename: 'bad.png', contentType: 'image/png', purpose: 'post' });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.data)).toMatch(/400|image|empty/i);
  });

  it.each(['private', 'secret'])('keeps %s post-image reads within the server visibility policy', async visibility => {
    const categories = await call<Row[]>('openstoa_categories_list');
    const room = await call('openstoa_topic_create', { title: `MCP ${visibility} 이미지`, visibility, proofType: 'none', categoryId: categories[0].id });
    const imageArgs = { base64: PNG.toString('base64'), filename: 'restricted.png', contentType: 'image/png', purpose: 'post', topicId: room.id };
    const outsider = await connect(a);
    const refusedUpload = await result(outsider, 'openstoa_upload_image', imageArgs);
    expect(refusedUpload.isError).toBe(true);
    expect(JSON.stringify(refusedUpload.data)).toMatch(/403|member/i);
    const upload = await call('openstoa_upload_image', imageArgs);
    local.trackUpload(b, upload.publicUrl);
    const post = await call('openstoa_post_create', { topicId: room.id, title: '접근 제어 이미지', content: '이미지 접근은 토픽 공개 범위를 따릅니다.', media: { images: [upload.publicUrl] } });
    expect((await call('openstoa_post_get', { postId: post.id })).post.media.images).toEqual([upload.publicUrl]);
    const imageUrl = new URL(upload.publicUrl, BASE);
    expect(imageUrl.origin).toBe(new URL(BASE!).origin);
    expect(imageUrl.pathname).toContain(`/topics/${room.id}/posts/`);
    const member = await fetch(imageUrl, { headers: local.authHeaders(b) });
    expect(member.status).toBe(200);
    expect(Buffer.from(await member.arrayBuffer())).toEqual(PNG);
    expect((await fetch(imageUrl)).status).toBe(401);
    const nonmember = await fetch(imageUrl, { headers: local.authHeaders(a) });
    // Private posts permit signed-in readers; secret posts require membership.
    expect(nonmember.status).toBe(visibility === 'private' ? 200 : 403);
    if (visibility === 'private') expect(Buffer.from(await nonmember.arrayBuffer())).toEqual(PNG);
    await call('openstoa_topic_delete', { topicId: room.id });
  });

  it('decrypts image bytes across the stdio MCP and CLI boundary', async () => {
    const sent = await call('openstoa_chat_send_media', { topicId, mime: 'image/png', base64: PNG.toString('base64') });
    const messages = await local.cli<Row[]>(a, ['chat', 'read', topicId]);
    const media = messages.find(m => m.id === sent.messageId)?.media;
    expect(media?.status).toBe('ok');
    expect(media?.mime).toBe('image/png');
    expect(Buffer.from(Object.values(media.bytes) as number[])).toEqual(PNG);
  });

  it('uses the same private conversation from CLI and MCP and excludes it from topics', async () => {
    const dm = await local.cli(a, ['dm', 'start', b.owner.userId]);
    expect((await call('openstoa_dm_start', { userId: a.owner.userId })).topicId).toBe(dm.topicId);
    const sent = await call('openstoa_dm_send', { topicId: dm.topicId, text: '1:1 MCP 메시지 🔒' });
    const reply = await local.cli(a, ['dm', 'send', dm.topicId, 'CLI의 개인 답장 🔐']);
    expect((await call<Row[]>('openstoa_dm_read', { topicId: dm.topicId })).find(m => m.id === reply.messageId)?.text).toBe('CLI의 개인 답장 🔐');
    expect((await local.cli<Row[]>(a, ['dm', 'read', dm.topicId])).find(m => m.id === sent.messageId)?.text).toBe('1:1 MCP 메시지 🔒');
    expect((await call<Row[]>('openstoa_dm_list')).find(d => d.topicId === dm.topicId)?.peer.userId).toBe(a.owner.userId);
    expect((await call<Row[]>('openstoa_dm_history', { topicId: dm.topicId })).find(m => m.messageId === sent.messageId)?.plaintext).toBe('1:1 MCP 메시지 🔒');
    const rawDm = await local.request(b.apiKey, `/api/topics/${dm.topicId}/archive`);
    expect(rawDm.status).toBe(200);
    for (const id of [sent.messageId, reply.messageId]) {
      const archived = rawDm.body.archive.find((m: Row) => m.messageId === id);
      expect(archived.ciphertext).toBeTruthy();
      expect(JSON.stringify(archived)).not.toContain('1:1 MCP 메시지');
      expect(JSON.stringify(archived)).not.toContain('CLI의 개인 답장');
    }
    expect((await call<Row[]>('openstoa_topics_list')).some(t => t.id === dm.topicId)).toBe(false);
  });

  it('exposes current docs/query/badge operations and reports disabled ask service honestly', async () => {
    const feed = await call('openstoa_feed', { q: marker });
    expect(feed.posts.some((p: Row) => p.id === postId)).toBe(true);
    const badges = await call('openstoa_profile_badges');
    expect(badges.userId).toBe(b.owner.userId);
    expect(Array.isArray(badges.badges)).toBe(true);
    const ask = await result(client, 'openstoa_ask', { question: 'API 키로 채팅하는 방법을 알려 주세요.' });
    expect(ask.isError).toBe(true);
    expect(JSON.stringify(ask.data)).toMatch(/503|disabled/i);
    const docs = await local.request(null, '/api/docs/openapi.json');
    expect(docs.status).toBe(200);
    expect(docs.body.paths['/api/profile/badges']).toBeDefined();
    expect(docs.body.paths['/api/topics/{topicId}/chat']).toBeDefined();
  });

  it('executes the full query, post-action and notification tool catalogue', async () => {
    expect((await call('openstoa_post_get', { postId })).post.content).toBe('수정된 MCP 본문');
    expect((await call<Row[]>('openstoa_post_list', { topicId })).some(p => p.id === postId)).toBe(true);
    await call('openstoa_topic_update', { topicId, description: 'MCP 수정한 설명' });
    expect((await call('openstoa_topic_get', { topicId })).description).toBe('MCP 수정한 설명');
    expect((await call<Row[]>('openstoa_topic_members', { topicId })).some(m => m.userId === a.owner.userId)).toBe(true);
    expect((await call('openstoa_activity_posts', { q: marker })).posts.some((p: Row) => p.id === postId)).toBe(true);
    expect((await call('openstoa_post_vote', { postId, value: 1 })).vote.value).toBe(1);
    expect((await call('openstoa_activity_likes')).posts.some((p: Row) => p.id === postId)).toBe(true);
    expect((await call('openstoa_post_bookmark', { postId })).bookmarked).toBe(true);
    expect((await call('openstoa_post_bookmark_status', { postId })).bookmarked).toBe(true);
    expect((await call('openstoa_bookmarks', { q: marker })).posts.some((p: Row) => p.id === postId)).toBe(true);
    expect((await call('openstoa_post_pin', { postId })).isPinned).toBe(true);
    expect((await call('openstoa_post_react', { postId, emoji: '👍' })).added).toBe(true);
    expect((await call('openstoa_post_reactions', { postId })).reactions.some((r: Row) => r.emoji === '👍')).toBe(true);
    for (const name of ['openstoa_recorded', 'openstoa_activity_recorded', 'openstoa_activity_recorded_on_mine']) expect((await call(name)).posts).toEqual([]);
    expect((await call('openstoa_tags', { q: 'mcp' })).tags.length).toBeGreaterThan(0);
    expect(Object.keys(await call('openstoa_stats')).length).toBeGreaterThan(0);
    expect((await call('openstoa_post_records', { postId })).records).toEqual([]);
    expect((await call('openstoa_post_record_status', { postId })).allowed).toBe(false);
    const record = await result(client, 'openstoa_post_record', { postId });
    expect(record.isError).toBe(true);
    expect(JSON.stringify(record.data)).toMatch(/own post|your own/i);
    await call('openstoa_notifications_set', { enabled: false });
    expect((await call('openstoa_notifications_get')).enabled).toBe(false);
    await call('openstoa_notifications_set_topic', { topicId, muted: true });
    expect((await call('openstoa_notifications_topic', { topicId })).muted).toBe(true);
    const chat = await call<Row[]>('openstoa_chat_read', { topicId });
    const message = chat.find(m => m.text?.includes(marker));
    expect(message).toBeDefined();
    await call('openstoa_chat_mark_read', { topicId, messageId: message!.id, readAt: message!.createdAt });
    expect((await call('openstoa_chat_read_state', { topicId })).lastReadMessageId).toBe(message!.id);
    expect(await call('openstoa_chat_presence', { topicId })).toBeDefined();
    // Existing DM partners belong in dm_list, not the new-conversation picker.
    expect((await call('openstoa_dm_candidates', { q: a.owner.nickname })).candidates.some((c: Row) => c.userId === a.owner.userId)).toBe(false);
  });

  it('executes image/profile, poll, invite and membership tools', async () => {
    const nickname = `mcp_${Date.now().toString(36)}`;
    expect((await call('openstoa_profile_set_nickname', { nickname })).nickname).toBe(nickname);
    expect((await call('openstoa_profile_get')).nickname).toBe(nickname);
    expect((await call('openstoa_profile_domain_badge')).domains).toEqual([]);
    for (const [name, args] of [['openstoa_profile_set_badge', { type: 'kyc', visible: false }], ['openstoa_profile_set_domain_badge', {}]] as const) {
      const denied = await result(client, name, args);
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.data)).toMatch(/verification|proof|400/i);
    }
    await call('openstoa_profile_remove_domain_badge');
    const upload = await call('openstoa_upload_image', { base64: PNG.toString('base64'), filename: 'avatar.png', contentType: 'image/png', purpose: 'avatar' });
    local.trackUpload(b, upload.publicUrl);
    await call('openstoa_profile_set_image', { imageUrl: upload.publicUrl });
    expect((await call('openstoa_profile_image')).profileImage).toBe(upload.publicUrl);
    await call('openstoa_profile_remove_image');
    expect((await call('openstoa_profile_image')).profileImage).toBeNull();
    expect((await call('openstoa_upload_delete', { urls: [upload.publicUrl] })).deleted).toBe(1);
    const made = await local.request(b.owner.token, `/api/topics/${topicId}/posts`, 'POST', { title: 'MCP 투표', content: '투표 본문', poll: { options: ['첫 선택', '두 번째 선택'] } });
    expect(made.status).toBe(201);
    const pollPost = made.body.post;
    const optionId = pollPost.poll.options[0].id;
    expect((await call('openstoa_post_poll_vote', { postId: pollPost.id, optionIds: [optionId] })).poll.options.find((o: Row) => o.id === optionId).voteCount).toBe(1);
    expect((await call('openstoa_post_poll_unvote', { postId: pollPost.id })).poll.options.find((o: Row) => o.id === optionId).voteCount).toBe(0);
    expect((await call('openstoa_post_get', { postId: pollPost.id })).post.poll.id).toBe(pollPost.poll.id);
    await call('openstoa_post_update', { postId: pollPost.id, poll: null });
    // GET omits the poll field when the post no longer has a poll.
    expect((await call('openstoa_post_get', { postId: pollPost.id })).post).not.toHaveProperty('poll');
    const categories = await call<Row[]>('openstoa_categories_list');
    const room = await local.cli(a, ['topics', 'create', '--title', 'MCP 회원 검증', '--category-id', categories[0].id, '--proof-type', 'none']);
    expect((await call('openstoa_topic_join', { topicId: room.id, method: 'app', approved: true })).joined).toBe(true);
    expect((await call('openstoa_topic_leave', { topicId: room.id })).left).toBe(true);
    const invite = await local.cli(a, ['topics', 'invite', room.id]);
    expect(JSON.stringify(await call('openstoa_topic_invite_lookup', { inviteCode: invite.token }))).toContain('MCP 회원 검증');
    expect((await call('openstoa_topic_join_invite', { inviteCode: invite.token, method: 'app', approved: true })).topicId).toBe(room.id);
    // B owns the main fixture room; the role/member tools act on A there.
    expect((await call('openstoa_topic_invite', { topicId, expiresInHours: 1 })).token).toBeTruthy();
    expect((await call('openstoa_topic_requests', { topicId })).requests).toEqual([]);
    for (const name of ['openstoa_topic_approve', 'openstoa_topic_reject']) {
      const denied = await result(client, name, { topicId, requestId: '00000000-0000-4000-8000-000000000001' });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.data)).toMatch(/404|not found/i);
    }
    await call('openstoa_topic_set_role', { topicId, userId: a.owner.userId, role: 'admin' });
    expect((await call<Row[]>('openstoa_topic_members', { topicId })).find(m => m.userId === a.owner.userId)?.role).toBe('admin');
    await call('openstoa_topic_set_role', { topicId, userId: a.owner.userId, role: 'member' });
  });

  it('denies key management, missing cmd and missing historyGrant via real MCP results', async () => {
    for (const [name, args] of [
      ['openstoa_apikey_list', {}],
      ['openstoa_apikey_create', { name: 'must-not-exist', cmd: [], historyGrant: 'none' }],
      ['openstoa_apikey_update', { id: b.keyId, cmd: [], historyGrant: 'none' }],
      ['openstoa_apikey_revoke', { id: b.keyId }],
    ] as const) {
      const denied = await result(client, name, args);
      expect(denied.isError, name).toBe(true);
      expect(JSON.stringify(denied.data)).toMatch(/403|owner|session/i);
    }
    const weak = await connect(await local.agent(b.owner, { cmd: ['/openstoa/profile/read'], historyGrant: 'none' }));
    const denied = await result(weak, 'openstoa_post_create', { topicId, title: '권한 없음', content: '생성하면 안 되는 게시물' });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.data)).toMatch(/403|capability/i);
    const noHistory = await connect(await local.agent(b.owner, { cmd: ['/openstoa/topic/join', '/openstoa/topic/read', '/openstoa/chat/read'], historyGrant: 'none' }));
    const history = await result(noHistory, 'openstoa_chat_read', { topicId });
    expect(history.isError).toBe(true);
    expect(JSON.stringify(history.data)).toMatch(/historyGrant|History grant/i);
    const malformed = await result(client, 'openstoa_chat_send', { topicId, text: 123 });
    expect(malformed.isError).toBe(true);
    const invalidLogin = await result(client, 'openstoa_login', { token: 'invalid-local-test-token' });
    expect(invalidLogin.isError).toBe(false);
    expect(invalidLogin.data.status).toBe('authentication_required');
    expect((await call('openstoa_whoami')).userId).toBe(b.owner.userId);
  });

  it('joins a private topic through its single-use invite and refuses direct join and token reuse', async () => {
    const categories = await call<Row[]>('openstoa_categories_list');
    const room = await local.cli(a, ['topics', 'create', '--title', 'MCP 비공개 초대 검증', '--visibility', 'private', '--category-id', categories[0].id, '--proof-type', 'none']);
    const direct = await result(client, 'openstoa_topic_join', { topicId: room.id });
    expect(direct.isError).toBe(true);
    expect(JSON.stringify(direct.data)).toMatch(/403|invite/i);
    const invite = await local.cli(a, ['topics', 'invite', room.id, '--expires-in-hours', '1']);
    expect(JSON.stringify(await call('openstoa_topic_invite_lookup', { inviteCode: invite.token }))).toContain('MCP 비공개 초대 검증');
    expect((await call('openstoa_topic_join_invite', { inviteCode: invite.token })).topicId).toBe(room.id);
    expect((await call<Row[]>('openstoa_topic_members', { topicId: room.id })).some(member => member.userId === b.owner.userId)).toBe(true);
    expect((await call('openstoa_topic_leave', { topicId: room.id })).left).toBe(true);
    const reused = await result(client, 'openstoa_topic_join_invite', { inviteCode: invite.token });
    expect(reused.isError).toBe(true);
    expect(JSON.stringify(reused.data)).toMatch(/404|invalid|used/i);
    expect((await local.cli<Row[]>(a, ['topics', 'members', room.id])).some(member => member.userId === b.owner.userId)).toBe(false);
    await local.cli(a, ['topics', 'delete', room.id]);
  });

  it('deletes the disposable post through MCP', async () => {
    expect((await call('openstoa_post_delete', { postId })).isDeleted).toBe(true);
    await call('openstoa_topic_kick', { topicId, userId: a.owner.userId });
    expect((await call<Row[]>('openstoa_topic_members', { topicId })).some(m => m.userId === a.owner.userId)).toBe(false);
    await call('openstoa_topic_delete', { topicId });
    expect((await call<Row[]>('openstoa_topics_list')).some(t => t.id === topicId)).toBe(false);
    expect((await call('openstoa_logout')).ok).toBe(true);
    // A remaining permission key cannot authenticate after the login session is removed.
    expect((await call('openstoa_whoami')).status).toBe('authentication_required');
  });
});
