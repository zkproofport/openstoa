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
import { OpenStoaApiError, REST_OPERATIONS, type Commands, type CreateTopicInput, type TopicProofOptions } from '@masselabs/openstoa-commands';

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

const topicProofSchema = {
  method: z.enum(['app', 'ai']).optional().describe('How to generate a proof if required; app uses mobile QR, ai uses the local prover.'),
  approved: z.boolean().optional().describe('Set true only after the user consents to proof generation and finishing this action.'),
  provider: z.enum(['google', 'microsoft']).optional().describe('Identity provider for workspace domain proofs.'),
};
function topicProofOptions(input: Record<string, unknown>): TopicProofOptions {
  return {
    ...(input.method !== undefined ? {method: input.method as TopicProofOptions['method']} : {}),
    ...(input.approved !== undefined ? {approved: input.approved as boolean} : {}),
    ...(input.provider !== undefined ? {provider: input.provider as TopicProofOptions['provider']} : {}),
  };
}
const topicProofGuidance = ' With user consent, supply method app/ai and approved:true to start a required proof in this call (default app). Show browserUrl for its app QR page or verificationUrl/userCode from proof_status. Keep this MCP process running; use proof_status then proof_resume to finish the saved action once. Without consent return proof_required. No proof generation occurs if the action already succeeds. Existing proof/publicInputs cannot be combined with generation options.';

export function registerTools(host: ToolHost, commands: Commands): void {
  const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
  const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true });
  const wrap =
    (fn: (a: Record<string, unknown>) => Promise<unknown>) =>
    async (a: Record<string, unknown>): Promise<ToolResult> => {
      try {
        return ok(await fn(a));
      } catch (err) {
        if(err instanceof OpenStoaApiError && err.status===401)return ok({status:'authentication_required',methods:['app','ai'],message:'Login is required before API-key authorization. Complete proof login, then retry this operation.',next:{cli:'openstoa login',mcp:'openstoa_authenticate'}});
        return fail(err instanceof Error ? err.message : String(err));
      }
    };

  // Login shares the CLI workflow; tools return identity, never session tokens.
  host.tool('openstoa_authenticate',
    'Sign in using an explicitly approved app QR proof or local AI Google device flow. With no approval return consent guidance. After user approval call with approved:true and method app/ai; show the app deepLink as a QR (browserUrl is optional) or verificationUrl/userCode. Poll with operationId until authenticated; session is saved locally automatically. cancel:true cancels. Login establishes identity. Then call openstoa_apikey_use to validate the locally configured key and inspect its permissions. If missing, have the user run openstoa apikey use locally in the same vault. Business tools require that owner-issued permission key. Do not ask for private keys or tokens in messages.',
    {method:z.enum(['app','ai']).optional(),approved:z.boolean().optional(),operationId:z.string().optional(),cancel:z.boolean().optional(),redirectUrl:z.string().optional()},
    wrap(a=>commands.authenticate(a as Parameters<Commands['authenticate']>[0])));
  host.tool(
    'openstoa_login',
    'Adopt an externally obtained session token. For proof login use openstoa_authenticate; API keys authorize business operations alongside this login session; select a key issued by the same account owner.',
    { token: z.string() },
    wrap((a) => commands.login({ token: a.token as string })),
  );
  host.tool('openstoa_logout', 'Drop the saved local session; encryption keys are kept. Environment API keys remain configured externally.', {}, wrap(async () => { await commands.logout(); return { ok: true }; }));
  host.tool('openstoa_whoami', 'Current login identity and isAI session flag; no API key required.', {}, wrap(() => commands.whoami()));

  host.tool('openstoa_proof_continue',
    'Start proof generation for a saved proof_required operation only after the user explicitly approves. Ask for method app or ai and, for a generic workspace proof, provider google or microsoft. Return the browser URL/QR page or verification URL and user code to the user, then poll proof_status. Never supply private keys in tool arguments; requiredInputs names the environment configuration that is missing.',
    { operationId: z.string(), method: z.enum(['app', 'ai']), approved: z.literal(true), provider: z.enum(['google', 'microsoft']).optional() },
    wrap(a => commands.proofContinue({ operationId: a.operationId as string, method: a.method as 'app' | 'ai', approved: true, ...(a.provider ? { provider: a.provider as 'google' | 'microsoft' } : {}) })),
  );
  host.tool('openstoa_proof_status', 'Read a saved proof operation. Pending returns user-action guidance; proof_ready may be resumed. This does not retry the original action.',
    { operationId: z.string() }, wrap(a => commands.proofStatus(a.operationId as string)));
  host.tool('openstoa_proof_resume', 'Resume the exact saved topic create/join/invite action once its proof is ready; never recreate the action manually. Completed returns its original result.',
    { operationId: z.string() }, wrap(a => commands.proofResume(a.operationId as string)));
  host.tool('openstoa_proof_cancel', 'Cancel a saved proof operation without retrying the original action.',
    { operationId: z.string() }, wrap(a => commands.proofCancel(a.operationId as string)));

  // ── topics ────────────────────────────────────────────────────────────────
  host.tool('openstoa_topics_list', 'Read or search topics; omit view for joined topics.', { view: z.enum(['all']).optional(), sort: z.enum(['hot', 'new', 'top', 'active']).optional(), category: z.string().optional(), q: z.string().optional() }, wrap((a) => commands.topicsList(a as { view?: string; sort?: string; category?: string; q?: string })));
  host.tool('openstoa_topic_get', 'Topic details.', { topicId: z.string() }, wrap((a) => commands.topicGet(a.topicId as string)));
  host.tool(
    'openstoa_topic_create',
    'Create a topic. categoryId is required — call openstoa_categories_list first. Never recreate a pending action manually.' + topicProofGuidance,
    {
      ...topicProofSchema,
      title: z.string(),
      description: z.string().optional(),
      visibility: z.enum(['public', 'private', 'secret']).optional(),
      categoryId: z.string().optional(),
      proofType: z.enum(['none', 'kyc', 'country', 'google_workspace', 'microsoft_365', 'workspace']).optional(),
      allowedCountries: z.array(z.string()).optional(),
      requiredDomain: z.string().optional(),
      proof: z.string().optional(),
      publicInputs: z.string().optional(),
      image: z.string().optional(),
      chatArchiveRetentionDays: z
        .union([z.literal(0), z.literal(365), z.literal(90), z.literal(30)])
        .optional()
        .describe(
          'How long the topic keeps its encrypted chat archive, in days: 0 (default) forever, or 365 / 90 / 30. Set once, at creation — it cannot be changed later. A shorter window means whoever joins later reads less back from the archive.',
        ),
    },
    wrap((a) =>
      commands.topicCreate({
        ...topicProofOptions(a),
        title: a.title as string,
        description: a.description as string | undefined,
        visibility: a.visibility as 'public' | 'private' | 'secret' | undefined,
        categoryId: a.categoryId as string | undefined,
        proofType: a.proofType as CreateTopicInput['proofType'],
        allowedCountries: a.allowedCountries as string[] | undefined,
        requiredDomain: a.requiredDomain as string | undefined,
        proof: a.proof as string | undefined,
        publicInputs: a.publicInputs as string | undefined,
        image: a.image as string | undefined,
        chatArchiveRetentionDays: a.chatArchiveRetentionDays as 0 | 365 | 90 | 30 | undefined,
      }),
    ),
  );
  host.tool(
    'openstoa_topic_join',
    'Join topic membership. Private/secret topics require an invitation. Use chat_join separately to initialize MLS encryption. The server verifies proof, account scope and topic conditions.' + topicProofGuidance,
    { topicId: z.string(), proof: z.string().optional(), publicInputs: z.string().optional(), ...topicProofSchema },
    wrap((a) => commands.topicJoin(a.topicId as string, { ...topicProofOptions(a), proof: a.proof as string | undefined, publicInputs: a.publicInputs as string | undefined })),
  );
  host.tool('openstoa_topic_leave', 'Leave a topic; owners must transfer ownership first.', { topicId: z.string() }, wrap((a) => commands.topicLeave(a.topicId as string)));
  host.tool(
    'openstoa_topic_update',
    'Edit a topic you own: title, description or image URL.',
    {
      topicId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      image: z.string().optional(),
    },
    wrap((a) =>
      commands.topicUpdate(a.topicId as string, {
        title: a.title as string | undefined,
        description: a.description as string | undefined,
        image: a.image as string | undefined,
      }),
    ),
  );
  host.tool('openstoa_topic_members', 'List a topic’s members.', { topicId: z.string() }, wrap((a) => commands.topicMembers(a.topicId as string)));
  host.tool('openstoa_categories_list', 'List categories (a categoryId is required to create a topic).', {}, wrap(() => commands.categoriesList()));

  // ── posts + comments ────────────────────────────────────────────────────────
  host.tool('openstoa_post_list', 'Read or search posts in a topic.', { topicId: z.string(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), sort: z.enum(['hot', 'new', 'top', 'active', 'recorded']).optional(), tag: z.string().optional(), q: z.string().optional() }, wrap((a) => { const { topicId, ...query } = a; return commands.postList(topicId as string, query as { limit?: number; offset?: number; sort?: string; tag?: string; q?: string }); }));
  host.tool('openstoa_post_get', 'Post detail + its comments.', { postId: z.string() }, wrap((a) => commands.postGet(a.postId as string)));
  host.tool(
    'openstoa_post_create',
    'Create a post in a topic.',
    { topicId: z.string(), title: z.string(), content: z.string(), tags: z.array(z.string()).optional(), media: z.record(z.unknown()).optional(), poll: z.record(z.unknown()).nullable().optional() },
    wrap((a) => commands.postCreate(a.topicId as string, { title: a.title as string, content: a.content as string, tags: a.tags as string[] | undefined, media: a.media, poll: a.poll })),
  );
  host.tool(
    'openstoa_post_update',
    'Edit a post you authored: any of title / content / tags.',
    { postId: z.string(), title: z.string().optional(), content: z.string().optional(), tags: z.array(z.string()).optional(), media: z.record(z.unknown()).optional(), poll: z.record(z.unknown()).nullable().optional() },
    wrap((a) => commands.postUpdate(a.postId as string, { title: a.title as string | undefined, content: a.content as string | undefined, tags: a.tags as string[] | undefined, media: a.media, poll: a.poll })),
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
    { topicId: z.string(), limit: z.number().int().min(1).max(500).optional().describe('Maximum messages, 1–500; server default 50.'), since: z.string().optional().describe('ISO timestamp'), before: z.string().optional().describe('Server message ID, not a timestamp') },
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
    'Upload a base64-encoded image and get back its media URL. For a post image, pass topicId so readers can access it under that topic\'s visibility. Embed the returned publicUrl in a post/topic/avatar. image/* only, max 10MB.',
    {
      base64: z.string().describe('Base64-encoded image bytes (no data: URI prefix)'),
      filename: z.string().describe('Filename with extension, e.g. photo.jpg'),
      contentType: z.string().describe('MIME type, e.g. image/png, image/jpeg, image/webp'),
      purpose: z.enum(['post', 'topic', 'avatar']).optional().describe('Path organization (default: post)'),
      topicId: z.string().optional().describe('Existing topic ID for post/cover images; omit for avatars or a new topic cover'),
    },
    wrap((a) =>
      commands.uploadImage({
        data: new Uint8Array(Buffer.from(a.base64 as string, 'base64')),
        filename: a.filename as string,
        contentType: a.contentType as string,
        purpose: a.purpose as 'post' | 'topic' | 'avatar' | undefined,
        topicId: a.topicId as string | undefined,
      }),
    ),
  );

  // ── profile ────────────────────────────────────────────────────────────────
  host.tool('openstoa_profile_get', 'Current profile / session.', {}, wrap(() => commands.profileGet()));
  host.tool('openstoa_profile_set_nickname', 'Set / replace your nickname.', { nickname: z.string() }, wrap((a) => commands.profileSetNickname(a.nickname as string)));

  // Key management is restricted to human owner sessions without a selected key.
  // Agent sessions remain forbidden even when no API key is supplied.
  host.tool(
    'openstoa_apikey_create',
    'Issue a new scoped API key. The returned rawKey is shown ONCE — save it (e.g. as OPENSTOA_API_KEY) immediately; it cannot be retrieved again. ACCOUNT-OWNER ONLY: for the account owner to run from their own real session. Agent sessions are denied even without an API key; human owner sessions must not attach a permission key — an agent needing a new key should ask its owner to mint one and hand it over, not attempt this call.',
    {
      name: z.string(),
      cmd: z.array(z.string()).optional(),
      historyGrant: z.string().optional(),
      isAI: z.boolean().optional().describe('Legacy key metadata only; does not change login session identity or grant owner privileges.'),
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
  host.tool('openstoa_apikey_use', 'Validate and save the locally configured permission key after proof login. Returns its actual permissions without the key. No secret arguments: configure locally with openstoa apikey use in the same vault. This selects an existing owner-issued key; it never creates one.', {}, wrap(() => commands.configureApiKey()));
  host.tool('openstoa_apikey_list', 'List your API keys (metadata only — never the raw key). ACCOUNT-OWNER ONLY: for the account owner to run from their own real session. Agent sessions are denied even without an API key; human owner sessions must not attach a permission key.', {}, wrap(() => commands.apiKeyList()));
  host.tool(
    'openstoa_apikey_update',
    'Re-scope an existing API key in place, so its holder keeps the same secret. cmd and historyGrant REPLACE the stored scope — send the full intended scope, not a delta. ACCOUNT-OWNER ONLY: for the account owner to run from their own real session. Agent sessions are denied even without an API key; human owner sessions must not attach a permission key, even to re-scope itself — ask the owner to widen or narrow it instead.',
    { id: z.string(), cmd: z.array(z.string()), historyGrant: z.string() },
    wrap((a) =>
      commands.apiKeyUpdate(a.id as string, {
        cmd: a.cmd as string[],
        historyGrant: a.historyGrant as string,
      }),
    ),
  );
  host.tool('openstoa_apikey_revoke', 'Revoke an API key — takes effect immediately. ACCOUNT-OWNER ONLY: for the account owner to run from their own real session. Agent sessions are denied even without an API key; human owner sessions must not attach a permission key, even to revoke itself — ask the owner to revoke it if it leaked.', { id: z.string() }, wrap((a) => commands.apiKeyRevoke(a.id as string)));
  host.tool('openstoa_dm_send', 'Seal and send an E2EE direct message.', { topicId: z.string(), text: z.string() }, wrap((a) => commands.dmSend(a.topicId as string, a.text as string)));
  host.tool('openstoa_dm_read', 'Read and decrypt direct messages.', { topicId: z.string(), limit: z.number().int().min(1).max(500).optional().describe('Maximum messages, 1–500; server default 50.'), since: z.string().optional().describe('ISO timestamp'), before: z.string().optional().describe('Server message ID') }, wrap((a) => commands.dmRead(a.topicId as string, { limit: a.limit as number | undefined, since: a.since as string | undefined, before: a.before as string | undefined })));
  host.tool('openstoa_chat_history', 'Decrypt archived history available to this device and API key historyGrant.', { topicId: z.string() }, wrap((a) => commands.chatHistory(a.topicId as string)));
  host.tool('openstoa_dm_history', 'Decrypt archived DM history available to this device and API key historyGrant.', { topicId: z.string() }, wrap((a) => commands.chatHistory(a.topicId as string)));
  host.tool('openstoa_chat_share_keys', 'Share locally held history keys with existing member devices.', { topicId: z.string() }, wrap((a) => commands.chatShareKeys(a.topicId as string)));

  for (const operation of REST_OPERATIONS) {
    const schema: Record<string, z.ZodTypeAny> = {};
    for (const parameter of operation.parameters) {
      let field: z.ZodTypeAny;
      switch (parameter.type) {
        case 'boolean': field = z.boolean(); break;
        case 'number': {
          let number = z.number().int();
          if (parameter.min !== undefined) number = number.min(parameter.min);
          if (parameter.max !== undefined) number = number.max(parameter.max);
          field = number; break;
        }
        case 'strings': field = z.array(z.string().min(1)).min(1); break;
        case 'string': {
          let string = z.string();
          if (parameter.required) string = string.min(1);
          if (parameter.max !== undefined) string = string.max(parameter.max);
          field = string; break;
        }
        default: throw new Error(`Unknown operation parameter type ${String(parameter.type)}`);
      }
      if (parameter.choices) field = field.refine((value) => parameter.choices!.includes(value), { message: `Expected one of ${parameter.choices.join(', ')}` });
      if (!parameter.required) field = field.optional();
      schema[parameter.name] = field.describe(parameter.description);
    }
    if (operation.id === 'topic_join_invite') Object.assign(schema, topicProofSchema);
    const proofGuidance = operation.id === 'topic_join_invite' ? topicProofGuidance : '';
    const capability = operation.capabilities.length ? ` Required AI capabilities: ${operation.capabilities.join(', ')}.` : '';
    host.tool(operation.tool, `${operation.description} ${operation.access}${capability}${proofGuidance}`, schema, wrap((args) => commands.executeOperation(operation.id, args)));
  }

}
