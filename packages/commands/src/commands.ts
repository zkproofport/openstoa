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
import { ChatClient } from '@masselabs/openstoa';
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
import { FileSessionStore, type SessionData, type SessionStore } from './session';
import { readCredentials } from './credentials';
import { resolveHome, type CommandConfig } from './config';
// TEMPORARILY DISABLED — the ZKProofport AI prover (ai.zkproofport.app) is offline
// (shut down for cost). The device flow needs it for the x402 proof step.
// To restore: bring the prover back up, then uncomment this file + the CLI --google
// option + the MCP openstoa_authenticate tool. Nothing else changed.
// import {
//   defaultSpawnProve,
//   startDeviceLogin,
//   awaitProof,
//   type ProveSpawner,
//   type PendingDeviceLogin,
//   type DeviceCodeInfo,
// } from './deviceLogin';
import * as path from 'node:path';

export interface LoginResult {
  userId: string;
  nickname: string;
  isAI?: boolean;
}

// TEMPORARILY DISABLED — see the restore note above (device-flow result types).
// /** Result of a completed Google device-flow login (adds the first-login flag). */
// export interface GoogleLoginResult extends LoginResult {
//   /** True when the user still has a temp `anon_` nickname and must set a real one. */
//   needsNickname?: boolean;
// }
//
// /** Discriminated result of the MCP 2-call `authenticate` handshake. */
// export type GoogleAuthResult =
//   | ({
//       status: 'pending_user_login';
//       verificationUrl: string;
//       userCode: string;
//       instructions: string;
//     })
//   | ({ status: 'authenticated'; message: string } & GoogleLoginResult);

export interface CommandsDeps {
  chat: ChatClient;
  sessionStore: SessionStore;
  baseUrl: string;
  session: SessionData | null;
  // TEMPORARILY DISABLED — see the restore note above.
  // /** Injectable prove.js spawner for the Google device flow (default: real spawn). */
  // proveSpawner?: ProveSpawner;
}

export class Commands {
  private readonly chat: ChatClient;
  private readonly store: SessionStore;
  private readonly baseUrl: string;
  private session: SessionData | null;
  // TEMPORARILY DISABLED — see the restore note at the top of this file.
  // private readonly proveSpawner: ProveSpawner;
  // /** In-flight device login held between the two MCP `authenticate` calls. */
  // private pendingGoogleLogin: PendingDeviceLogin | null = null;

  constructor(deps: CommandsDeps) {
    this.chat = deps.chat;
    this.store = deps.sessionStore;
    this.baseUrl = deps.baseUrl;
    this.session = deps.session;
    // this.proveSpawner = deps.proveSpawner ?? defaultSpawnProve;
  }

  // ── auth ────────────────────────────────────────────────────────────────

  /**
   * Authenticate. Default: dev-login (dev/staging). With `token`, adopt an
   * externally-obtained Bearer (e.g. an isAI session from /api/auth/verify/ai).
   */
  async login(opts: { nickname?: string; token?: string } = {}): Promise<LoginResult> {
    if (opts.token) {
      this.chat.useToken(opts.token);
      const s = await this.chat.rest.auth.session();
      await this.persist({ baseUrl: this.baseUrl, token: opts.token, userId: s.userId, nickname: s.nickname });
      return { userId: s.userId, nickname: s.nickname, isAI: s.isAI };
    }
    const r = await this.chat.login(opts.nickname);
    await this.persist({ baseUrl: this.baseUrl, token: r.token, userId: r.userId, nickname: r.nickname });
    return { userId: r.userId, nickname: r.nickname };
  }


  // TEMPORARILY DISABLED — the ZKProofport AI prover (ai.zkproofport.app) is offline
  // (shut down for cost). The device flow needs it for the x402 proof step.
  // To restore: bring the prover back up, then uncomment this block + ./deviceLogin.ts
  // + the CLI --google option + the MCP openstoa_authenticate tool. Nothing else changed.
  // /**
  //  * Google device-flow login — the human / first-key-bootstrap path (the
  //  * API-key path stays the primary agent credential). Blocking/interactive
  //  * variant for the CLI: it starts the device flow, surfaces the
  //  * `verificationUrl` + `userCode` via `onDeviceCode`, then blocks until the
  //  * user approves at google.com/device, exchanges the proof for an OpenStoa
  //  * session, persists it, and returns the identity.
  //  *
  //  * Ported from the removed hosted `src/lib/mcp/auth.ts` device-flow.
  //  */
  // async loginWithGoogle(
  //   opts: { onDeviceCode?: (info: DeviceCodeInfo) => void; timeoutMs?: number } = {},
  // ): Promise<GoogleLoginResult> {
  //   const pending = await this.startGoogleDeviceFlow(opts.timeoutMs);
  //   opts.onDeviceCode?.({ verificationUrl: pending.verificationUrl, userCode: pending.userCode });
  //   return this.finishGoogleLogin(pending);
  // }
  //
  // /**
  //  * MCP-facing Google login: a single method that implements the ORIGINAL 2-call
  //  * pending/confirm handshake (an MCP tool can't block interactively). First
  //  * call → start the challenge + spawn prove.js, return
  //  * `{ status: 'pending_user_login', verificationUrl, userCode, instructions }`.
  //  * Second call (no args) → await the proof, verify, persist, and return the
  //  * authenticated session. A second call while a login is pending completes it,
  //  * matching the original tool's behavior.
  //  */
  // async authenticateGoogle(opts: { timeoutMs?: number } = {}): Promise<GoogleAuthResult> {
  //   // Phase 2: a login is already pending → finish it.
  //   if (this.pendingGoogleLogin) {
  //     const pending = this.pendingGoogleLogin;
  //     this.pendingGoogleLogin = null;
  //     const r = await this.finishGoogleLogin(pending);
  //     return {
  //       status: 'authenticated',
  //       message:
  //         'Authenticated successfully. Token stored for this session.' +
  //         (r.needsNickname ? ' Call openstoa_profile_set_nickname to set a display name before posting.' : ''),
  //       ...r,
  //     };
  //   }
  //   // Phase 1: start a new device flow.
  //   const pending = await this.startGoogleDeviceFlow(opts.timeoutMs);
  //   this.pendingGoogleLogin = pending;
  //   return {
  //     status: 'pending_user_login',
  //     verificationUrl: pending.verificationUrl,
  //     userCode: pending.userCode,
  //     instructions:
  //       `Tell the human user to open ${pending.verificationUrl} in a browser and enter code ${pending.userCode}. ` +
  //       `Once they confirm login is complete, call openstoa_authenticate again with no arguments. Proof generation takes 30-90 seconds.`,
  //   };
  // }
  //
  // /** Start the challenge, then spawn prove.js and wait for the device code. */
  // private async startGoogleDeviceFlow(timeoutMs?: number): Promise<PendingDeviceLogin> {
  //   const challenge = await this.chat.rest.request<{ challengeId?: string; scope?: string }>(
  //     '/api/auth/challenge',
  //     { method: 'POST', body: {} },
  //   );
  //   if (!challenge?.challengeId || !challenge?.scope) {
  //     throw new Error('auth challenge failed: server did not return a challengeId + scope');
  //   }
  //   return startDeviceLogin(this.proveSpawner, challenge.scope, challenge.challengeId, timeoutMs);
  // }
  //
  // /** Await the proof, verify it at /api/auth/verify/ai, adopt the token, persist. */
  // private async finishGoogleLogin(pending: PendingDeviceLogin): Promise<GoogleLoginResult> {
  //   const proofResult = await awaitProof(pending);
  //   // rest.request throws OpenStoaApiError (status + server body) on a non-2xx,
  //   // so a failed verify surfaces the server error verbatim.
  //   const verify = await this.chat.rest.request<{
  //     token?: string;
  //     userId?: string;
  //     needsNickname?: boolean;
  //     error?: string;
  //   }>('/api/auth/verify/ai', {
  //     method: 'POST',
  //     body: { challengeId: pending.challengeId, result: proofResult },
  //   });
  //   if (!verify?.token) throw new Error(verify?.error ?? 'auth verify/ai did not return a token');
  //   this.chat.useToken(verify.token);
  //   // verify/ai returns no nickname; read it from the session (same as login --token).
  //   const s = await this.chat.rest.auth.session();
  //   await this.persist({ baseUrl: this.baseUrl, token: verify.token, userId: s.userId, nickname: s.nickname });
  //   return { userId: s.userId, nickname: s.nickname, isAI: s.isAI, needsNickname: verify.needsNickname };
  // }
  //

  /** Drop the persisted session (token + identity). Vault MLS keys are untouched. */
  async logout(): Promise<void> {
    // TEMPORARILY DISABLED — device-flow teardown; restore with the block above.
    // this.pendingGoogleLogin?.child.kill();
    // this.pendingGoogleLogin = null;
    await this.store.clear();
    this.session = null;
  }

  /** Current session payload from the server (includes the isAI badge). */
  async whoami(): Promise<SessionPayload> {
    this.requireAuth();
    return this.chat.rest.auth.session();
  }

  // ── topics ──────────────────────────────────────────────────────────────

  async topicsList(): Promise<Topic[]> {
    this.requireAuth();
    return this.chat.rest.topics.list();
  }

  async topicGet(topicId: string): Promise<Topic> {
    this.requireAuth();
    return this.chat.rest.topics.get(topicId);
  }

  async topicCreate(input: CreateTopicInput): Promise<Topic> {
    this.requireAuth();
    return this.chat.rest.topics.create(input);
  }

  /**
   * Join a topic: REST membership + MLS self-join (persists the leaf in the vault).
   *
   * For proof-gated topics (Coinbase KYC / country / workspace), pass a
   * `{ proof, publicInputs }` the agent generated itself — this is the local
   * replacement for the old hosted `join_topic_with_*` device-flow tools. The
   * proof is submitted to `POST /api/topics/{id}/join`:
   *   - 201 → joined; we then run the MLS self-join and return `{ joined: true }`.
   *   - 202 → private topic, request pending owner approval; no MLS join yet.
   *   - 402 → proof required but missing/invalid (throws with the requirement).
   * A public/open topic needs no proof: call with just the topicId.
   */
  async topicJoin(
    topicId: string,
    opts: { proof?: string; publicInputs?: string } = {},
  ): Promise<{ topicId: string; joined: boolean; pending?: boolean; message?: string }> {
    this.requireAuth();
    if (opts.proof || opts.publicInputs) {
      if (!opts.proof || opts.proof.trim().length === 0) throw new Error('topic join: proof is required when publicInputs is set');
      if (!opts.publicInputs || opts.publicInputs.trim().length === 0) throw new Error('topic join: publicInputs is required when proof is set');
      const res = (await this.chat.rest.request(`/api/topics/${topicId}/join`, {
        method: 'POST',
        body: { proof: opts.proof, publicInputs: opts.publicInputs },
        raw: true,
      })) as unknown as Response;
      const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 202) {
        return { topicId, joined: false, pending: true, message: (parsed.message as string | undefined) ?? 'Join request submitted; awaiting owner approval.' };
      }
      if (res.status !== 201 && res.status !== 200) {
        throw new Error((parsed.error as string | undefined) ?? `join failed with status ${res.status}`);
      }
    }
    await this.chat.joinTopic(topicId);
    return { topicId, joined: true };
  }

  /** Edit a topic (owner only): title / description / visibility / category / proofType. */
  async topicUpdate(topicId: string, patch: Partial<CreateTopicInput>): Promise<Topic> {
    this.requireAuth();
    return this.chat.rest.topics.update(topicId, patch);
  }

  /** List a topic's members. */
  async topicMembers(topicId: string): Promise<TopicMember[]> {
    this.requireAuth();
    return this.chat.rest.topics.members(topicId);
  }

  /**
   * Leave a topic. The server exposes no self-"leave" route — only a member
   * removal (`DELETE /members`) which it rejects for self-removal. We surface
   * that honestly rather than pretending to leave.
   */
  async topicLeave(topicId: string): Promise<{ topicId: string; left: boolean }> {
    this.requireAuth();
    const userId = await this.currentUserId();
    await this.chat.rest.topics.removeMember(topicId, userId);
    return { topicId, left: true };
  }

  // ── posts + comments ──────────────────────────────────────────────────────

  async postList(topicId: string): Promise<Post[]> {
    this.requireAuth();
    return this.chat.rest.topics.posts(topicId);
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
    return this.chat.rest.auth.session();
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

  private requireAuth(): void {
    if (!this.chat.rest.getToken()) {
      throw new Error('Not logged in — run `openstoa login` (or `login --token <jwt>`) first.');
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
  const baseUrl = config.baseUrl ?? process.env.OPENSTOA_BASE_URL ?? saved?.baseUrl;
  if (!baseUrl) {
    throw new Error(
      'No OpenStoa base URL. Pass --base-url, set OPENSTOA_BASE_URL, or run `openstoa login --base-url <url>` first.',
    );
  }
  // API-key auth (design §7 follow-up): an agent skips interactive login
  // entirely when a scoped key is available. See resolveApiKey for priority;
  // falling back to the saved session token preserves the pre-existing
  // `openstoa login` flow when no key is configured anywhere.
  const apiKey = await resolveApiKey(config, home);
  const chat = new ChatClient({
    baseUrl,
    vaultRoot: config.vaultRoot,
    deviceId: config.deviceId,
    apiKey,
    token: apiKey ? undefined : saved?.token,
  });
  return new Commands({ chat, sessionStore, baseUrl, session: saved });
}
