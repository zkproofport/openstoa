/**
 * The shared command core. Every operation the OpenStoa CLI and MCP server expose
 * lives here as a thin method over `@masselabs/openstoa` (ChatClient + REST). The
 * two adapters (CLI arg-parser, MCP tool registry) call THESE methods, so they can
 * never drift: one code path, two front-ends.
 *
 * SI-1: E2EE chat sealing/opening happens inside ChatClient, client-side. This
 * layer only moves plaintext into `sendChat` / out of `readChat` in-process; it
 * never logs message bodies or keys, and never touches ciphertext directly.
 */
import { ChatClient, OpenStoaClient, getRestOperation, OpenStoaApiError } from '@masselabs/openstoa';
import type {
  ChatMessage,
  Topic,
  TopicMember,
  Post,
  Comment,
  Category,
  DmChannel,
  CreateTopicInput,
  CreatePostInput,
  SessionPayload,
  ApiKeyMeta,
  ApiKeyCreateInput,
  ApiKeyUpdateInput,
  ApiKeyCreateResult,
} from '@masselabs/openstoa';
import { FileSessionStore, MemorySessionStore, type SessionData, type SessionStore } from './session';
import { readCredentials, writeCredentials } from './credentials';
import { resolveHome, type CommandConfig } from './config';
import * as path from 'node:path';
import {LoginWorkflow,type AuthenticateInput} from './loginWorkflow';
import type {startAiTopicProof} from './aiTopicProof';
import {TopicProofWorkflow,FileProofOperationStore,MemoryProofOperationStore,type ProofOperationStore,type ProofWorkflowResult,type ProofContinueInput,type ProofAction} from './topicProofWorkflow';

/** Client-side generation controls; never sent as topic API request fields. */
export interface TopicProofOptions {
  method?: 'app' | 'ai';
  approved?: boolean;
  provider?: 'google' | 'microsoft';
}
function splitTopicProofOptions<T extends object>(input: T) {
  const { method, approved, provider, ...body } = input as T & TopicProofOptions;
  if (method !== undefined && method !== 'app' && method !== 'ai') throw new Error('Unknown proof method');
  if (approved !== undefined && typeof approved !== 'boolean') throw new Error('Proof approval must be a boolean');
  if (provider !== undefined && provider !== 'google' && provider !== 'microsoft') throw new Error('Unknown proof provider');
  const raw = input as { proof?: unknown; publicInputs?: unknown };
  if ((raw.proof !== undefined || raw.publicInputs !== undefined)
    && (method !== undefined || approved !== undefined || provider !== undefined)) {
    throw new Error('Cannot combine existing proof/publicInputs with proof generation options');
  }
  return { body: body as T, options: { method, approved, provider } };
}

export interface LoginResult {
  userId: string;
  nickname: string;
  isAI?: boolean;
}

export interface PermissionKeyStatus {
  configured:boolean; apiKeyId?:string; capabilities?:string[]; historyGrant?:string;
}

export interface CommandsDeps {
  credentialsHome?:string;
  loginStore?: SessionStore;
  loginProver?: typeof startAiTopicProof;
  proofStore?: ProofOperationStore;
  chat: ChatClient;
  sessionStore: SessionStore;
  baseUrl: string;
  session: SessionData | null;

}

export class Commands {
  private readonly credentialsHome?:string;
  private readonly loginFlow: LoginWorkflow;
  private readonly proofs: TopicProofWorkflow;
  private readonly chat: ChatClient;
  private readonly store: SessionStore;
  private readonly baseUrl: string;
  private session: SessionData | null;

  constructor(deps: CommandsDeps) {
    this.credentialsHome=deps.credentialsHome;
    this.chat = deps.chat;
    this.store = deps.sessionStore;
    this.baseUrl = deps.baseUrl;
    this.session = deps.session;
    this.loginFlow = new LoginWorkflow({rest:this.chat.rest,baseUrl:this.baseUrl,store:deps.loginStore??new MemorySessionStore(),prover:deps.loginProver,adopt:async(token,guard)=>{
      const identity=await this.chat.rest.auth.validateToken(token);
      await guard();
      await this.persist({baseUrl:this.baseUrl,token,userId:identity.userId,nickname:identity.nickname});
      this.chat.useToken(token);return {userId:identity.userId,nickname:identity.nickname,isAI:identity.isAI};
    }});
    this.proofs = new TopicProofWorkflow({rest: this.chat.rest,baseUrl: this.baseUrl,store: deps.proofStore ?? new MemoryProofOperationStore(),submit: async (action,proof) => {
      if(action.kind==='create')return this.chat.rest.topics.create({...action.input,...proof} as unknown as CreateTopicInput);
      if(action.kind==='join')return this.topicJoinRaw(action.topicId,proof);
      if(action.kind==='invite')return this.chat.rest.operation('topic_join_invite',{...action.input,...proof});
      throw new Error('Unknown proof action');
    }});
  }

  authenticate(input:AuthenticateInput={}) { return this.loginFlow.run(input); }

  /** Select an existing owner-issued permission key; this never creates a key. */
  async configureApiKey(input?:string):Promise<PermissionKeyStatus> {
    this.requireAuth();
    const saved=this.credentialsHome?await readCredentials(this.credentialsHome):null;
    const apiKey=input??this.chat.rest.getApiKey()??saved?.apiKey;
    if(apiKey===undefined)return {configured:false};
    if(!/^osk_[0-9a-f]{48}$/.test(apiKey))throw new Error('Invalid API key format. Enter the complete owner-issued key.');
    const candidate=new OpenStoaClient({baseUrl:this.baseUrl,token:this.chat.rest.getToken()??undefined,apiKey});
    let identity:SessionPayload;
    try { identity=await candidate.auth.session(); }
    catch { throw new Error('Could not validate the API key. Check your login and key, then try again.'); }
    if(!identity.userId||identity.userId!==this.session?.userId)throw new Error('This API key is invalid, revoked, or belongs to another account.');
    if(!this.credentialsHome)throw new Error('Permission key storage is not configured.');
    await writeCredentials(this.credentialsHome,{apiKey});
    this.chat.rest.setApiKey(apiKey);
    const authorization=identity.authorization;
    return {configured:true,...(authorization?{apiKeyId:authorization.apiKeyId,capabilities:authorization.capabilities,historyGrant:authorization.historyGrant}:{})};
  }

  // ── auth ────────────────────────────────────────────────────────────────

  /**
   * Authenticate. Default: dev-login (dev/staging). With `token`, adopt an
   * externally-obtained Bearer (e.g. an isAI session from /api/auth/verify/ai).
   */
  async login(opts: { nickname?: string; token?: string } = {}): Promise<LoginResult> {
    if (opts.token) {
      const s = await this.chat.rest.auth.validateToken(opts.token);
      this.chat.useToken(opts.token);
      await this.persist({ baseUrl: this.baseUrl, token: opts.token, userId: s.userId, nickname: s.nickname });
      return { userId: s.userId, nickname: s.nickname, isAI: s.isAI };
    }
    const r = await this.chat.login(opts.nickname);
    await this.persist({ baseUrl: this.baseUrl, token: r.token, userId: r.userId, nickname: r.nickname });
    return { userId: r.userId, nickname: r.nickname };
  }


  async logout(): Promise<void> {
    await this.store.clear();
    this.session = null;
    this.chat.rest.setToken(null);
  }

  /** Current session payload from the server (includes the isAI badge). */
  async whoami(): Promise<SessionPayload> {
    this.requireAuth();
    const identity = await this.chat.rest.auth.session();
    if (!identity.userId) throw new OpenStoaApiError(401, "GET", "/api/auth/session", { code: "no-credential", error: "Login required" });
    return identity;
  }

  // ── topics ──────────────────────────────────────────────────────────────

  async topicsList(query: { view?: string; sort?: string; category?: string; q?: string } = {}): Promise<Topic[]> {
    this.requireAuth();
    return this.chat.rest.topics.list(query);
  }

  async topicGet(topicId: string): Promise<Topic> {
    this.requireAuth();
    return this.chat.rest.topics.get(topicId);
  }

  async topicCreate(input: CreateTopicInput & TopicProofOptions): Promise<Topic | ProofWorkflowResult> {
    this.requireAuth();
    const { body, options } = splitTopicProofOptions(input);
    try { return await this.chat.rest.topics.create(body); }
    catch (error) { return this.startRequiredTopicProof({kind:'create',input:{...body}}, error, options); }
  }

  proofContinue(input:ProofContinueInput){this.requireAuth();return this.proofs.continue(input);}
  proofStatus(operationId:string){this.requireAuth();return this.proofs.status(operationId);}
  proofResume(operationId:string){this.requireAuth();return this.proofs.resume(operationId);}
  proofCancel(operationId:string){this.requireAuth();return this.proofs.cancel(operationId);}

  /** Join REST membership only. Chat initialization is explicit through chatJoin.
   * A key granting only topic/join must not mutate membership and then fail on
   * an unrelated metadata or MLS permission. 202 remains a pending membership.
   */
  async topicJoin(topicId:string,opts:({proof?:string;publicInputs?:string} & TopicProofOptions)={}):Promise<{topicId:string;joined:boolean;pending?:boolean;message?:string}|ProofWorkflowResult>{
    this.requireAuth();
    const { body, options } = splitTopicProofOptions(opts);
    try { return await this.topicJoinRaw(topicId, body); }
    catch (error) { return this.startRequiredTopicProof({kind:'join',topicId}, error, options); }
  }

  private async topicJoinRaw(
    topicId: string,
    opts: { proof?: string; publicInputs?: string } = {},
  ): Promise<{ topicId: string; joined: boolean; pending?: boolean; message?: string }> {
    this.requireAuth();
    if (opts.proof || opts.publicInputs) {
      if (!opts.proof || !opts.proof.trim()) throw new Error('topic join: proof is required when publicInputs is set');
      if (!opts.publicInputs || !opts.publicInputs.trim()) throw new Error('topic join: publicInputs is required when proof is set');
    }
    const response = await this.chat.rest.request<Response>(`/api/topics/${topicId}/join`, {
      method:'POST', body:opts.proof?{proof:opts.proof,publicInputs:opts.publicInputs}:{}, raw:true,
    });
    const result = await response.json().catch(()=>({})) as Record<string,unknown>;
    if(response.status===202)return {topicId,joined:false,pending:true,message:typeof result.message==='string'?result.message:'Join request submitted; awaiting owner approval.'};
    if(response.status!==200&&response.status!==201)throw new OpenStoaApiError(response.status,'POST',`/api/topics/${topicId}/join`,result);
    return {topicId,joined:true};
  }

  /** Edit the fields supported by the topic route: title, description and image. */
  async topicUpdate(topicId: string, patch: Partial<CreateTopicInput>): Promise<Topic> {
    this.requireAuth();
    const allowed = new Set(['title', 'description', 'image']);
    const fields = Object.keys(patch).filter((key) => patch[key] !== undefined);
    if (!fields.length) throw new Error('topic update: provide title, description or image');
    for (const key of fields) if (!allowed.has(key)) throw new Error(`topic update: unsupported field ${key}`);
    return this.chat.rest.topics.update(topicId, patch);
  }

  /** List a topic's members. */
  async topicMembers(topicId: string): Promise<TopicMember[]> {
    this.requireAuth();
    this.requireAuth();
    return this.chat.rest.topics.members(topicId);
  }

  /** Leave through the dedicated self-service endpoint, preserving idempotent state. */
  async topicLeave(topicId: string): Promise<{ topicId: string; left: boolean }> {
    this.requireAuth();
    const result = await this.chat.rest.topics.leave(topicId);
    return { topicId, left: result.left };
  }

  /** Public operation registry is shared by CLI, MCP, SDK and reference docs. */
  async executeOperation(id: string, input: Record<string, unknown> = {}): Promise<unknown> {
    getRestOperation(id);
    this.requireAuth();
    if (id === 'topic_join_invite') {
      const { body, options } = splitTopicProofOptions(input);
      try { return await this.chat.rest.operation(id, body); }
      catch (error) { return this.startRequiredTopicProof({kind:'invite',input:body}, error, options); }
    }
    return this.chat.rest.operation(id, input);
  }

  // ── posts + comments ──────────────────────────────────────────────────────

  async postList(topicId: string, query: { limit?: number; offset?: number; sort?: string; tag?: string; q?: string } = {}): Promise<Post[]> {
    this.requireAuth();
    return this.chat.rest.topics.posts(topicId, query);
  }

  async postGet(postId: string): Promise<{ post: Post; comments: Comment[] }> {
    this.requireAuth();
    return this.chat.rest.posts.getWithComments(postId);
  }

  async postCreate(topicId: string, input: CreatePostInput): Promise<Post> {
    this.requireAuth();
    return this.chat.rest.topics.createPost(topicId, input);
  }

  async commentList(postId: string): Promise<Comment[]> {
    this.requireAuth();
    return this.chat.rest.posts.comments(postId);
  }

  async commentAdd(postId: string, content: string): Promise<Comment> {
    this.requireAuth();
    if (!content || content.trim().length === 0) throw new Error('comment: content is required');
    return this.chat.rest.posts.addComment(postId, content);
  }

  /** Edit a post (author only): title / content / tags / media. */
  async postUpdate(postId: string, patch: Partial<CreatePostInput>): Promise<Post> {
    this.requireAuth();
    return this.chat.rest.posts.update(postId, patch);
  }

  /** Delete a post (author only). */
  async postDelete(postId: string): Promise<{ id: string; isDeleted: boolean }> {
    this.requireAuth();
    return this.chat.rest.posts.remove(postId);
  }

  /** Soft-delete a comment (author, or topic owner/admin). */
  async commentDelete(commentId: string): Promise<{ commentId: string; deleted: boolean }> {
    this.requireAuth();
    if (!commentId || commentId.trim().length === 0) throw new Error('comment delete: commentId is required');
    await this.chat.rest.comments.remove(commentId);
    return { commentId, deleted: true };
  }

  // ── uploads (image → CDN public URL for embedding in posts / topics / avatar) ──

  /**
   * Upload image bytes to the CDN and get back a permanent public URL. This is
   * the local replacement for the old hosted `upload_image` MCP tool. Callers
   * pass raw bytes (the CLI reads a file; the MCP tool decodes base64). The
   * server also enforces these limits; we fail fast here too.
   */
  async uploadImage(input: {
    data: Uint8Array;
    filename: string;
    contentType: string;
    purpose?: 'post' | 'topic' | 'avatar';
    topicId?: string;
  }): Promise<{ publicUrl: string }> {
    this.requireAuth();
    if (!input.contentType || !input.contentType.startsWith('image/')) {
      throw new Error('upload: only image content types are supported');
    }
    if (!input.filename || input.filename.trim().length === 0) throw new Error('upload: filename is required');
    if (!input.data || input.data.length === 0) throw new Error('upload: image data is empty');
    const MAX_FILE_SIZE = 10 * 1024 * 1024;
    if (input.data.length > MAX_FILE_SIZE) throw new Error('upload: file size must not exceed 10MB');
    return this.chat.rest.uploads.image(input);
  }

  // ── chat (E2EE via ChatClient) ────────────────────────────────────────────

  async chatJoin(topicId: string): Promise<{ topicId: string; deviceId: string }> {
    this.requireAuth();
    await this.chat.joinTopic(topicId);
    return { topicId, deviceId: await this.chat.getDeviceId() };
  }

  /**
   * Seal + send one message. Ensures the MLS session is joined/synced first
   * (idempotent) so a fresh CLI process still holds the latest epoch before
   * sealing. Empty/whitespace text is rejected before anything is sent.
   */
  async chatSend(topicId: string, text: string): Promise<{ messageId: string }> {
    this.requireAuth();
    if (!text || text.trim().length === 0) throw new Error('chat send: message text is required');
    await this.chat.joinTopic(topicId);
    const messageId = await this.chat.sendChat(topicId, text);
    return { messageId };
  }

  /**
   * Seal + send one IMAGE, end-to-end encrypted.
   *
   * Base64 in, because this op is reached through MCP and a CLI — neither can
   * carry raw bytes — and decoded here so the SDK still seals real bytes rather
   * than a string it has to guess the encoding of.
   *
   * The refusals are the shared ones every client applies (`chatMedia.ts`), and
   * they are worth knowing before calling: the MIME allowlist is checked against
   * the DECLARED type, HEIC is refused outright at the sender (the server can no
   * longer transcode what it cannot read), and the size cap is on the sealed
   * bytes. A topic this account is not a member of fails at the upload, not
   * silently.
   */
  async chatSendMedia(
    topicId: string,
    input: { base64: string; mime: string },
  ): Promise<{ messageId: string; key: string; mime: string; size: number }> {
    this.requireAuth();
    if (!input?.base64) throw new Error('chat send-media: base64 image data is required');
    if (!input?.mime) throw new Error('chat send-media: mime is required');
    let bytes: Uint8Array;
    try {
      const bin = atob(input.base64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      throw new Error('chat send-media: base64 is not decodable');
    }
    await this.chat.joinTopic(topicId);
    const { messageId, envelope } = await this.chat.sendMedia(topicId, { bytes, mime: input.mime });
    return { messageId, key: envelope.key, mime: envelope.mime, size: envelope.size };
  }

  /** Read + MLS-decrypt history. Joins/syncs first so a fresh process can decrypt. */
  async chatRead(topicId: string, opts: { limit?: number; since?: string; before?: string } = {}): Promise<ChatMessage[]> {
    this.requireAuth();
    await this.chat.joinTopic(topicId);
    return this.chat.readChat(topicId, opts);
  }

  /** Explicit archive read; keys remain in the local encrypted vault. */
  async chatHistory(topicId: string) {
    this.requireAuth();
    await this.chat.joinTopic(topicId);
    return this.chat.backfill(topicId);
  }

  /** Share locally held room history keys with existing member devices. */
  async chatShareKeys(topicId: string): Promise<{ shared: number }> {
    this.requireAuth();
    await this.chat.joinTopic(topicId);
    return { shared: await this.chat.shareRoomKeys(topicId) };
  }

  // ── dm (1:1 direct chat — a hidden 2-member topic reusing the chat stack) ──

  /**
   * Start (or get) a DM with another user. Idempotent — either party, in either
   * order, resolves to the SAME topicId. Also bootstraps the caller's MLS session
   * so the returned topicId is immediately usable with `dmSend`/`dmRead`.
   */
  async dmStart(peerUserId: string): Promise<{ topicId: string }> {
    this.requireAuth();
    if (!peerUserId || peerUserId.trim().length === 0) throw new Error('dm start: peer userId is required');
    const topicId = await this.chat.startDm(peerUserId);
    return { topicId };
  }

  /** List the caller's DM channels (peer + last activity only — SI-1, no content). */
  async dmList(): Promise<DmChannel[]> {
    this.requireAuth();
    return this.chat.listDms();
  }

  /** Send a message in a DM. Thin alias over `chatSend` on the DM's topicId. */
  async dmSend(topicId: string, text: string): Promise<{ messageId: string }> {
    return this.chatSend(topicId, text);
  }

  /** Read + decrypt DM history. Thin alias over `chatRead` on the DM's topicId. */
  async dmRead(topicId: string, opts: { limit?: number; since?: string; before?: string } = {}): Promise<ChatMessage[]> {
    return this.chatRead(topicId, opts);
  }

  // ── profile ────────────────────────────────────────────────────────────────

  async profileGet(): Promise<SessionPayload> {
    this.requireAuth();
    const identity = await this.chat.rest.auth.session();
    if (!identity.userId) throw new OpenStoaApiError(401, "GET", "/api/auth/session", { code: "no-credential", error: "Login required" });
    return identity;
  }

  async profileSetNickname(nickname: string): Promise<{ nickname: string }> {
    this.requireAuth();
    if (!nickname || nickname.trim().length === 0) throw new Error('profile: nickname is required');
    const r = await this.chat.rest.profile.setNickname(nickname);
    // setNickname may rotate the token (SDK sets it on the REST client already).
    const token = this.chat.rest.getToken() ?? this.session?.token;
    await this.persist({ baseUrl: this.baseUrl, token: token ?? undefined, userId: this.session?.userId, nickname: r.nickname });
    return { nickname: r.nickname };
  }

  // ── categories (helper for topic creation) ──────────────────────────────────

  async categoriesList(): Promise<Category[]> {
    this.requireAuth();
    return this.chat.rest.categories.list();
  }

  // ── API keys (design §7 follow-up: scoped credential, no interactive login) ──

  /** Issue a new scoped API key. The result's `rawKey` is shown ONCE by the caller. */
  async apiKeyCreate(input: ApiKeyCreateInput): Promise<ApiKeyCreateResult> {
    this.requireAuth();
    if (!input.name || input.name.trim().length === 0) throw new Error('apikey create: name is required');
    return this.chat.rest.apiKeys.create(input);
  }

  async apiKeyList(): Promise<ApiKeyMeta[]> {
    this.requireAuth();
    return this.chat.rest.apiKeys.list();
  }

  /**
   * Re-scope a key in place so its holder keeps the secret it already has.
   *
   * `cmd` and `historyGrant` REPLACE the stored scope — the server does not
   * merge — so both are required here rather than optional. A partial update
   * would let `apikey update k1 --cmd ...` silently reset `historyGrant` to a
   * default, quietly revoking archive access the caller never meant to touch.
   */
  async apiKeyUpdate(id: string, input: ApiKeyUpdateInput): Promise<ApiKeyMeta> {
    this.requireAuth();
    if (!id || id.trim().length === 0) throw new Error('apikey update: id is required');
    if (!Array.isArray(input?.cmd)) throw new Error('apikey update: cmd is required (send [] to remove every capability)');
    if (!input?.historyGrant) throw new Error('apikey update: historyGrant is required (send "none" to remove archive access)');
    return this.chat.rest.apiKeys.update(id, input);
  }

  async apiKeyRevoke(id: string): Promise<{ revoked: boolean; id: string }> {
    this.requireAuth();
    if (!id || id.trim().length === 0) throw new Error('apikey revoke: id is required');
    return this.chat.rest.apiKeys.revoke(id);
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async startRequiredTopicProof(action: ProofAction, error: unknown, options: TopicProofOptions): Promise<ProofWorkflowResult> {
    const required = await this.proofs.required(action, error);
    if (options.approved !== true) return required;
    return this.proofs.continue({operationId: required.operationId, method: options.method ?? 'app', approved: true, ...(options.provider ? {provider: options.provider} : {})});
  }

  private requireAuth(): void {
    if (!this.chat.rest.getToken()) {
      throw new OpenStoaApiError(401,'LOCAL','authentication',{status:'authentication_required',message:'Run openstoa login or openstoa_authenticate, complete the proof, then retry with an owner-issued API key.'});
    }
  }

  private async currentUserId(): Promise<string> {
    if (this.session?.userId) return this.session.userId;
    const s = await this.chat.rest.auth.session();
    return s.userId;
  }

  private async persist(data: SessionData): Promise<void> {
    this.session = data;
    await this.store.write(data);
  }
}

/**
 * Build a Commands wired to a real ChatClient + file-backed session. This is the
 * single construction path both the CLI and MCP server use.
 */
/**
 * Resolve the API key to use, in priority order: explicit `config.apiKey` >
 * `OPENSTOA_API_KEY` env > `<home>/credentials` file. Returns undefined if
 * none is set (falls back to the saved interactive-login session token).
 * Exported so the priority chain is directly unit-testable without spinning
 * up a full ChatClient.
 */
export async function resolveApiKey(config: CommandConfig, home: string): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  if (process.env.OPENSTOA_API_KEY) return process.env.OPENSTOA_API_KEY;
  return (await readCredentials(home))?.apiKey;
}

export async function createCommands(config: CommandConfig = {}): Promise<Commands> {
  if (config.backend && config.backend !== 'vault') {
    throw new Error(
      `keystore backend '${config.backend}' is not supported yet — ChatClient only wires the file 'vault' backend for E2EE chat today`,
    );
  }
  const home = resolveHome(config.vaultRoot);
  const sessionStore = new FileSessionStore(path.join(home, 'session.json'));
  const saved = await sessionStore.read();
  const baseUrl = config.baseUrl ?? process.env.OPENSTOA_BASE_URL ?? saved?.baseUrl ?? 'https://www.openstoa.xyz';
  // Load identity and authorization independently. A selected key never
  // replaces the saved proof-login session.
  const apiKey = await resolveApiKey(config, home);
  const chat = new ChatClient({
    baseUrl,
    vaultRoot: config.vaultRoot,
    deviceId: config.deviceId,
    apiKey,
    token: saved?.token,
  });
  return new Commands({ chat, credentialsHome:home, sessionStore, baseUrl, session: saved, proofStore:new FileProofOperationStore(path.join(home,'proof-operations')),loginStore:new FileSessionStore(path.join(home,'login-operation.json')) });
}
