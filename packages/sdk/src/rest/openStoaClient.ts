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
  DmChannel,
  ChatMessageRow,
  CommitLogEntryWire,
  ArchiveEntryWire,
  TakBundleRowWire,
  ConsumedKeyPackageWire,
  ApiKeyUpdateInput,
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
  // dm (1:1 direct chat — a hidden 2-member topic; reuses the chat/MLS/TAK API)
  // -------------------------------------------------------------------------
  readonly dm = {
    /** POST /api/dm — start-or-get a DM with `userId`. Idempotent → same topicId. */
    start: (userId: string): Promise<{ topicId: string }> =>
      this.request<{ topicId: string }>('/api/dm', { method: 'POST', body: { userId } }),
    /** GET /api/dm — the caller's DM channels (routing metadata only, SI-1). */
    list: async (): Promise<DmChannel[]> =>
      (await this.request<{ dms: DmChannel[] }>('/api/dm')).dms,
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
  // uploads (image → CDN)
  // -------------------------------------------------------------------------
  readonly uploads = {
    /**
     * POST /api/upload — multipart/form-data image upload. Returns the permanent
     * public CDN URL to embed in a post/topic/avatar. `data` is the raw image
     * bytes; do NOT set Content-Type — fetch adds the multipart boundary itself.
     */
    image: async (input: {
      data: Uint8Array;
      filename: string;
      contentType: string;
      purpose?: 'post' | 'topic' | 'avatar';
    }): Promise<{ publicUrl: string }> => {
      const form = new FormData();
      // Cast: DOM's BlobPart types a Uint8Array's backing buffer as ArrayBuffer,
      // but TS widens `.buffer` to ArrayBufferLike (incl. SharedArrayBuffer). The
      // bytes are a plain image buffer; the cast is safe.
      form.append('file', new Blob([input.data as BlobPart], { type: input.contentType }), input.filename);
      if (input.purpose) form.append('purpose', input.purpose);
      const headers: Record<string, string> = {};
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const res = await this._fetch(this.url('/api/upload'), { method: 'POST', headers, body: form });
      const text = await res.text();
      let parsed: unknown = text;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          /* non-JSON body kept as text */
        }
      }
      if (!res.ok) throw new OpenStoaApiError(res.status, 'POST', '/api/upload', parsed);
      return parsed as { publicUrl: string };
    },
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
    /**
     * GET /api/topics/{id}/chat/media — one encrypted attachment's CIPHERTEXT.
     *
     * Membership-gated on the server and opaque to it: the bytes are sealed
     * under the topic's TAK, so this only moves ciphertext (SI-1). The caller
     * decrypts with `takSession.openMedia`.
     *
     * `key` comes from the sealed message envelope — never constructed here.
     * The server re-checks that the key belongs to the topic in the URL, so a
     * member of one topic cannot use this to fetch another's object.
     */
    /**
     * POST /api/topics/{id}/chat/media — store one attachment's CIPHERTEXT and
     * get back the object key to name in the sealed message.
     *
     * The key is minted SERVER-side from ids (topic, uploader, mediaId), never
     * from anything the caller supplies: the filename never reaches it, and a
     * caller cannot choose where its object lands. Row is written unclaimed and
     * collected in an hour if the message never goes out.
     */
    uploadMedia: async (topicId: string, mediaId: string, ciphertextB64: string): Promise<string> => {
      const { key } = await this.request<{ key: string }>(`/api/topics/${topicId}/chat/media`, {
        method: 'POST',
        body: { mediaId, ciphertext: ciphertextB64 },
      });
      return key;
    },
    /**
     * DELETE /api/topics/{id}/chat/media — drop an UNCLAIMED object whose
     * message never went out. Uploader-scoped on the server, so this can only
     * ever remove your own orphan. Best-effort: a failed cleanup is one object
     * the hourly collector takes instead, which is strictly better than a
     * caller that thinks its picture was sent.
     */
    discardMedia: async (topicId: string, key: string): Promise<void> => {
      await this.request<Response>(`/api/topics/${topicId}/chat/media`, {
        method: 'DELETE',
        query: { key },
        raw: true,
      });
    },
    media: async (topicId: string, key: string): Promise<Uint8Array | null> => {
      const res = await this.request<Response>(
        `/api/topics/${topicId}/chat/media`,
        { query: { key }, raw: true },
      );
      // 404 = collected or never uploaded; 403 = not a member / foreign key.
      // Neither is an exception: the caller renders "unavailable", it does not
      // abort the whole history read over one missing picture.
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok) throw new Error(`chat media GET ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    /**
     * POST /api/topics/{id}/chat/delivered — move THIS DEVICE's delivery mark.
     *
     * The server keeps a message's live ciphertext only until every device that
     * was in the group when it was sent has fetched it, so a client that never
     * calls this pins its ciphertext until the 30-day grace cap. Best-effort by
     * design: reclaiming server storage must never fail somebody's read.
     */
    delivered: async (topicId: string, deviceId: string, through: string): Promise<void> => {
      await this.request(`/api/topics/${topicId}/chat/delivered`, {
        method: 'POST',
        body: { deviceId, through },
      });
    },
    /** GET /api/topics/{id}/chat — history (sealed bodies + system rows). */
    history: (topicId: string, opts: { limit?: number; since?: string; before?: string } = {}): Promise<{ messages: ChatMessageRow[]; total: number }> =>
      this.request(`/api/topics/${topicId}/chat`, { query: { limit: opts.limit, since: opts.since, before: opts.before } }),
    /**
     * POST /api/topics/{id}/chat — send a sealed body. `message` (plaintext) is
     * rejected server-side. `pushArchive` is the OPTIONAL TAK-sealed copy used
     * only to let a recipient's iOS notification extension preview the message
     * (design §13.6); omitted when absent, and a malformed one is ignored by the
     * server rather than failing the send.
     */
    send: async (
      topicId: string,
      sealed: {
        ciphertext: string;
        epoch: number;
        takVersion?: number | null;
        pushArchive?: { ct: string; takVersion: number };
      },
    ): Promise<ChatMessageRow> =>
      (await this.request<{ message: ChatMessageRow }>(`/api/topics/${topicId}/chat`, {
        method: 'POST',
        body: {
          ciphertext: sealed.ciphertext,
          epoch: sealed.epoch,
          takVersion: sealed.takVersion ?? null,
          ...(sealed.pushArchive ? { pushArchive: sealed.pushArchive } : {}),
        },
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
  // (removed) AI permissions — the profile-level capability set is gone.
  //
  // Authorization now lives on the API KEY, GitHub-PAT style: each key carries
  // its own `cmd` allowlist and `historyGrant`, and that is the only thing the
  // server enforces. `GET`/`PUT /api/profile/ai-permissions` answer 410 Gone.
  // Use `apiKeys.create` to issue a scoped key and `apiKeys.update` to re-scope
  // one. Keeping a wrapper here that could only ever return 410 would be worse
  // than its absence — a caller would discover the retirement at runtime.
  // -------------------------------------------------------------------------

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
    /**
     * PATCH /api/profile/api-keys/{id} — re-scope a key without reissuing it,
     * so the holder keeps the secret it already has. `cmd`/`historyGrant` are
     * replaced wholesale, not merged; send the full intended scope.
     */
    update: async (id: string, input: ApiKeyUpdateInput): Promise<ApiKeyMeta> =>
      (
        await this.request<{ key: ApiKeyMeta }>(`/api/profile/api-keys/${id}`, {
          method: 'PATCH',
          body: input,
        })
      ).key,
    /** DELETE /api/profile/api-keys/{id} — revoke; takes effect immediately. */
    revoke: (id: string): Promise<{ revoked: boolean; id: string }> =>
      this.request(`/api/profile/api-keys/${id}`, { method: 'DELETE' }),
  };
}
