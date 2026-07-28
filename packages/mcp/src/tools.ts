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
  host.tool(
    'openstoa_login',
    'Authenticate. dev-login by default; pass { token } to adopt an externally-obtained Bearer (e.g. an isAI verify token).',
    { nickname: z.string().optional(), token: z.string().optional() },
    wrap((a) => commands.login({ nickname: a.nickname as string | undefined, token: a.token as string | undefined })),
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
  host.tool('openstoa_topic_join', 'Join a topic: REST membership + MLS self-join.', { topicId: z.string() }, wrap((a) => commands.topicJoin(a.topicId as string)));
  host.tool('openstoa_topic_leave', 'Remove yourself from a topic (server enforces its self-removal policy).', { topicId: z.string() }, wrap((a) => commands.topicLeave(a.topicId as string)));
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
  host.tool('openstoa_comment_list', 'Comments on a post.', { postId: z.string() }, wrap((a) => commands.commentList(a.postId as string)));
  host.tool('openstoa_comment_add', 'Add a comment to a post.', { postId: z.string(), content: z.string() }, wrap((a) => commands.commentAdd(a.postId as string, a.content as string)));

  // ── chat (E2EE) ────────────────────────────────────────────────────────────
  host.tool('openstoa_chat_join', 'Join a topic chat (MLS self-join; keys held locally in the vault).', { topicId: z.string() }, wrap((a) => commands.chatJoin(a.topicId as string)));
  host.tool('openstoa_chat_send', 'Seal + send one E2EE chat message.', { topicId: z.string(), text: z.string() }, wrap((a) => commands.chatSend(a.topicId as string, a.text as string)));
  host.tool(
    'openstoa_chat_read',
    'Read + MLS-decrypt chat history. Undecryptable rows surface with text=null.',
    { topicId: z.string(), limit: z.number().optional(), since: z.string().optional(), before: z.string().optional() },
    wrap((a) => commands.chatRead(a.topicId as string, { limit: a.limit as number | undefined, since: a.since as string | undefined, before: a.before as string | undefined })),
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
