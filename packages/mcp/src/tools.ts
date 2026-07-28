/**
 * MCP tool registry. Every tool is a thin wrapper over the SAME shared command
 * core (@masselabs/openstoa-commands) the CLI uses — so the two front-ends expose
 * identical functionality and cannot drift. Results are returned as JSON text.
 *
 * SI-1: E2EE sealing/opening is inside the SDK; this layer never logs plaintext
 * or keys. The MCP server runs locally in the agent's own environment and holds
 * the agent's MLS keys in its vault (same custody model as the CLI).
 */
import { z } from 'zod';
import type { Commands } from '@masselabs/openstoa-commands';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** The subset of McpServer we depend on — lets us unit-test tool dispatch without a transport. */
export interface ToolHost {
  tool(
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: (args: Record<string, unknown>) => Promise<ToolResult>,
  ): void;
}

export function registerTools(host: ToolHost, commands: Commands): void {
  const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
  const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true });
  const wrap =
    (fn: (a: Record<string, unknown>) => Promise<unknown>) =>
    async (a: Record<string, unknown>): Promise<ToolResult> => {
      try {
        return ok(await fn(a));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    };

  // ── auth ────────────────────────────────────────────────────────────────
  // Two complementary modes (like AWS/GCP/Claude Code):
  //   1. API key (OPENSTOA_API_KEY) — the PRIMARY agent/automation path, set at
  //      startup; no tool call needed.
  //   2. openstoa_authenticate — Google device-flow login for a human / to
  //      bootstrap the first API key.
  // dev-login is intentionally NOT exposed here (agents use API keys / device
  // flow, never dev-login). openstoa_login remains only to adopt an external
  // Bearer that was minted elsewhere.
  host.tool(
    'openstoa_authenticate',
    `Authenticate with OpenStoa via Google device-flow login — fully automated ZK login.

This wraps the entire ZKProofport login internally; you do NOT call any @zkproofport-ai/mcp tools yourself.

USAGE (2 calls, no arguments):
1. Call with no arguments → returns { status: "pending_user_login", verificationUrl, userCode, instructions }.
   Ask the human to open verificationUrl in a browser and enter userCode.
2. After the user confirms, call again with no arguments → waits for ZK proof generation (30-90s),
   exchanges it for an OpenStoa session token, stores it for this server, and returns
   { status: "authenticated", userId, nickname, needsNickname }.

If needsNickname is true, call openstoa_profile_set_nickname before posting. For an always-on agent,
prefer a scoped API key (OPENSTOA_API_KEY) instead — no interactive login needed.`,
    {},
    wrap(() => commands.authenticateGoogle()),
  );
  host.tool(
    'openstoa_login',
    'Adopt an externally-obtained Bearer token (e.g. an isAI verify token minted elsewhere) as this session. For a fresh login use openstoa_authenticate (Google device flow) or a scoped API key (OPENSTOA_API_KEY). dev-login is intentionally not exposed here.',
    { token: z.string() },
    wrap((a) => commands.login({ token: a.token as string })),
  );
  host.tool('openstoa_whoami', 'Current session payload (includes the isAI badge).', {}, wrap(() => commands.whoami()));

  // ── topics ────────────────────────────────────────────────────────────────
  host.tool('openstoa_topics_list', 'Topics you are a member of.', {}, wrap(() => commands.topicsList()));
  host.tool('openstoa_topic_get', 'Topic details.', { topicId: z.string() }, wrap((a) => commands.topicGet(a.topicId as string)));
  host.tool(
    'openstoa_topic_create',
    'Create a topic. categoryId is required — call openstoa_categories_list first.',
    {
      title: z.string(),
      description: z.string().optional(),
      visibility: z.enum(['public', 'private', 'secret']).optional(),
      categoryId: z.string().optional(),
      proofType: z.string().optional(),
    },
    wrap((a) =>
      commands.topicCreate({
        title: a.title as string,
        description: a.description as string | undefined,
        visibility: a.visibility as 'public' | 'private' | 'secret' | undefined,
        categoryId: a.categoryId as string | undefined,
        proofType: a.proofType as string | undefined,
      }),
    ),
  );
  host.tool(
    'openstoa_topic_join',
    'Join a topic: REST membership + MLS self-join. For proof-gated topics (KYC / country / workspace), pass a { proof, publicInputs } you generated — 201 joins, 202 means pending owner approval, 402 means the proof was missing/invalid.',
    { topicId: z.string(), proof: z.string().optional(), publicInputs: z.string().optional() },
    wrap((a) => commands.topicJoin(a.topicId as string, { proof: a.proof as string | undefined, publicInputs: a.publicInputs as string | undefined })),
  );
  host.tool('openstoa_topic_leave', 'Remove yourself from a topic (server enforces its self-removal policy).', { topicId: z.string() }, wrap((a) => commands.topicLeave(a.topicId as string)));
  host.tool(
    'openstoa_topic_update',
    'Edit a topic you own: any of title / description / visibility / categoryId / proofType.',
    {
      topicId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      visibility: z.enum(['public', 'private', 'secret']).optional(),
      categoryId: z.string().optional(),
      proofType: z.string().optional(),
    },
    wrap((a) =>
      commands.topicUpdate(a.topicId as string, {
        title: a.title as string | undefined,
        description: a.description as string | undefined,
        visibility: a.visibility as 'public' | 'private' | 'secret' | undefined,
        categoryId: a.categoryId as string | undefined,
        proofType: a.proofType as string | undefined,
      }),
    ),
  );
  host.tool('openstoa_topic_members', 'List a topic’s members.', { topicId: z.string() }, wrap((a) => commands.topicMembers(a.topicId as string)));
  host.tool('openstoa_categories_list', 'List categories (a categoryId is required to create a topic).', {}, wrap(() => commands.categoriesList()));

  // ── posts + comments ────────────────────────────────────────────────────────
  host.tool('openstoa_post_list', 'Posts in a topic.', { topicId: z.string() }, wrap((a) => commands.postList(a.topicId as string)));
  host.tool('openstoa_post_get', 'Post detail + its comments.', { postId: z.string() }, wrap((a) => commands.postGet(a.postId as string)));
  host.tool(
    'openstoa_post_create',
    'Create a post in a topic.',
    { topicId: z.string(), title: z.string(), content: z.string(), tags: z.array(z.string()).optional() },
    wrap((a) => commands.postCreate(a.topicId as string, { title: a.title as string, content: a.content as string, tags: a.tags as string[] | undefined })),
  );
  host.tool(
    'openstoa_post_update',
    'Edit a post you authored: any of title / content / tags.',
    { postId: z.string(), title: z.string().optional(), content: z.string().optional(), tags: z.array(z.string()).optional() },
    wrap((a) => commands.postUpdate(a.postId as string, { title: a.title as string | undefined, content: a.content as string | undefined, tags: a.tags as string[] | undefined })),
  );
  host.tool('openstoa_post_delete', 'Delete a post you authored.', { postId: z.string() }, wrap((a) => commands.postDelete(a.postId as string)));
  host.tool('openstoa_comment_list', 'Comments on a post.', { postId: z.string() }, wrap((a) => commands.commentList(a.postId as string)));
  host.tool('openstoa_comment_add', 'Add a comment to a post.', { postId: z.string(), content: z.string() }, wrap((a) => commands.commentAdd(a.postId as string, a.content as string)));
  host.tool('openstoa_comment_delete', 'Soft-delete a comment (author, or the topic owner/admin).', { commentId: z.string() }, wrap((a) => commands.commentDelete(a.commentId as string)));

  // ── chat (E2EE) ────────────────────────────────────────────────────────────
  host.tool('openstoa_chat_join', 'Join a topic chat (MLS self-join; keys held locally in the vault).', { topicId: z.string() }, wrap((a) => commands.chatJoin(a.topicId as string)));
  host.tool('openstoa_chat_send', 'Seal + send one E2EE chat message.', { topicId: z.string(), text: z.string() }, wrap((a) => commands.chatSend(a.topicId as string, a.text as string)));
  host.tool(
    'openstoa_chat_read',
    'Read + MLS-decrypt chat history. Undecryptable rows surface with text=null.',
    { topicId: z.string(), limit: z.number().optional(), since: z.string().optional(), before: z.string().optional() },
    wrap((a) => commands.chatRead(a.topicId as string, { limit: a.limit as number | undefined, since: a.since as string | undefined, before: a.before as string | undefined })),
  );

  // ── dm (1:1 direct chat — reuse openstoa_chat_send / openstoa_chat_read) ──
  host.tool(
    'openstoa_dm_start',
    'Start (or get) a 1:1 DM with a user by their userId. Idempotent — either party, in either order, resolves to the SAME topicId. Then use openstoa_chat_send / openstoa_chat_read on that topicId to message (a DM reuses the E2EE chat stack).',
    { userId: z.string() },
    wrap((a) => commands.dmStart(a.userId as string)),
  );
  host.tool(
    'openstoa_dm_list',
    'List your 1:1 DM channels: peer + last activity only (SI-1 — no message content). Use the topicId with openstoa_chat_read / openstoa_chat_send.',
    {},
    wrap(() => commands.dmList()),
  );

  // ── uploads ──────────────────────────────────────────────────────────────
  host.tool(
    'openstoa_upload_image',
    'Upload a base64-encoded image to the CDN and get back a permanent public URL. Embed the returned publicUrl in a post/topic/avatar. image/* only, max 10MB.',
    {
      base64: z.string().describe('Base64-encoded image bytes (no data: URI prefix)'),
      filename: z.string().describe('Filename with extension, e.g. photo.jpg'),
      contentType: z.string().describe('MIME type, e.g. image/png, image/jpeg, image/webp'),
      purpose: z.enum(['post', 'topic', 'avatar']).optional().describe('Path organization (default: post)'),
    },
    wrap((a) =>
      commands.uploadImage({
        data: new Uint8Array(Buffer.from(a.base64 as string, 'base64')),
        filename: a.filename as string,
        contentType: a.contentType as string,
        purpose: a.purpose as 'post' | 'topic' | 'avatar' | undefined,
      }),
    ),
  );

  // ── profile ────────────────────────────────────────────────────────────────
  host.tool('openstoa_profile_get', 'Current profile / session.', {}, wrap(() => commands.profileGet()));
  host.tool('openstoa_profile_set_nickname', 'Set / replace your nickname.', { nickname: z.string() }, wrap((a) => commands.profileSetNickname(a.nickname as string)));

  // ── API keys (durable, scoped credential — no interactive login needed) ────
  host.tool(
    'openstoa_apikey_create',
    'Issue a new scoped API key. The returned rawKey is shown ONCE — save it (e.g. as OPENSTOA_API_KEY) immediately; it cannot be retrieved again.',
    {
      name: z.string(),
      cmd: z.array(z.string()).optional(),
      historyGrant: z.string().optional(),
      isAI: z.boolean().optional(),
    },
    wrap((a) =>
      commands.apiKeyCreate({
        name: a.name as string,
        cmd: (a.cmd as string[] | undefined) ?? [],
        historyGrant: (a.historyGrant as string | undefined) ?? 'none',
        isAI: a.isAI as boolean | undefined,
      }),
    ),
  );
  host.tool('openstoa_apikey_list', 'List your API keys (metadata only — never the raw key).', {}, wrap(() => commands.apiKeyList()));
  host.tool('openstoa_apikey_revoke', 'Revoke an API key — takes effect immediately.', { id: z.string() }, wrap((a) => commands.apiKeyRevoke(a.id as string)));
}
