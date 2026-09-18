/** Real API-key agent workflows through the built CLI. Explicitly opt in with
 * E2E_BASE_URL=http://localhost:3200; no production/staging target is accepted.
 * Covers UTF-8 payloads, authorization failures, CRUD and actual decryption. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildProgram } from '../../cli';
import type { Command } from 'commander';
import { BASE, LocalAgents, PNG, type Agent, type Row } from './agentHarness';

const local = new LocalAgents();
let a: Agent;
let b: Agent;
let topicId: string;
let postId: string;
let commentId: string;
const marker = `한국어 CLI 통합 검증 🔐 ${Date.now()}`;

describe.skipIf(!BASE).sequential('API-key CLI agent workflows (local stack)', () => {
  beforeAll(async () => {
    await local.ready();
    a = await local.agent(await local.owner('cli_a'));
    b = await local.agent(await local.owner('cli_b'));
  });
  afterAll(async () => {
    await local.dispose();
    const leaves = (node: Command, prefix: string[] = []): string[][] =>
      node.commands.flatMap(child => child.commands.length
        ? leaves(child, [...prefix, child.name()]) : [[...prefix, child.name()]]);
    const missing = leaves(buildProgram()).filter(command =>
      !local.cliInvocations.some(args => command.every((part, index) => args[index] === part)));
    expect(missing, 'Every registered CLI command must have a live invocation').toEqual([]);
  });

  it('uses a verified agent session plus scoped permission key and reads profile/categories', async () => {
    const session = await local.cli(a, ['whoami']);
    expect(session.userId).toBe(a.owner.userId);
    expect(session.isAI).toBe(true);
    expect((await local.cli(a, ['profile', 'get'])).userId).toBe(a.owner.userId);
    const categories = await local.cli<Row[]>(a, ['categories']);
    expect(categories.length).toBeGreaterThan(0);
    const topic = await local.cli(a, ['topics', 'create', '--title', marker, '--description', '테스트에서 만든 임시 토픽', '--visibility', 'public', '--proof-type', 'none', '--category-id', categories[0].id, '--chat-archive-retention-days', '30']);
    topicId = topic.id;
    expect(topic.title).toBe(marker);
    expect(topic.chatArchiveRetentionDays).toBe(30);
    expect((await local.cli<Row[]>(a, ['topics', 'list'])).some(t => t.id === topicId)).toBe(true);
    expect((await local.cli(a, ['topics', 'get', topicId])).title).toBe(marker);
  });

  it('requires login plus an owner-matching permission key for agent business access', async () => {
    const keyOnly = await fetch(`${BASE}/api/profile/badges`, { headers: { 'X-OpenStoa-API-Key': a.apiKey } });
    expect(keyOnly.status).toBe(401);
    const bearerKey = await fetch(`${BASE}/api/profile/badges`, { headers: { Authorization: `Bearer ${a.apiKey}` } });
    expect(bearerKey.status).toBe(401);
    const mismatched = await fetch(`${BASE}/api/profile/badges`, { headers: { Authorization: `Bearer ${a.sessionToken}`, 'X-OpenStoa-API-Key': b.apiKey } });
    expect(mismatched.status).toBe(403);
    const noKey = await fetch(`${BASE}/api/profile/badges`, { headers: { Authorization: `Bearer ${a.sessionToken}` } });
    expect(noKey.status).toBe(403);
    const paired = await fetch(`${BASE}/api/profile/badges`, { headers: local.authHeaders(a) });
    expect(paired.status).toBe(200);
    expect(await paired.json()).toHaveProperty('badges');
  });

  it('joins the topic and updates metadata through the agent credential', async () => {
    expect((await local.cli(b, ['topics', 'join', topicId, '--method', 'app', '--approved'])).joined).toBe(true);
    const members = await local.cli<Row[]>(a, ['topics', 'members', topicId]);
    expect(members.map(m => m.userId)).toEqual(expect.arrayContaining([a.owner.userId, b.owner.userId]));
    await local.cli(a, ['topics', 'update', topicId, '--description', '수정한 설명 — 댓글과 채팅 검증']);
    expect((await local.cli(a, ['topics', 'get', topicId])).description).toBe('수정한 설명 — 댓글과 채팅 검증');
  });

  it('creates, reads, edits and comments with exact Korean content', async () => {
    const post = await local.cli(a, ['post', 'create', topicId, '--title', marker, '--content', '첫 본문\n둘째 줄 & 기호 % _ 🔎', '--tags', '검증,cli']);
    postId = post.id;
    expect(post.content).toContain('둘째 줄 & 기호 % _ 🔎');
    expect((await local.cli<Row[]>(b, ['post', 'list', topicId])).some(p => p.id === postId)).toBe(true);
    await local.cli(a, ['post', 'update', postId, '--content', '수정한 한국어 본문 🔐']);
    expect((await local.cli(b, ['post', 'get', postId])).post.content).toBe('수정한 한국어 본문 🔐');
    const comment = await local.cli(b, ['comment', 'add', postId, '한국어 댓글과 emoji 🧪']);
    commentId = comment.id;
    expect((await local.cli<Row[]>(a, ['comment', 'list', postId])).find(c => c.id === commentId)?.content).toBe('한국어 댓글과 emoji 🧪');
    const denied = await local.cliResult(b, ['post', 'update', postId, '--content', '허용되지 않은 수정']);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toMatch(/403|author|permission/i);
    expect((await local.cli(a, ['post', 'get', postId])).post.content).toBe('수정한 한국어 본문 🔐');
  });

  it('uploads a post image, persists media and serves its exact bytes', async () => {
    const file = path.join(a.root, '게시물-이미지.png');
    await fs.writeFile(file, PNG);
    const upload = await local.cli(a, ['upload', file, '--purpose', 'post', '--topic-id', topicId]);
    local.trackUpload(a, upload.publicUrl);
    const media = { images: [upload.publicUrl], imageAlts: { [upload.publicUrl]: '한국어 이미지 설명 🔎' } };
    const post = await local.cli(a, ['post', 'create', topicId, '--title', '이미지 첨부 E2E', '--content', marker, '--media', JSON.stringify(media)]);
    const persisted = (await local.cli(b, ['post', 'get', post.id])).post;
    expect(persisted.media.images).toEqual(media.images);
    expect(persisted.media.imageAlts).toEqual(media.imageAlts);
    const feed = await local.cli(b, ['feed', '--q', '이미지 첨부 E2E']);
    expect(feed.posts.find((row: Row) => row.id === post.id)?.media.images).toEqual(media.images);
    const image = await fetch(new URL(upload.publicUrl, BASE));
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
    const imageUrl = new URL(upload.publicUrl, BASE);
    const memberImage = await fetch(imageUrl, { headers: imageUrl.origin === new URL(BASE!).origin ? local.authHeaders(b) : {} });
    expect(memberImage.status).toBe(200);
    expect(Buffer.from(await memberImage.arrayBuffer())).toEqual(PNG);
    await local.cli(a, ['post', 'delete', post.id]);
  });

  it('rejects empty and oversized images before creating an upload', async () => {
    for (const [name, data, expected] of [
      ['empty.png', Buffer.alloc(0), /empty/i],
      ['oversized.png', Buffer.alloc(10 * 1024 * 1024 + 1), /10MB|exceed/i],
    ] as const) {
      const file = path.join(a.root, name);
      await fs.writeFile(file, data);
      const refused = await local.cliResult(a, ['upload', file, '--purpose', 'post']);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toMatch(expected);
    }
  });

  it('returns structured proof guidance without creating a topic for every supported gate', async () => {
    const categories = await local.cli<Row[]>(a, ['categories']);
    for (const proofType of ['kyc', 'country', 'google_workspace', 'microsoft_365', 'workspace']) {
      const title = `미인증 생성 거부 ${proofType} ${marker}`;
      const args = ['topics', 'create', '--title', title, '--visibility', 'public', '--proof-type', proofType, '--category-id', categories[0].id];
      if (proofType === 'country') args.push('--allowed-countries', 'KR');
      if (proofType === 'google_workspace' || proofType === 'microsoft_365') args.push('--required-domain', 'example.com');
      const required = await local.cli(a, args);
      expect(required.status, proofType).toBe('proof_required');
      expect(required.requirement.type).toBe(proofType);
      expect(required.operationId).toEqual(expect.any(String));
      expect((await local.cli(a, ['proof', 'cancel', required.operationId])).status).toBe('cancelled');
      expect((await local.cli<Row[]>(a, ['topics', 'list', '--q', title])).some(row => row.title === title)).toBe(false);
    }
  });

  it('persists an explicitly approved app proof across CLI processes, then cancels without creating a topic', async () => {
    const categories = await local.cli<Row[]>(a, ['categories']);
    const title = `CLI proof continuation ${marker}`;
    const required = await local.cli(a, ['topics', 'create', '--title', title, '--proof-type', 'kyc', '--category-id', categories[0].id]);
    expect(required.status).toBe('proof_required');
    const operationId = required.operationId;
    const unapproved = await local.cliResult(a, ['proof', 'continue', operationId, '--method', 'app']);
    expect(unapproved.code).not.toBe(0);
    expect(unapproved.stderr).toContain('--approved');
    expect((await local.cli(a, ['proof', 'status', operationId])).status).toBe('proof_required');
    const pending = await local.cli(a, ['proof', 'continue', operationId, '--approved', '--method', 'app']);
    expect(pending.status).toBe('pending');
    expect(pending.deepLink).toMatch(/^zkproofport:\/\/proof-request\?/);
    expect(new URL(pending.browserUrl).origin).toBe(new URL(BASE!).origin);
    expect(new URL(pending.browserUrl).hash).not.toBe('');
    expect((await local.cli(a, ['proof', 'status', operationId])).status).toBe('pending');
    expect((await local.cli(a, ['proof', 'resume', operationId])).status).toBe('pending');
    expect((await local.cli(a, ['proof', 'cancel', operationId])).status).toBe('cancelled');
    expect((await local.cli(a, ['proof', 'resume', operationId])).status).toBe('cancelled');
    expect((await local.cli<Row[]>(a, ['topics', 'list', '--q', title])).some(row => row.title === title)).toBe(false);
  });

  it('starts a required app proof directly from topic options only with explicit consent', async () => {
    const categories = await local.cli<Row[]>(a, ['categories']);
    const title = `CLI direct proof ${marker}`;
    const args = ['topics', 'create', '--title', title, '--proof-type', 'kyc', '--category-id', categories[0].id, '--method', 'app'];
    const required = await local.cli(a, args);
    expect(required.status).toBe('proof_required');
    expect(required).not.toHaveProperty('browserUrl');
    expect(required).not.toHaveProperty('deepLink');
    expect((await local.cli(a, ['proof', 'cancel', required.operationId])).status).toBe('cancelled');
    const pending = await local.cli(a, [...args, '--approved']);
    try {
      expect(pending.status).toBe('pending');
      expect(pending.method).toBe('app');
      expect(pending.deepLink).toMatch(/^zkproofport:\/\/proof-request\?/);
      const browser = new URL(pending.browserUrl);
      expect(browser.origin).toBe(new URL(BASE!).origin);
      expect(browser.pathname).toBe('/proof');
      expect(browser.hash).not.toBe('');
      expect(JSON.stringify(pending)).not.toContain(a.apiKey);
      expect(JSON.stringify(pending)).not.toContain(a.sessionToken);
      expect((await local.cli(a, ['proof', 'status', pending.operationId])).status).toBe('pending');
      expect((await local.cli(a, ['proof', 'resume', pending.operationId])).status).toBe('pending');
    } finally {
      expect((await local.cli(a, ['proof', 'cancel', pending.operationId])).status).toBe('cancelled');
    }
    expect((await local.cli(a, ['proof', 'resume', pending.operationId])).status).toBe('cancelled');
    expect((await local.cli<Row[]>(a, ['topics', 'list', '--q', title])).some(row => row.title === title)).toBe(false);
  });

  it('queries feeds/activity and toggles votes, bookmarks, pins and reactions', async () => {
    expect((await local.cli(b, ['feed', '--q', marker])).posts.some((p: Row) => p.id === postId)).toBe(true);
    expect((await local.cli(a, ['activity', 'posts', '--q', marker])).posts.some((p: Row) => p.id === postId)).toBe(true);
    expect((await local.cli(b, ['post', 'vote', postId, '--value', '1'])).vote.value).toBe(1);
    expect((await local.cli(b, ['activity', 'likes'])).posts.some((p: Row) => p.id === postId)).toBe(true);
    expect((await local.cli(b, ['post', 'bookmark', postId])).bookmarked).toBe(true);
    expect((await local.cli(b, ['post', 'bookmark-status', postId])).bookmarked).toBe(true);
    expect((await local.cli(b, ['bookmarks', '--q', marker])).posts.some((p: Row) => p.id === postId)).toBe(true);
    expect((await local.cli(a, ['post', 'pin', postId])).isPinned).toBe(true);
    expect((await local.cli(b, ['post', 'react', postId, '--emoji', '👍'])).added).toBe(true);
    expect((await local.cli(b, ['post', 'reactions', postId])).reactions.some((r: Row) => r.emoji === '👍')).toBe(true);
    for (const args of [['recorded'], ['activity', 'recorded'], ['activity', 'recorded-on-mine']]) {
      expect((await local.cli(a, args)).posts).toEqual([]);
    }
    expect((await local.cli(a, ['tags', '--q', 'cli'])).tags.length).toBeGreaterThan(0);
    expect(Object.keys(await local.cli(a, ['stats'])).length).toBeGreaterThan(0);
    expect((await local.cli(a, ['post', 'records', postId])).records).toEqual([]);
    expect((await local.cli(a, ['post', 'record-status', postId])).allowed).toBe(false);
    // Own-post denial is checked before any chain transaction can be submitted.
    const denied = await local.cliResult(a, ['post', 'record', postId]);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toMatch(/own post|your own/i);
  });

  it('votes in a real poll, removes its vote and deletes the poll', async () => {
    const made = await local.request(a.owner.token, `/api/topics/${topicId}/posts`, 'POST', { title: 'CLI 투표 검증', content: '투표 본문', poll: { options: ['첫 선택', '두 번째 선택'], multipleChoice: false } });
    expect(made.status).toBe(201);
    const pollPost = made.body.post;
    const optionId = pollPost.poll.options[0].id;
    const voted = await local.cli(b, ['post', 'poll-vote', pollPost.id, '--option-ids', optionId]);
    expect(voted.poll.options.find((o: Row) => o.id === optionId).voteCount).toBe(1);
    const removed = await local.cli(b, ['post', 'poll-unvote', pollPost.id]);
    expect(removed.poll.options.find((o: Row) => o.id === optionId).voteCount).toBe(0);
    expect((await local.cli(a, ['post', 'get', pollPost.id])).post.poll.id).toBe(pollPost.poll.id);
    await local.cli(a, ['post', 'update', pollPost.id, '--poll', 'null']);
    // GET omits the poll field when the post no longer has a poll.
    expect((await local.cli(a, ['post', 'get', pollPost.id])).post).not.toHaveProperty('poll');
  });

  it('uses invite, role and member operations without altering other users', async () => {
    const categories = await local.cli<Row[]>(a, ['categories']);
    const privateTopic = await local.cli(a, ['topics', 'create', '--title', '초대 전용 CLI 검증', '--visibility', 'private', '--category-id', categories[0].id, '--proof-type', 'none']);
    const withoutInvite = await local.cliResult(b, ['topics', 'join', privateTopic.id]);
    expect(withoutInvite.code).not.toBe(0);
    expect(withoutInvite.stderr).toMatch(/invitation|invite|403/i);
    expect((await local.cli<Row[]>(a, ['topics', 'members', privateTopic.id])).some(row => row.userId === b.owner.userId)).toBe(false);
    const invite = await local.cli(a, ['topics', 'invite', privateTopic.id, '--expires-in-hours', '1']);
    const preview = await local.cli(b, ['topics', 'invite-lookup', invite.token]);
    expect(JSON.stringify(preview)).toContain('초대 전용 CLI 검증');
    expect((await local.cli(b, ['topics', 'join-invite', invite.token, '--method', 'app', '--approved'])).topicId).toBe(privateTopic.id);
    await local.cli(a, ['topics', 'set-role', privateTopic.id, '--user-id', b.owner.userId, '--role', 'admin']);
    expect((await local.cli<Row[]>(a, ['topics', 'members', privateTopic.id])).find(m => m.userId === b.owner.userId)?.role).toBe('admin');
    await local.cli(a, ['topics', 'set-role', privateTopic.id, '--user-id', b.owner.userId, '--role', 'member']);
    expect((await local.cli(a, ['topics', 'requests', privateTopic.id])).requests).toEqual([]);
    for (const action of ['approve', 'reject']) {
      const denied = await local.cliResult(a, ['topics', action, privateTopic.id, '--request-id', '00000000-0000-4000-8000-000000000001']);
      expect(denied.code).not.toBe(0);
      expect(denied.stderr).toMatch(/404|not found|request/i);
    }
    await local.cli(a, ['topics', 'kick', privateTopic.id, '--user-id', b.owner.userId]);
    expect((await local.cli<Row[]>(a, ['topics', 'members', privateTopic.id])).some(m => m.userId === b.owner.userId)).toBe(false);
    await local.cli(a, ['topics', 'delete', privateTopic.id]);
    expect((await local.cli<Row[]>(a, ['topics', 'list'])).some(t => t.id === privateTopic.id)).toBe(false);
  });

  it('reads badge state, respects verification prerequisites and saves notifications', async () => {
    expect((await local.cli(a, ['profile', 'badges'])).userId).toBe(a.owner.userId);
    expect((await local.cli(a, ['profile', 'domain-badge'])).domains).toEqual([]);
    const badge = await local.cliResult(a, ['profile', 'set-badge', '--type', 'kyc', '--visible', 'false']);
    expect(badge.code).not.toBe(0);
    expect(badge.stderr).toMatch(/verification|400/i);
    const domain = await local.cliResult(a, ['profile', 'set-domain-badge']);
    expect(domain.code).not.toBe(0);
    expect(domain.stderr).toMatch(/verification|proof|400/i);
    await local.cli(a, ['profile', 'remove-domain-badge']);
    const file = path.join(a.root, 'avatar.png');
    await fs.writeFile(file, PNG);
    const uploaded = await local.cli(a, ['upload', file, '--purpose', 'avatar']);
    local.trackUpload(a, uploaded.publicUrl);
    expect(uploaded.publicUrl).toMatch(/^(https?:\/\/|\/api\/media\/)/);
    await local.cli(a, ['profile', 'set-image', '--image-url', uploaded.publicUrl]);
    expect((await local.cli(a, ['profile', 'image'])).profileImage).toBe(uploaded.publicUrl);
    await local.cli(a, ['profile', 'remove-image']);
    expect((await local.cli(a, ['profile', 'image'])).profileImage).toBeNull();
    expect((await local.cli(b, ['upload-delete', '--urls', uploaded.publicUrl])).skipped).toBe(1);
    expect((await local.cli(a, ['upload-delete', '--urls', uploaded.publicUrl])).deleted).toBe(1);
    await local.cli(a, ['notifications', 'set', '--enabled', 'false']);
    expect((await local.cli(a, ['notifications', 'get'])).enabled).toBe(false);
    await local.cli(a, ['notifications', 'set-topic', topicId, '--muted', 'true']);
    expect((await local.cli(a, ['notifications', 'topic', topicId])).muted).toBe(true);
    const candidates = await local.cli(a, ['dm', 'candidates', '--q', b.owner.nickname]);
    expect(candidates.candidates.some((c: Row) => c.userId === b.owner.userId)).toBe(true);
    const ask = await local.cliResult(a, ['ask', '--question', 'OpenStoa API 키 권한을 설명해 주세요.']);
    expect(ask.code).not.toBe(0);
    expect(ask.stderr).toMatch(/503|disabled/i);
  });

  it('round-trips encrypted text and image through independent CLI processes', async () => {
    await local.cli(a, ['chat', 'join', topicId]);
    await local.cli(b, ['chat', 'join', topicId]);
    const sent = await local.cli(a, ['chat', 'send', topicId, marker]);
    const read = await local.cli<Row[]>(b, ['chat', 'read', topicId, '--limit', '50']);
    expect(read.find(m => m.id === sent.messageId)?.text).toBe(marker);
    expect((await local.cli<Row[]>(b, ['chat', 'history', topicId])).find(m => m.messageId === sent.messageId)?.plaintext).toBe(marker);
    expect((await local.cli(a, ['chat', 'share-keys', topicId])).shared).toBeGreaterThanOrEqual(0);
    const received = read.find(m => m.id === sent.messageId)!;
    await local.cli(b, ['chat', 'mark-read', topicId, '--message-id', sent.messageId, '--read-at', received.createdAt]);
    expect((await local.cli(b, ['chat', 'read-state', topicId])).lastReadMessageId).toBe(sent.messageId);
    expect(await local.cli(b, ['chat', 'presence', topicId])).toBeDefined();
    const raw = await local.request(a.apiKey, `/api/topics/${topicId}/chat`);
    expect(raw.status, JSON.stringify(raw.body)).toBe(200);
    const row = raw.body.messages.find((m: Row) => m.id === sent.messageId);
    expect(row.message).toBeNull();
    // Delivery acknowledgement may already purge the live ciphertext. The
    // archival copy remains encrypted and is what history successfully opened.
    const archive = await local.request(a.apiKey, `/api/topics/${topicId}/archive`);
    expect(archive.status, JSON.stringify(archive.body)).toBe(200);
    const archived = archive.body.archive.find((m: Row) => m.messageId === sent.messageId);
    expect(archived.ciphertext).toBeTruthy();
    expect(JSON.stringify(archived)).not.toContain(marker);
    if (row.sealed) expect(JSON.stringify(row.sealed)).not.toContain(marker);
    const file = path.join(a.root, 'probe.png');
    await fs.writeFile(file, PNG);
    const image = await local.cli(a, ['chat', 'send-media', topicId, file]);
    const images = await local.cli<Row[]>(b, ['chat', 'read', topicId]);
    const media = images.find(m => m.id === image.messageId)?.media;
    expect(media?.status).toBe('ok');
    expect(media?.mime).toBe('image/png');
    expect(Buffer.from(Object.values(media.bytes) as number[])).toEqual(PNG);
  });

  it('starts, lists, sends and decrypts a direct conversation', async () => {
    const dm = await local.cli(a, ['dm', 'start', b.owner.userId]);
    expect((await local.cli(b, ['dm', 'start', a.owner.userId])).topicId).toBe(dm.topicId);
    const sent = await local.cli(a, ['dm', 'send', dm.topicId, `개인 대화 ${marker}`]);
    expect((await local.cli<Row[]>(b, ['dm', 'read', dm.topicId])).find(m => m.id === sent.messageId)?.text).toBe(`개인 대화 ${marker}`);
    expect((await local.cli<Row[]>(b, ['dm', 'history', dm.topicId])).find(m => m.messageId === sent.messageId)?.plaintext).toBe(`개인 대화 ${marker}`);
    expect((await local.cli<Row[]>(b, ['dm', 'list'])).find(d => d.topicId === dm.topicId)?.peer.userId).toBe(a.owner.userId);
    expect((await local.cli<Row[]>(b, ['topics', 'list'])).some(t => t.id === dm.topicId)).toBe(false);
  });

  it('a topic/join-only key completes membership without requiring topic reads or MLS access', async () => {
    const categories = await local.cli<Row[]>(a, ['categories']);
    const room = await local.cli(a, ['topics', 'create', '--title', 'Join-only permission key', '--category-id', categories[0].id, '--proof-type', 'none']);
    const joinOnly = await local.agent(b.owner, { cmd: ['/openstoa/topic/join'], historyGrant: 'none' });
    expect(await local.cli(joinOnly, ['topics', 'join', room.id])).toMatchObject({ topicId: room.id, joined: true });
    expect((await local.cli<Row[]>(a, ['topics', 'members', room.id])).some(member => member.userId === b.owner.userId)).toBe(true);
    const read = await local.cliResult(joinOnly, ['topics', 'get', room.id]);
    expect(read.code).not.toBe(0); expect(read.stderr).toMatch(/403|capability|permission/i);
    await local.cli(a, ['topics', 'delete', room.id]);
  });

  it('enforces cmd, historyGrant and owner-only API-key management', async () => {
    const weak = await local.agent(a.owner, { cmd: ['/openstoa/profile/read'], historyGrant: 'none' });
    const noHistory = await local.agent(a.owner, { cmd: ['/openstoa/topic/join', '/openstoa/topic/read', '/openstoa/chat/read', '/openstoa/chat/send'], historyGrant: 'none' });
    const refused = await local.cliResult(weak, ['post', 'create', topicId, '--title', '금지된 글', '--content', '금지된 본문']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/403|capability/i);
    const history = await local.cliResult(noHistory, ['chat', 'read', topicId]);
    expect(history.code).not.toBe(0);
    expect(history.stderr).toMatch(/historyGrant|History grant/i);
    const archive = await local.cliResult(noHistory, ['chat', 'history', topicId]);
    expect(archive.code).not.toBe(0);
    expect(archive.stderr).toMatch(/historyGrant|History grant/i);
    for (const args of [
      ['apikey', 'list'],
      ['apikey', 'create', '--name', 'must-not-exist'],
      ['apikey', 'update', a.keyId, '--cmd', '', '--history-grant', 'none'],
      ['apikey', 'revoke', a.keyId],
    ]) {
      const result = await local.cliResult(a, args);
      expect(result.code, args.slice(0, 2).join(' ')).not.toBe(0);
      expect(result.stderr).toMatch(/403|owner|session/i);
    }
    expect((await local.cli(a, ['whoami'])).userId).toBe(a.owner.userId);
  });

  it('can start app login from a fresh vault with no existing API key or session', async () => {
    const anonymous = { ...a, apiKey: '', root: path.join(a.root, 'anonymous-login') };
    const consent = await local.cli(anonymous, ['login']);
    expect(consent.status).toBe('consent_required');
    const pending = await local.cli(anonymous, ['login', '--method', 'app', '--approved']);
    expect(pending.status).toBe('pending');
    expect((await local.cli(anonymous, ['login', '--operation-id', pending.operationId])).status).toBe('pending');
    expect((await local.cli(anonymous, ['login', '--operation-id', pending.operationId, '--cancel'])).status).toBe('cancelled');
    expect((await local.cli(anonymous, ['whoami'])).status).toBe('authentication_required');
  });

  it('starts an explicitly approved app login and resumes/cancels across CLI processes without replacing its API key', async () => {
    expect((await local.cli(a, ['login'])).status).toBe('consent_required');
    const pending = await local.cli(a, ['login', '--method', 'app', '--approved']);
    expect(pending.status).toBe('pending');
    const browser = new URL(pending.browserUrl);
    expect(browser.origin).toBe(new URL(BASE!).origin);
    expect(browser.pathname).toBe('/login');
    expect(browser.hash).toContain('approvalToken=');
    expect(pending).not.toHaveProperty('token');
    expect(pending).not.toHaveProperty('codeVerifier');
    expect((await local.cli(a, ['login', '--operation-id', pending.operationId])).status).toBe('pending');
    expect((await local.cli(a, ['login', '--operation-id', pending.operationId, '--cancel'])).status).toBe('cancelled');
    expect((await local.cli(a, ['whoami'])).userId).toBe(a.owner.userId);
  });

  it('renames the profile and deletes only its own disposable content', async () => {
    const nickname = `agent_${Date.now().toString(36)}`;
    expect((await local.cli(a, ['profile', 'set-nickname', nickname])).nickname).toBe(nickname);
    expect((await local.cli(a, ['profile', 'get'])).nickname).toBe(nickname);
    expect((await local.cli(b, ['comment', 'delete', commentId])).deleted).toBe(true);
    expect((await local.cli(a, ['post', 'delete', postId])).isDeleted).toBe(true);
    expect((await local.cli(b, ['topics', 'leave', topicId])).left).toBe(true);
    const consent = await local.cli(a, ['login']);
    expect(consent.status).toBe('consent_required');
    const invalid = await local.cliResult(a, ['login', '--token', 'invalid-local-test-token']);
    expect(invalid.code).toBe(0);
    expect(JSON.parse(invalid.stdout).status).toBe('authentication_required');
    expect((await local.cli(a, ['whoami'])).userId).toBe(a.owner.userId);
    expect((await local.cli(a, ['logout'])).ok).toBe(true);
    expect((await local.cli(a, ['whoami'])).status).toBe('authentication_required');
  });
});
