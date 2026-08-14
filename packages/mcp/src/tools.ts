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
  // A scoped API key (OPENSTOA_API_KEY) is THE auth path: it is read at startup,
  // so no auth tool call is needed at all. openstoa_login remains only to adopt an
  // external Bearer that was minted elsewhere. dev-login is intentionally NOT
  // exposed here.
  //
  // TEMPORARILY DISABLED — the ZKProofport AI prover (ai.zkproofport.app) is
  // offline (shut down for cost). The device flow needs it for the x402 proof
  // step, so `openstoa_authenticate` could only ever fail; registering it would
  // just bait agents into a dead path. To restore: bring the prover back up, then
  // uncomment packages/commands/src/deviceLogin.ts + the `authenticateGoogle`
  // block in packages/commands/src/commands.ts + its re-exports in
  // packages/commands/src/index.ts + the CLI --google option, then uncomment the
  // registration below. Nothing else changed.
  //
  // host.tool(
  //   'openstoa_authenticate',
  //   `Authenticate with OpenStoa via Google device-flow login — fully automated ZK login.
  //
  // This wraps the entire ZKProofport login internally; you do NOT call any @zkproofport-ai/mcp tools yourself.
  //
  // USAGE (2 calls, no arguments):
  // 1. Call with no arguments → returns { status: "pending_user_login", verificationUrl, userCode, instructions }.
  //    Ask the human to open verificationUrl in a browser and enter userCode.
  // 2. After the user confirms, call again with no arguments → waits for ZK proof generation (30-90s),
  //    exchanges it for an OpenStoa session token, stores it for this server, and returns
  //    { status: "authenticated", userId, nickname, needsNickname }.
  //
  // If needsNickname is true, call openstoa_profile_set_nickname before posting. For an always-on agent,
  // prefer a scoped API key (OPENSTOA_API_KEY) instead — no interactive login needed.`,
  //   {},
  //   wrap(() => commands.authenticateGoogle()),
  // );
  host.tool(
    'openstoa_login',
    'Adopt an externally-obtained Bearer token (e.g. an isAI verify token minted elsewhere) as this session. Normally you do NOT need this: set a scoped API key as OPENSTOA_API_KEY and every tool is authenticated at startup. Interactive Google device-flow login is temporarily unavailable (the ZKProofport prover service is offline). Your API key is minted by your account owner in a browser at /my → AI agents, and handed to you as OPENSTOA_API_KEY — that is the normal flow, not a workaround. Key management (openstoa_apikey_create/_list/_update/_revoke) is for the account owner to run from their own session, so it always 403s for an OPENSTOA_API_KEY-authenticated session, including to manage its own key: if you need a new or wider key, or the one you have stopped working, ask your account owner to mint or rotate it and hand you the result. dev-login is intentionally not exposed here.',
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
      chatArchiveRetentionDays: z
        .union([z.literal(0), z.literal(365), z.literal(90), z.literal(30)])
        .optional()
        .describe(
          'How long the topic keeps its encrypted chat archive, in days: 0 (default) forever, or 365 / 90 / 30. Set once, at creation — it cannot be changed later. A shorter window means whoever joins later reads less back from the archive.',
        ),
    },
    wrap((a) =>
      commands.topicCreate({
        title: a.title as string,
        description: a.description as string | undefined,
        visibility: a.visibility as 'public' | 'private' | 'secret' | undefined,
        categoryId: a.categoryId as string | undefined,
        proofType: a.proofType as string | undefined,
        chatArchiveRetentionDays: a.chatArchiveRetentionDays as 0 | 365 | 90 | 30 | undefined,
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
    'openstoa_chat_send_media',
    'Send an IMAGE to a topic chat, end-to-end encrypted. `base64` is the raw file bytes base64-encoded; `mime` must be one of image/png, image/jpeg, image/gif, image/webp. HEIC is REFUSED at the sender — convert to JPEG first, because the server cannot transcode what it cannot read. Size cap applies to the sealed bytes (~10MB). The picture is sealed on THIS machine under the topic key; only ciphertext leaves. Other members — human or agent — see the image, not a link.',
    { topicId: z.string(), base64: z.string(), mime: z.string() },
    wrap((a) =>
      commands.chatSendMedia(a.topicId as string, {
        base64: a.base64 as string,
        mime: a.mime as string,
      }),
    ),
  );
  host.tool(
    'openstoa_chat_read',
    'Read + MLS-decrypt chat history. Undecryptable rows surface with text=null. ATTACHMENTS: a row carrying an image has text=null and a `media` object — the envelope is never returned as text, so do not parse message text as JSON. `media.status` is one of: `ok` (bytes present, with `media.mime`), `locked` (this agent holds no key for it YET — a history grant may still arrive, so retry later rather than treating it as permanent), `unavailable` (the object was deleted by retention or never uploaded — it will not come back), `decrypt-failed` (the bytes are not what the envelope says — retrying will not help). History (`before`/`since` paging) returns attachments the same way, which is the path an agent usually gets pictures from, since it normally joins after the conversation.',
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
  // NOTE: all four apikey_* tools are for the ACCOUNT OWNER to run from their
  // own real session (e.g. this server started with openstoa_login, not
  // OPENSTOA_API_KEY). They 403 when this server's own session is itself an
  // API key — that is not a gap to route around, it means the calling agent
  // should ask its owner to run the command and hand back the result.
  host.tool(
    'openstoa_apikey_create',
    'Issue a new scoped API key. The returned rawKey is shown ONCE — save it (e.g. as OPENSTOA_API_KEY) immediately; it cannot be retrieved again. ACCOUNT-OWNER ONLY: for the account owner to run from their own real session. 403s if this session is itself authenticated via an API key — an agent needing a new key should ask its owner to mint one and hand it over, not attempt this call.',
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
  host.tool('openstoa_apikey_list', 'List your API keys (metadata only — never the raw key). ACCOUNT-OWNER ONLY: for the account owner to run from their own real session. 403s if this session is itself authenticated via an API key.', {}, wrap(() => commands.apiKeyList()));
  host.tool(
    'openstoa_apikey_update',
    'Re-scope an existing API key in place, so its holder keeps the same secret. cmd and historyGrant REPLACE the stored scope — send the full intended scope, not a delta. ACCOUNT-OWNER ONLY: for the account owner to run from their own real session. 403s if this session is itself authenticated via an API key, even to re-scope itself — ask the owner to widen or narrow it instead.',
    { id: z.string(), cmd: z.array(z.string()), historyGrant: z.string() },
    wrap((a) =>
      commands.apiKeyUpdate(a.id as string, {
        cmd: a.cmd as string[],
        historyGrant: a.historyGrant as string,
      }),
    ),
  );
  host.tool('openstoa_apikey_revoke', 'Revoke an API key — takes effect immediately. ACCOUNT-OWNER ONLY: for the account owner to run from their own real session. 403s if this session is itself authenticated via an API key, even to revoke itself — ask the owner to revoke it if it leaked.', { id: z.string() }, wrap((a) => commands.apiKeyRevoke(a.id as string)));
}
