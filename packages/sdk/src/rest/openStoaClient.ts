/**
 * Typed REST wrapper for the OpenStoa HTTP API. Bearer-token auth (no cookies —
 * this is a Node/CLI client, not a browser). Mirrors the exact request/response
 * shapes of openstoa/src/app/api/**. Structured as feature groups so the
 * remaining endpoints are trivial to add.
 *
 * SI-1: this client only ever moves opaque ciphertext + access-control metadata
 * for the chat/MLS/TAK surfaces. It never sends or receives chat plaintext.
 */
import type {
  AuthResult,
  RefreshResult,
  SessionPayload,
  Topic,
  TopicMember,
  CreateTopicInput,
  Post,
  CreatePostInput,
  Comment,
  Category,
  ChatMessageRow,
  CommitLogEntryWire,
  ArchiveEntryWire,
  TakBundleRowWire,
  ConsumedKeyPackageWire,
  AiPermissions,
  AiPermissionsInput,
  ApiKeyMeta,
  ApiKeyCreateInput,
  ApiKeyCreateResult,
} from './types';

export interface OpenStoaClientOptions {
  /** Base origin, e.g. `http://localhost:3200` or `https://openstoa.xyz`. */
  baseUrl: string;
  /** Bearer token (from dev-login / verify). Optional at construction; set later. */
  token?: string;
  /**
   * A scoped API key (`osk_...`, from `POST /api/profile/api-keys`) — an
   * alternative to `token` that lets an agent skip interactive login
   * entirely. Sent identically as `Authorization: Bearer <apiKey>`; the
   * server tells the two apart by prefix. If both are given, `token` wins.
   */
  apiKey?: string;
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** Thrown on any non-2xx response; carries the status and parsed/raw body. */
export class OpenStoaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`${method} ${path} → ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'OpenStoaApiError';
  }
}

interface RequestOpts {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Treat 404 as null instead of throwing (used by MLS group-info GET). */
  nullOn404?: boolean;
  /** Return status only, don't parse (used for conflict-aware commit POST). */
  raw?: boolean;
}

export class OpenStoaClient {
  private baseUrl: string;
  private token: string | null;
  private readonly _fetch: typeof fetch;

  constructor(opts: OpenStoaClientOptions) {
    if (!opts.baseUrl) throw new Error('OpenStoaClient: baseUrl is required');
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token ?? opts.apiKey ?? null;
    this._fetch = opts.fetch ?? globalThis.fetch;
    if (!this._fetch) throw new Error('OpenStoaClient: no fetch available; pass opts.fetch');
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }
  setToken(token: string): void {
    this.token = token;
  }
  getToken(): string | null {
    return this.token;
  }

  private url(path: string, query?: RequestOpts['query']): string {
    const u = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  /** Low-level request. Public so callers can reach endpoints not yet wrapped. */
  async request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
    const method = opts.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await this._fetch(this.url(path, opts.query), { method, headers, body });
    if (res.status === 404 && opts.nullOn404) return null as T;
    if (opts.raw) return res as unknown as T;
    const text = await res.text();
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* non-JSON body kept as text */
      }
    }
    if (!res.ok) throw new OpenStoaApiError(res.status, method, path, parsed);
    return parsed as T;
  }

  // -------------------------------------------------------------------------
  // auth
  // -------------------------------------------------------------------------
  readonly auth = {
    /** POST /api/auth/dev-login — dev/staging only. Mints a Bearer for a fresh user. */
    devLogin: async (nickname?: string): Promise<AuthResult> => {
      const r = await this.request<AuthResult>('/api/auth/dev-login', {
        method: 'POST',
        body: nickname ? { nickname } : {},
      });
      this.token = r.token;
      return r;
    },
    /** POST /api/auth/verify/ai — submit a ZK proof, get an (isAI) session token. */
    verifyAi: async (input: { challengeId: string; proof: string; publicInputs: string }): Promise<AuthResult & { needsNickname?: boolean }> => {
      const r = await this.request<AuthResult & { needsNickname?: boolean }>('/api/auth/verify/ai', {
        method: 'POST',
        body: input,
      });
      if (r.token) this.token = r.token;
      return r;
    },
    /** POST /api/auth/challenge — start the agent proof flow. */
    challenge: (): Promise<{ challengeId: string; scope: string; expiresIn: number }> =>
      this.request('/api/auth/challenge', { method: 'POST', body: {} }),
    /** POST /api/auth/refresh — exchange the current Bearer for a fresh one. */
    refresh: async (): Promise<RefreshResult> => {
      const r = await this.request<RefreshResult>('/api/auth/refresh', { method: 'POST' });
      this.token = r.token;
      return r;
    },
    /** GET /api/auth/session — current session payload. */
    session: (): Promise<SessionPayload> => this.request('/api/auth/session'),
  };

  // -------------------------------------------------------------------------
  // categories
  // -------------------------------------------------------------------------
  readonly categories = {
    list: async (): Promise<Category[]> => (await this.request<{ categories: Category[] }>('/api/categories')).categories,
  };

  // -------------------------------------------------------------------------
  // topics
  // -------------------------------------------------------------------------
  readonly topics = {
    /** GET /api/topics — topics the current user is a member of. */
    list: async (): Promise<Topic[]> => (await this.request<{ topics: Topic[] }>('/api/topics')).topics,
    /** GET /api/topics/{id}. */
    get: async (topicId: string): Promise<Topic> => (await this.request<{ topic: Topic }>(`/api/topics/${topicId}`)).topic,
    /** POST /api/topics — create a topic. */
    create: async (input: CreateTopicInput): Promise<Topic> =>
      (await this.request<{ topic: Topic }>('/api/topics', { method: 'POST', body: input })).topic,
    /** PATCH /api/topics/{id} — owner edit. */
    update: async (topicId: string, patch: Partial<CreateTopicInput>): Promise<Topic> =>
      (await this.request<{ topic: Topic }>(`/api/topics/${topicId}`, { method: 'PATCH', body: patch })).topic,
    /** POST /api/topics/{id}/join. */
    join: (topicId: string): Promise<unknown> => this.request(`/api/topics/${topicId}/join`, { method: 'POST', body: {} }),
    /**
     * DELETE /api/topics/{id}/members — remove (kick) a member by userId
     * (owner/admin only; the server rejects self-removal). There is no
     * self-"leave" endpoint on the server, so this is the only member-removal path.
     */
    removeMember: (topicId: string, userId: string): Promise<unknown> =>
      this.request(`/api/topics/${topicId}/members`, { method: 'DELETE', body: { userId } }),
    /** PATCH /api/topics/{id}/members — change a member's role (owner only). */
    setMemberRole: (topicId: string, userId: string, role: 'owner' | 'admin' | 'member'): Promise<unknown> =>
      this.request(`/api/topics/${topicId}/members`, { method: 'PATCH', body: { userId, role } }),
    /** GET /api/topics/{id}/members. */
    members: async (topicId: string): Promise<TopicMember[]> =>
      (await this.request<{ members: TopicMember[] }>(`/api/topics/${topicId}/members`)).members,
    /** GET /api/topics/join/{inviteCode}. */
    lookupByInvite: async (inviteCode: string): Promise<Topic> =>
      (await this.request<{ topic: Topic }>(`/api/topics/join/${encodeURIComponent(inviteCode)}`)).topic,
    /** GET /api/topics/{id}/posts. */
    posts: async (topicId: string): Promise<Post[]> =>
      (await this.request<{ posts: Post[] }>(`/api/topics/${topicId}/posts`)).posts,
    /** POST /api/topics/{id}/posts — create a post in a topic. */
    createPost: async (topicId: string, input: CreatePostInput): Promise<Post> =>
      (await this.request<{ post: Post }>(`/api/topics/${topicId}/posts`, { method: 'POST', body: input })).post,
  };

  // -------------------------------------------------------------------------
  // posts + comments
  // -------------------------------------------------------------------------
  readonly posts = {
    /** GET /api/posts/{id} — returns the post AND its comments in one response. */
    getWithComments: (postId: string): Promise<{ post: Post; comments: Comment[] }> => this.request(`/api/posts/${postId}`),
    get: async (postId: string): Promise<Post> => (await this.request<{ post: Post }>(`/api/posts/${postId}`)).post,
    update: async (postId: string, patch: Partial<CreatePostInput>): Promise<Post> =>
      (await this.request<{ post: Post }>(`/api/posts/${postId}`, { method: 'PATCH', body: patch })).post,
    remove: (postId: string): Promise<{ id: string; isDeleted: boolean }> =>
      this.request(`/api/posts/${postId}`, { method: 'DELETE' }),
    /** Comments are served by the post-detail endpoint (there is no GET on /comments). */
    comments: async (postId: string): Promise<Comment[]> =>
      (await this.request<{ comments: Comment[] }>(`/api/posts/${postId}`)).comments,
    /** POST /api/posts/{id}/comments. */
    addComment: async (postId: string, content: string): Promise<Comment> =>
      (await this.request<{ comment: Comment }>(`/api/posts/${postId}/comments`, { method: 'POST', body: { content } })).comment,
  };

  readonly comments = {
    remove: (commentId: string): Promise<unknown> => this.request(`/api/comments/${commentId}`, { method: 'DELETE' }),
  };

  // -------------------------------------------------------------------------
  // profile
  // -------------------------------------------------------------------------
  readonly profile = {
    /** PUT /api/profile/nickname — set/replace the nickname. Returns a fresh token. */
    setNickname: async (nickname: string): Promise<{ nickname: string; token?: string }> => {
      const r = await this.request<{ nickname: string; token?: string }>('/api/profile/nickname', {
        method: 'PUT',
        body: { nickname },
      });
      if (r.token) this.token = r.token;
      return r;
    },
  };

  // -------------------------------------------------------------------------
  // chat (E2EE ciphertext transport only — plaintext never crosses this)
  // -------------------------------------------------------------------------
  readonly chat = {
    /** GET /api/topics/{id}/chat — history (sealed bodies + system rows). */
    history: (topicId: string, opts: { limit?: number; since?: string; before?: string } = {}): Promise<{ messages: ChatMessageRow[]; total: number }> =>
      this.request(`/api/topics/${topicId}/chat`, { query: { limit: opts.limit, since: opts.since, before: opts.before } }),
    /** POST /api/topics/{id}/chat — send a sealed body. `message` (plaintext) is rejected server-side. */
    send: async (topicId: string, sealed: { ciphertext: string; epoch: number; takVersion?: number | null }): Promise<ChatMessageRow> =>
      (await this.request<{ message: ChatMessageRow }>(`/api/topics/${topicId}/chat`, {
        method: 'POST',
        body: { ciphertext: sealed.ciphertext, epoch: sealed.epoch, takVersion: sealed.takVersion ?? null },
      })).message,
  };

  // -------------------------------------------------------------------------
  // MLS Delivery Service (group-info / commit / key-packages)
  // -------------------------------------------------------------------------
  readonly mls = {
    getGroupInfo: async (topicId: string): Promise<string | null> => {
      const r = await this.request<{ groupInfo: string } | null>(`/api/topics/${topicId}/mls/group-info`, { nullOn404: true });
      return r ? r.groupInfo : null;
    },
    postGroupInfo: async (topicId: string, groupInfoB64: string, groupIdB64: string): Promise<boolean> =>
      (await this.request<{ created: boolean }>(`/api/topics/${topicId}/mls/group-info`, {
        method: 'POST',
        body: { groupInfo: groupInfoB64, groupId: groupIdB64 },
      })).created,
    /** POST a Commit under epoch-CAS. 409 → { ok:false } for the caller to rebase. */
    postCommit: async (topicId: string, commitB64: string, groupInfoB64: string): Promise<{ ok: boolean; epoch?: number }> => {
      const res = (await this.request<Response>(`/api/topics/${topicId}/mls/commit`, {
        method: 'POST',
        body: { commit: commitB64, groupInfo: groupInfoB64 },
        raw: true,
      })) as unknown as Response;
      if (res.status === 409) return { ok: false };
      if (!res.ok) throw new OpenStoaApiError(res.status, 'POST', `/api/topics/${topicId}/mls/commit`, await res.text());
      return { ok: true, epoch: (await res.json()).epoch as number };
    },
    getCommitsSince: async (topicId: string, sinceEpoch: number): Promise<CommitLogEntryWire[]> =>
      (await this.request<{ commits: CommitLogEntryWire[] }>(`/api/topics/${topicId}/mls/commit`, { query: { sinceEpoch } })).commits,
    publishKeyPackage: (topicId: string, body: { keyPackage: string; deviceId: string; isAI: boolean; isLastResort: boolean }): Promise<{ id: string }> =>
      this.request(`/api/topics/${topicId}/mls/key-packages`, { method: 'POST', body }),
    consumeKeyPackage: (topicId: string, userId: string, deviceId?: string): Promise<ConsumedKeyPackageWire> =>
      this.request(`/api/topics/${topicId}/mls/key-packages`, { query: { userId, deviceId } }),
  };

  // -------------------------------------------------------------------------
  // TAK archive + bundles (opaque ciphertext only)
  // -------------------------------------------------------------------------
  readonly tak = {
    postArchive: (topicId: string, messageId: string, takVersion: number, archiveB64: string): Promise<unknown> =>
      this.request(`/api/topics/${topicId}/archive`, { method: 'POST', body: { messageId, takVersion, archive: archiveB64 } }),
    /** Walks the keyset cursor to completion. */
    getArchive: async (topicId: string): Promise<ArchiveEntryWire[]> => {
      const out: ArchiveEntryWire[] = [];
      let since: string | undefined;
      let sinceMsg: string | undefined;
      for (;;) {
        const page = (await this.request<{ archive: ArchiveEntryWire[] }>(`/api/topics/${topicId}/archive`, {
          query: { limit: 500, since, sinceMsg },
        })).archive;
        out.push(...page);
        if (page.length < 500) break;
        const last = page[page.length - 1];
        since = last.createdAt;
        sinceMsg = last.messageId;
      }
      return out;
    },
    postBundle: (topicId: string, recipientUserId: string, recipientDeviceId: string, bundleB64: string, scope: string): Promise<unknown> =>
      this.request(`/api/topics/${topicId}/tak/bundles`, {
        method: 'POST',
        body: { recipientUserId, recipientDeviceId, bundle: bundleB64, scope },
      }),
    getBundles: async (topicId: string, deviceId: string): Promise<TakBundleRowWire[]> =>
      (await this.request<{ bundles: TakBundleRowWire[] }>(`/api/topics/${topicId}/tak/bundles`, { query: { deviceId } })).bundles,
    ackBundles: (topicId: string, deviceId: string, ids: string[]): Promise<unknown> =>
      this.request(`/api/topics/${topicId}/tak/bundles`, { method: 'DELETE', body: { deviceId, ids } }),
  };

  // -------------------------------------------------------------------------
  // AI permissions (profile-level capability set for the caller's isAI sessions)
  // -------------------------------------------------------------------------
  readonly aiPermissions = {
    /** GET the caller's AI capability configuration (cmd + historyGrant + allowedCmd). */
    get: (): Promise<AiPermissions> =>
      this.request<AiPermissions>(`/api/profile/ai-permissions`),
    /** PUT (replace) the caller's AI capability configuration. */
    set: (input: AiPermissionsInput): Promise<AiPermissions> =>
      this.request<AiPermissions>(`/api/profile/ai-permissions`, { method: 'PUT', body: input }),
  };

  // -------------------------------------------------------------------------
  // API keys (durable, revocable credentials — an agent's `osk_...` Bearer)
  // -------------------------------------------------------------------------
  readonly apiKeys = {
    /** POST /api/profile/api-keys — issue a new scoped key. `rawKey` is shown ONCE. */
    create: (input: ApiKeyCreateInput): Promise<ApiKeyCreateResult> =>
      this.request<ApiKeyCreateResult>(`/api/profile/api-keys`, { method: 'POST', body: input }),
    /** GET /api/profile/api-keys — metadata only, never the raw key or hash. */
    list: async (): Promise<ApiKeyMeta[]> =>
      (await this.request<{ apiKeys: ApiKeyMeta[] }>(`/api/profile/api-keys`)).apiKeys,
    /** DELETE /api/profile/api-keys/{id} — revoke; takes effect immediately. */
    revoke: (id: string): Promise<{ revoked: boolean; id: string }> =>
      this.request(`/api/profile/api-keys/${id}`, { method: 'DELETE' }),
  };
}
