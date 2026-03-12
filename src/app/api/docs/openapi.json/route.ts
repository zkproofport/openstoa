import { NextResponse } from 'next/server';

const spec = {
  openapi: '3.0.0',
  info: {
    title: 'ZK Community API',
    version: '0.1.0',
    description:
      'REST API for ZK-gated community platform powered by ZKProofport. Provides zero-knowledge proof authentication, topic management with visibility controls and country-gating, posts, comments, voting, reactions, bookmarks, and user profile management.',
  },
  servers: [
    {
      url: '',
      description: 'Current server',
    },
  ],
  tags: [
    { name: 'Health', description: 'Service health monitoring' },
    {
      name: 'Auth',
      description:
        'Authentication via ZK proof verification. Two flows: (1) Mobile — relay-based proof request + polling, (2) AI Agent — challenge-response with direct proof submission. Both produce JWT session tokens.',
    },
    { name: 'Account', description: 'User account management including deletion' },
    { name: 'Profile', description: 'User profile — nickname and profile image' },
    { name: 'Upload', description: 'File upload via R2 presigned URLs' },
    {
      name: 'Topics',
      description:
        'Community topics with visibility controls (public/private/secret), country-gating, and invite codes',
    },
    {
      name: 'Members',
      description: 'Topic member management — listing, role changes, and removal',
    },
    {
      name: 'JoinRequests',
      description: 'Join request management for private topics',
    },
    {
      name: 'Posts',
      description: 'Posts within topics — CRUD, sorting, and pagination',
    },
    { name: 'Comments', description: 'Comments on posts' },
    { name: 'Votes', description: 'Upvote/downvote system for posts' },
    { name: 'Reactions', description: 'Emoji reactions on posts' },
    { name: 'Bookmarks', description: 'Post bookmarking' },
    { name: 'Pins', description: 'Pin/unpin posts (admin/owner only)' },
    {
      name: 'MyActivity',
      description: "Current user's activity — own posts, liked posts, bookmarks",
    },
    { name: 'Tags', description: 'Tag search and listing' },
    { name: 'OG', description: 'Open Graph metadata proxy for link previews' },
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'zk-community-session',
      },
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
      },
    },
    schemas: {
      Session: {
        type: 'object',
        properties: {
          userId: {
            type: 'string',
            description: 'Unique user identifier derived from ZK proof nullifier',
          },
          nickname: {
            type: 'string',
            description: "User's display name (2-20 chars, alphanumeric + underscore)",
          },
          verifiedAt: {
            type: 'number',
            description: 'Unix timestamp (ms) when the ZK proof was verified',
          },
        },
      },
      Topic: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Unique topic identifier' },
          title: { type: 'string', description: 'Topic title' },
          description: {
            type: 'string',
            nullable: true,
            description: 'Topic description',
          },
          creatorId: {
            type: 'string',
            description: 'User ID of the topic creator',
          },
          requiresCountryProof: {
            type: 'boolean',
            description:
              'Whether joining requires a coinbase_country_attestation ZK proof',
          },
          allowedCountries: {
            type: 'array',
            items: { type: 'string' },
            nullable: true,
            description:
              'ISO 3166-1 alpha-2 country codes allowed (e.g. ["US", "KR"])',
          },
          inviteCode: {
            type: 'string',
            description:
              'Unique 8-char invite code for direct join (bypasses visibility restrictions)',
          },
          visibility: {
            type: 'string',
            enum: ['public', 'private', 'secret'],
            description:
              'public: anyone can join, private: requires approval, secret: invite code only',
          },
          image: {
            type: 'string',
            nullable: true,
            description: 'Topic thumbnail image URL',
          },
          score: {
            type: 'number',
            description: 'Hot ranking score (auto-calculated)',
          },
          lastActivityAt: {
            type: 'string',
            format: 'date-time',
            description: 'Last post/comment activity timestamp',
          },
          memberCount: {
            type: 'integer',
            description: 'Number of members',
          },
          createdAt: { type: 'string', format: 'date-time', description: 'Creation timestamp' },
          updatedAt: { type: 'string', format: 'date-time', description: 'Last update timestamp' },
        },
      },
      TopicListItem: {
        allOf: [
          { $ref: '#/components/schemas/Topic' },
          {
            type: 'object',
            properties: {
              isMember: {
                type: 'boolean',
                description: 'Whether current user is a member',
              },
              currentUserRole: {
                type: 'string',
                nullable: true,
                enum: ['owner', 'admin', 'member'],
                description: "Current user's role if member",
              },
            },
          },
        ],
      },
      Post: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Unique post identifier' },
          topicId: { type: 'string', format: 'uuid', description: 'Parent topic ID' },
          authorId: { type: 'string', description: "Author's user ID" },
          title: { type: 'string', description: 'Post title' },
          content: { type: 'string', description: 'Post body (markdown supported)' },
          media: {
            type: 'object',
            nullable: true,
            description: 'Attached media metadata',
          },
          upvoteCount: { type: 'integer', description: 'Net upvote count' },
          viewCount: {
            type: 'integer',
            description: 'View count (incremented on detail fetch)',
          },
          commentCount: { type: 'integer', description: 'Number of comments' },
          score: { type: 'number', description: 'Popularity score for sorting' },
          isPinned: {
            type: 'boolean',
            description: 'Whether pinned by topic owner/admin',
          },
          createdAt: { type: 'string', format: 'date-time', description: 'Creation timestamp' },
          updatedAt: { type: 'string', format: 'date-time', description: 'Last update timestamp' },
          authorNickname: { type: 'string', description: "Author's display name" },
          authorProfileImage: {
            type: 'string',
            nullable: true,
            description: "Author's profile image URL",
          },
          userVoted: {
            type: 'integer',
            nullable: true,
            description: "Current user's vote (1, -1, or null)",
          },
          tags: {
            type: 'array',
            description: 'Tags attached to the post',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Tag display name' },
                slug: { type: 'string', description: 'URL-safe tag slug' },
              },
            },
          },
        },
      },
      Comment: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Unique comment identifier' },
          postId: { type: 'string', format: 'uuid', description: 'Parent post ID' },
          authorId: { type: 'string', description: "Commenter's user ID" },
          content: { type: 'string', description: 'Comment body (plain text)' },
          createdAt: { type: 'string', format: 'date-time', description: 'Creation timestamp' },
          authorNickname: { type: 'string', description: "Commenter's display name" },
          authorProfileImage: {
            type: 'string',
            nullable: true,
            description: "Commenter's profile image URL",
          },
        },
      },
      Member: {
        type: 'object',
        properties: {
          userId: { type: 'string', description: "Member's user ID" },
          nickname: { type: 'string', description: 'Display name' },
          role: {
            type: 'string',
            enum: ['owner', 'admin', 'member'],
            description: 'Role in the topic',
          },
          profileImage: {
            type: 'string',
            nullable: true,
            description: 'Profile image URL',
          },
          joinedAt: { type: 'string', format: 'date-time', description: 'When the member joined' },
        },
      },
      JoinRequest: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Unique request identifier' },
          userId: { type: 'string', description: "Requesting user's ID" },
          nickname: { type: 'string', description: "Requesting user's display name" },
          profileImage: {
            type: 'string',
            nullable: true,
            description: "Requesting user's profile image URL",
          },
          status: {
            type: 'string',
            enum: ['pending', 'approved', 'rejected'],
            description: 'Current request status',
          },
          createdAt: { type: 'string', format: 'date-time', description: 'When the request was created' },
        },
      },
      Tag: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Unique tag identifier' },
          name: { type: 'string', description: 'Display name' },
          slug: { type: 'string', description: 'URL-safe slug (used for filtering)' },
          postCount: { type: 'integer', description: 'Number of posts using this tag' },
          createdAt: { type: 'string', format: 'date-time', description: 'Creation timestamp' },
        },
      },
      ReactionSummary: {
        type: 'object',
        properties: {
          emoji: {
            type: 'string',
            description: 'One of the 6 allowed emojis',
          },
          count: { type: 'integer', description: 'Total reaction count' },
          userReacted: {
            type: 'boolean',
            description: 'Whether current user reacted with this emoji',
          },
        },
      },
      Error400: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Error message describing the bad request' },
        },
      },
      Error401: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'Not authenticated', description: 'Authentication error message' },
        },
      },
      Error403: {
        type: 'object',
        properties: {
          error: {
            type: 'string',
            example: 'Nickname required. Set your nickname at /profile first.',
            description: 'Authorization error message',
          },
        },
      },
      Error404: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Resource not found message' },
        },
      },
      Error409: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Conflict error message' },
        },
      },
    },
    responses: {
      BadRequest: {
        description: 'Bad request — invalid parameters or body',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error400' },
          },
        },
      },
      Unauthorized: {
        description: 'Not authenticated — missing or invalid session/token',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error401' },
          },
        },
      },
      Forbidden: {
        description: 'Authenticated but not authorized (e.g. no nickname set, not a member, insufficient role)',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error403' },
          },
        },
      },
      NotFound: {
        description: 'Resource not found',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error404' },
          },
        },
      },
      Conflict: {
        description: 'Conflict — duplicate resource or invalid state transition',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error409' },
          },
        },
      },
    },
  },
  security: [{ cookieAuth: [] }, { bearerAuth: [] }],
  paths: {
    // ─── Health ───────────────────────────────────────────────────────────
    '/api/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        description: 'Returns service health status, uptime, and current timestamp.',
        operationId: 'getHealth',
        security: [],
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok', description: 'Health status indicator' },
                    timestamp: {
                      type: 'string',
                      format: 'date-time',
                      description: 'Current server timestamp',
                    },
                    uptime: { type: 'number', description: 'Process uptime in seconds' },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ─── Auth ─────────────────────────────────────────────────────────────
    '/api/auth/proof-request': {
      post: {
        tags: ['Auth'],
        summary: 'Create relay proof request for mobile flow',
        description:
          'Initiates mobile ZK proof authentication. Creates a relay request and returns a deep link that opens the ZKProofport mobile app for proof generation. The client should then poll /api/auth/poll/{requestId} for the result.',
        operationId: 'createProofRequest',
        security: [],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  circuitType: {
                    type: 'string',
                    enum: ['coinbase_attestation', 'coinbase_country_attestation'],
                    description: 'ZK circuit type to request proof for',
                  },
                  scope: {
                    type: 'string',
                    description: 'Custom scope string for the proof request',
                  },
                  countryList: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'ISO 3166-1 alpha-2 country codes for country attestation',
                  },
                  isIncluded: {
                    type: 'boolean',
                    description: 'Whether countryList is an inclusion list (true) or exclusion list (false)',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Proof request created successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    requestId: { type: 'string', description: 'Unique relay request identifier for polling' },
                    deepLink: {
                      type: 'string',
                      example: 'zkproofport://proof-request?...',
                      description: 'Deep link URL to open the ZKProofport mobile app',
                    },
                    scope: { type: 'string', description: 'Scope string embedded in the proof request' },
                    circuitType: { type: 'string', description: 'Circuit type requested' },
                  },
                },
              },
            },
          },
        },
      },
    },

    '/api/auth/poll/{requestId}': {
      get: {
        tags: ['Auth'],
        summary: 'Poll relay for proof result',
        description:
          'Polls the relay server for ZK proof generation status. When completed, verifies the proof on-chain, creates/retrieves the user account, and issues a session. Use mode=proof to get raw proof data without creating a session (used for country-gated topic operations).',
        operationId: 'pollProofResult',
        security: [],
        parameters: [
          {
            name: 'requestId',
            in: 'path',
            required: true,
            description: 'Relay request ID from /api/auth/proof-request',
            schema: { type: 'string' },
          },
          {
            name: 'mode',
            in: 'query',
            required: false,
            description: 'Set to "proof" to get raw proof data without creating a session',
            schema: { type: 'string', enum: ['proof'] },
          },
        ],
        responses: {
          '200': {
            description: 'Poll result — status may be pending, failed, or completed',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      description: 'Proof generation still in progress or failed',
                      properties: {
                        status: {
                          type: 'string',
                          enum: ['pending', 'failed'],
                          description: 'Current proof generation status',
                        },
                      },
                    },
                    {
                      type: 'object',
                      description: 'Proof completed — session created (default mode)',
                      properties: {
                        status: { type: 'string', enum: ['completed'], description: 'Completed status' },
                        userId: { type: 'string', description: 'Authenticated user ID' },
                        needsNickname: {
                          type: 'boolean',
                          description: 'Whether the user still needs to set a nickname',
                        },
                      },
                    },
                    {
                      type: 'object',
                      description: 'Proof completed — raw proof data (mode=proof)',
                      properties: {
                        status: { type: 'string', enum: ['completed'], description: 'Completed status' },
                        proof: { type: 'string', description: '0x-prefixed proof hex string' },
                        publicInputs: {
                          type: 'array',
                          items: { type: 'string' },
                          description: 'Array of 0x-prefixed public input hex strings',
                        },
                        circuit: { type: 'string', description: 'Circuit type that was proven' },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },

    '/api/auth/challenge': {
      post: {
        tags: ['Auth'],
        summary: 'Create challenge for AI agent auth',
        description:
          'Creates a one-time challenge for AI agent authentication. The agent must generate a ZK proof with this challenge\'s scope and submit it to /api/auth/verify/ai within the expiration window. Challenge is single-use and expires in 5 minutes.',
        operationId: 'createChallenge',
        security: [],
        responses: {
          '200': {
            description: 'Challenge created successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    challengeId: { type: 'string', description: 'Unique challenge identifier' },
                    scope: {
                      type: 'string',
                      description: 'Scope string that must be included in the ZK proof',
                    },
                    expiresIn: {
                      type: 'number',
                      description: 'Seconds until the challenge expires',
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    '/api/auth/verify/ai': {
      post: {
        tags: ['Auth'],
        summary: 'Verify AI agent proof and get session token',
        description:
          'Verifies an AI agent\'s ZK proof against a previously issued challenge. On success, creates/retrieves the user account and returns both a session cookie and a Bearer token. The Bearer token can be used for subsequent API calls via the Authorization header.',
        operationId: 'verifyAiProof',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['challengeId', 'result'],
                properties: {
                  challengeId: { type: 'string', description: 'Challenge ID from /api/auth/challenge' },
                  result: {
                    type: 'object',
                    description: 'Proof result from the ZK proof generation',
                    required: ['proof', 'publicInputs', 'verification'],
                    properties: {
                      proof: { type: 'string', description: '0x-prefixed proof hex string' },
                      publicInputs: { type: 'string', description: '0x-prefixed public inputs hex string' },
                      verification: {
                        type: 'object',
                        description: 'On-chain verification parameters',
                        required: ['chainId', 'verifierAddress', 'rpcUrl'],
                        properties: {
                          chainId: {
                            type: 'number',
                            example: 8453,
                            description: 'Chain ID where the verifier contract is deployed',
                          },
                          verifierAddress: {
                            type: 'string',
                            example: '0xf7ded73e7a7fc8fb030c35c5a88d40abe6865382',
                            description: 'Address of the on-chain verifier contract',
                          },
                          rpcUrl: {
                            type: 'string',
                            example: 'https://mainnet.base.org',
                            description: 'RPC URL for the target chain',
                          },
                        },
                      },
                      proofWithInputs: {
                        type: 'string',
                        description: 'Combined proof + public inputs hex (optional)',
                      },
                      attestation: {
                        type: 'object',
                        nullable: true,
                        description: 'Raw attestation data (optional)',
                      },
                      timing: {
                        type: 'object',
                        description: 'Proof generation timing metadata (optional)',
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Verification successful. Sets session cookie and returns Bearer token.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    userId: { type: 'string', description: 'Authenticated user ID' },
                    needsNickname: {
                      type: 'boolean',
                      description: 'Whether the user still needs to set a nickname',
                    },
                    token: {
                      type: 'string',
                      description: 'Bearer token for subsequent API calls',
                    },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid challenge, expired, scope mismatch, or on-chain verification failure',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error400' },
              },
            },
          },
        },
      },
    },

    '/api/auth/session': {
      get: {
        tags: ['Auth'],
        summary: 'Get current session info',
        description:
          "Returns the current authenticated user's session information. Works with both cookie and Bearer token authentication.",
        operationId: 'getSession',
        responses: {
          '200': {
            description: 'Current session information',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Session' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/api/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Logout (clears session cookie)',
        description:
          'Clears the session cookie. For Bearer token users, simply discard the token client-side.',
        operationId: 'logout',
        security: [],
        responses: {
          '200': {
            description: 'Logged out successfully',
          },
        },
      },
    },

    '/api/auth/token-login': {
      get: {
        tags: ['Auth'],
        summary: 'Convert Bearer token to browser session',
        description:
          'Converts a Bearer token into a browser session cookie and redirects to the appropriate page. Used when AI agents need to open a browser context with their authenticated session.',
        operationId: 'tokenLogin',
        security: [],
        parameters: [
          {
            name: 'token',
            in: 'query',
            required: true,
            description: 'Bearer token to convert into a session cookie',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '302': {
            description: 'Redirect to /profile (if needs nickname) or /topics',
          },
        },
      },
    },

    // ─── Account ──────────────────────────────────────────────────────────
    '/api/account': {
      delete: {
        tags: ['Account'],
        summary: 'Delete user account',
        description:
          "Permanently deletes the user account. Anonymizes the user's nickname to '[Withdrawn User]_<random>', sets deletedAt, removes all memberships/votes/bookmarks, and clears the session. Posts and comments are preserved but orphaned. Fails if the user owns any topics (must transfer ownership first).",
        operationId: 'deleteAccount',
        responses: {
          '200': {
            description: 'Account deleted successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true, description: 'Deletion success indicator' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '409': {
            description: 'User owns topics — must transfer ownership first',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string', description: 'Error message explaining the conflict' },
                    topics: {
                      type: 'array',
                      description: 'List of topics the user owns',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', description: 'Topic ID' },
                          title: { type: 'string', description: 'Topic title' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ─── Profile ──────────────────────────────────────────────────────────
    '/api/profile/nickname': {
      put: {
        tags: ['Profile'],
        summary: 'Set or update nickname',
        description:
          'Sets or updates the user\'s display nickname. Required after first login. Must be 2-20 characters, alphanumeric and underscores only. Reissues the session cookie/token with the updated nickname.',
        operationId: 'setNickname',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['nickname'],
                properties: {
                  nickname: {
                    type: 'string',
                    pattern: '^[a-zA-Z0-9_]{2,20}$',
                    description: 'Display name (2-20 chars, alphanumeric + underscore)',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Nickname updated successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    nickname: { type: 'string', description: 'The updated nickname' },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid nickname format',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error400' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '409': {
            description: 'Nickname already taken',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error409' },
              },
            },
          },
        },
      },
    },

    '/api/profile/image': {
      get: {
        tags: ['Profile'],
        summary: 'Get profile image',
        description: "Returns the current user's profile image URL.",
        operationId: 'getProfileImage',
        responses: {
          '200': {
            description: 'Profile image URL',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    profileImage: {
                      type: 'string',
                      nullable: true,
                      description: 'Profile image URL, or null if not set',
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
      put: {
        tags: ['Profile'],
        summary: 'Set profile image',
        description: "Sets the user's profile image URL. Use the /api/upload endpoint first to upload the image and get the public URL.",
        operationId: 'setProfileImage',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['imageUrl'],
                properties: {
                  imageUrl: {
                    type: 'string',
                    description: 'Public URL of the uploaded image (from /api/upload)',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Profile image updated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true, description: 'Update success indicator' },
                    profileImage: { type: 'string', description: 'Updated profile image URL' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
      delete: {
        tags: ['Profile'],
        summary: 'Remove profile image',
        description: "Removes the user's profile image.",
        operationId: 'deleteProfileImage',
        responses: {
          '200': {
            description: 'Profile image removed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true, description: 'Deletion success indicator' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    // ─── Upload ───────────────────────────────────────────────────────────
    '/api/upload': {
      post: {
        tags: ['Upload'],
        summary: 'Get presigned upload URL',
        description:
          'Generates an R2 presigned URL for direct file upload. The client uploads the file directly to R2 using the returned uploadUrl (PUT request with the file as body), then uses the publicUrl in subsequent API calls.',
        operationId: 'createUploadUrl',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['filename', 'contentType'],
                properties: {
                  filename: { type: 'string', description: 'Original filename' },
                  contentType: {
                    type: 'string',
                    description: 'MIME type (must start with "image/")',
                  },
                  size: { type: 'number', description: 'File size in bytes (optional)' },
                  purpose: {
                    type: 'string',
                    enum: ['post', 'topic', 'avatar'],
                    description: 'Upload purpose for path organization',
                  },
                  width: { type: 'number', description: 'Image width in pixels (optional)' },
                  height: { type: 'number', description: 'Image height in pixels (optional)' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Presigned upload URL generated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    uploadUrl: {
                      type: 'string',
                      description: 'Presigned PUT URL for direct upload (10 min TTL)',
                    },
                    publicUrl: {
                      type: 'string',
                      description: 'Permanent public URL for the uploaded file',
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    // ─── OG ───────────────────────────────────────────────────────────────
    '/api/og': {
      get: {
        tags: ['OG'],
        summary: 'Fetch Open Graph metadata',
        description:
          'Server-side Open Graph metadata scraper. Fetches and parses OG tags from a given URL for link preview rendering. Results are cached for 1 hour.',
        operationId: 'getOgMetadata',
        security: [],
        parameters: [
          {
            name: 'url',
            in: 'query',
            required: true,
            description: 'URL to scrape OG metadata from (must be http/https)',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'OG metadata extracted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', description: 'Page title (og:title)' },
                    description: { type: 'string', description: 'Page description (og:description)' },
                    image: { type: 'string', description: 'Preview image URL (og:image)' },
                    siteName: { type: 'string', description: 'Site name (og:site_name)' },
                    favicon: { type: 'string', description: 'Site favicon URL' },
                    url: { type: 'string', description: 'Canonical URL' },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ─── Tags ─────────────────────────────────────────────────────────────
    '/api/tags': {
      get: {
        tags: ['Tags'],
        summary: 'Search and list tags',
        description:
          'Searches and lists tags. With q parameter, performs prefix search (up to 10 results). Without q, returns most-used tags (up to 20). Optionally scoped to a specific topic.',
        operationId: 'listTags',
        parameters: [
          {
            name: 'q',
            in: 'query',
            required: false,
            description: 'Prefix search query (returns up to 10 matches)',
            schema: { type: 'string' },
          },
          {
            name: 'topicId',
            in: 'query',
            required: false,
            description: 'Scope tag search to a specific topic',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'List of tags',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    tags: {
                      type: 'array',
                      description: 'Matching tags',
                      items: { $ref: '#/components/schemas/Tag' },
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    // ─── Topics ───────────────────────────────────────────────────────────
    '/api/topics': {
      get: {
        tags: ['Topics'],
        summary: 'List topics',
        description:
          "Lists topics. Without view parameter, returns only the current user's joined topics. With view=all, returns all visible topics (excludes secret topics unless user is a member) with membership status. Supports sorting.",
        operationId: 'listTopics',
        parameters: [
          {
            name: 'view',
            in: 'query',
            required: false,
            description: 'Set to "all" to see all visible topics instead of only joined topics',
            schema: { type: 'string', enum: ['all'] },
          },
          {
            name: 'sort',
            in: 'query',
            required: false,
            description: 'Sort order (only applies when view=all)',
            schema: { type: 'string', enum: ['hot', 'new', 'active', 'top'] },
          },
        ],
        responses: {
          '200': {
            description: 'Topics list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    topics: {
                      type: 'array',
                      description: 'List of topics with membership info',
                      items: { $ref: '#/components/schemas/TopicListItem' },
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
      post: {
        tags: ['Topics'],
        summary: 'Create topic',
        description:
          'Creates a new topic. The creator is automatically added as the owner. For country-gated topics (requiresCountryProof=true), the creator must also provide a valid coinbase_country_attestation proof proving they are in one of the allowed countries.',
        operationId: 'createTopic',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title'],
                properties: {
                  title: { type: 'string', description: 'Topic title' },
                  description: { type: 'string', description: 'Topic description (optional)' },
                  requiresCountryProof: {
                    type: 'boolean',
                    description: 'Whether joining requires a country attestation proof',
                  },
                  allowedCountries: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'ISO 3166-1 alpha-2 country codes allowed',
                  },
                  proof: {
                    type: 'string',
                    description: 'Country attestation proof hex (required if requiresCountryProof=true)',
                  },
                  publicInputs: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Proof public inputs (required if requiresCountryProof=true)',
                  },
                  image: { type: 'string', description: 'Topic thumbnail image URL (from /api/upload)' },
                  visibility: {
                    type: 'string',
                    enum: ['public', 'private', 'secret'],
                    description: 'Topic visibility (defaults to public)',
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Topic created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    topic: { $ref: '#/components/schemas/Topic' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/api/topics/{topicId}': {
      get: {
        tags: ['Topics'],
        summary: 'Get topic detail',
        description:
          "Returns detailed information about a topic including the current user's role. Requires topic membership.",
        operationId: 'getTopic',
        parameters: [
          {
            name: 'topicId',
            in: 'path',
            required: true,
            description: 'Topic ID',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Topic detail with current user role',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    topic: {
                      allOf: [
                        { $ref: '#/components/schemas/Topic' },
                        {
                          type: 'object',
                          properties: {
                            memberCount: {
                              type: 'integer',
                              description: 'Number of members in the topic',
                            },
                          },
                        },
                      ],
                    },
                    currentUserRole: {
                      type: 'string',
                      enum: ['owner', 'admin', 'member'],
                      description: "Current user's role in the topic",
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': {
            description: 'Not a member of this topic',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error403' },
              },
            },
          },
        },
      },
    },

    // ─── Invite Code ──────────────────────────────────────────────────────
    '/api/topics/join/{inviteCode}': {
      get: {
        tags: ['Topics'],
        summary: 'Lookup topic by invite code',
        description:
          'Looks up a topic by its invite code. Returns topic info and whether the current user is already a member. Used to show a preview before joining.',
        operationId: 'lookupInviteCode',
        parameters: [
          {
            name: 'inviteCode',
            in: 'path',
            required: true,
            description: '8-character invite code',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Topic found by invite code',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    topic: {
                      type: 'object',
                      description: 'Topic preview information',
                      properties: {
                        id: { type: 'string', format: 'uuid', description: 'Topic ID' },
                        title: { type: 'string', description: 'Topic title' },
                        description: {
                          type: 'string',
                          nullable: true,
                          description: 'Topic description',
                        },
                        requiresCountryProof: {
                          type: 'boolean',
                          description: 'Whether country proof is required to join',
                        },
                        allowedCountries: {
                          type: 'array',
                          items: { type: 'string' },
                          nullable: true,
                          description: 'Allowed country codes',
                        },
                        visibility: {
                          type: 'string',
                          enum: ['public', 'private', 'secret'],
                          description: 'Topic visibility level',
                        },
                      },
                    },
                    isMember: {
                      type: 'boolean',
                      description: 'Whether the current user is already a member',
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': {
            description: 'Invalid invite code',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error404' },
              },
            },
          },
        },
      },
      post: {
        tags: ['Topics'],
        summary: 'Join topic via invite code',
        description:
          'Joins a topic via invite code. Bypasses all visibility restrictions (public, private, secret). For country-gated topics, country proof is still required.',
        operationId: 'joinByInviteCode',
        parameters: [
          {
            name: 'inviteCode',
            in: 'path',
            required: true,
            description: '8-character invite code',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '201': {
            description: 'Successfully joined the topic',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true, description: 'Join success indicator' },
                    topicId: { type: 'string', description: 'ID of the joined topic' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': {
            description: 'Invalid invite code',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error404' },
              },
            },
          },
          '409': {
            description: 'Already a member of this topic',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error409' },
              },
            },
          },
        },
      },
    },

    // ─── Join by topicId ──────────────────────────────────────────────────
    '/api/topics/{topicId}/join': {
      post: {
        tags: ['Topics'],
        summary: 'Join or request to join topic',
        description:
          'Requests to join a topic. For public topics, joins immediately. For private topics, creates a pending join request that must be approved by a topic owner or admin. Secret topics cannot be joined directly (use invite code). Country-gated topics require a valid ZK proof.',
        operationId: 'joinTopic',
        parameters: [
          {
            name: 'topicId',
            in: 'path',
            required: true,
            description: 'Topic ID to join',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description: 'Required only if topic requires country proof',
                properties: {
                  proof: { type: 'string', description: 'Country attestation proof hex string' },
                  publicInputs: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Proof public inputs as hex strings',
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Joined public topic immediately',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true, description: 'Join success indicator' },
                  },
                },
              },
            },
          },
          '202': {
            description: 'Join request created for private topic (pending approval)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true, description: 'Request creation success' },
                    status: {
                      type: 'string',
                      example: 'pending',
                      description: 'Join request status',
                    },
                    message: { type: 'string', description: 'Human-readable status message' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': {
            description: 'Secret topic (use invite code) or country not in allowed list',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error403' },
              },
            },
          },
          '409': {
            description: 'Already a member or join request already pending',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error409' },
              },
            },
          },
        },
      },
    },

    // ─── Members ──────────────────────────────────────────────────────────
    '/api/topics/{topicId}/members': {
      get: {
        tags: ['Members'],
        summary: 'List topic members',
        description:
          'Lists all members of a topic, sorted by role (owner then admin then member). Supports nickname prefix search for @mention autocomplete.',
        operationId: 'listMembers',
        parameters: [
          {
            name: 'topicId',
            in: 'path',
            required: true,
            description: 'Topic ID',
            schema: { type: 'string', format: 'uuid' },
          },
          {
            name: 'q',
            in: 'query',
            required: false,
            description: 'Nickname prefix search (returns up to 10 matches)',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'List of topic members',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    members: {
                      type: 'array',
                      description: 'Topic members sorted by role',
                      items: { $ref: '#/components/schemas/Member' },
                    },
                    currentUserRole: {
                      type: 'string',
                      description: "Current user's role in the topic",
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
      patch: {
        tags: ['Members'],
        summary: 'Change member role',
        description:
          "Changes a member's role. Only the topic owner can change roles. Transferring ownership (setting another member to 'owner') automatically demotes the current owner to 'admin'.",
        operationId: 'changeMemberRole',
        parameters: [
          {
            name: 'topicId',
            in: 'path',
            required: true,
            description: 'Topic ID',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['userId', 'role'],
                properties: {
                  userId: { type: 'string', description: 'User ID of the member to update' },
                  role: {
                    type: 'string',
                    enum: ['owner', 'admin', 'member'],
                    description: 'New role to assign',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Role changed successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true, description: 'Update success indicator' },
                    role: { type: 'string', description: 'New role assigned' },
                    transferred: {
                      type: 'boolean',
                      description: 'Whether ownership was transferred (current owner demoted to admin)',
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
      delete: {
        tags: ['Members'],
        summary: 'Remove member from topic',
        description:
          'Removes a member from the topic. Admins can only remove regular members. Owners can remove anyone except themselves.',
        operationId: 'removeMember',
        parameters: [
          {
            name: 'topicId',
            in: 'path',
            required: true,
            description: 'Topic ID',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['userId'],
                properties: {
                  userId: { type: 'string', description: 'User ID of the member to remove' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Member removed successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true, description: 'Removal success indicator' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': {
            description: 'Insufficient permissions to remove this member',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error403' },
              },
            },
          },
        },
      },
    },

    // ─── Join Requests ────────────────────────────────────────────────────
    '/api/topics/{topicId}/requests': {
      get: {
        tags: ['JoinRequests'],
        summary: 'List join requests',
        description:
          'Lists join requests for a private topic. By default returns only pending requests. Use status=all to see all requests including approved and rejected.',
        operationId: 'listJoinRequests',
        parameters: [
          {
            name: 'topicId',
            in: 'path',
            required: true,
            description: 'Topic ID',
            schema: { type: 'string', format: 'uuid' },
          },
          {
            name: 'status',
            in: 'query',
            required: false,
            description: 'Set to "all" to include approved and rejected requests',
            schema: { type: 'string', enum: ['all'] },
          },
        ],
        responses: {
          '200': {
            description: 'List of join requests',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    requests: {
                      type: 'array',
                      description: 'Join requests for the topic',
                      items: { $ref: '#/components/schemas/JoinRequest' },
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
      patch: {
        tags: ['JoinRequests'],
        summary: 'Approve or reject join request',
        description:
          'Approves or rejects a pending join request. Approving automatically adds the user as a member.',
        operationId: 'handleJoinRequest',
        parameters: [
          {
            name: 'topicId',
            in: 'path',
            required: true,
            description: 'Topic ID',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['requestId', 'action'],
                properties: {
                  requestId: { type: 'string', description: 'Join request ID to act on' },
                  action: {
                    type: 'string',
                    enum: ['approve', 'reject'],
                    description: 'Action to take on the request',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Request handled successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true, description: 'Action success indicator' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    // ─── Posts ─────────────────────────────────────────────────────────────
    '/api/topics/{topicId}/posts': {
      get: {
        tags: ['Posts'],
        summary: 'List posts in topic',
        description:
          'Lists posts in a topic with pagination. Pinned posts always appear first regardless of sort order. Supports tag filtering and sorting by newest or popularity.',
        operationId: 'listPosts',
        parameters: [
          {
            name: 'topicId',
            in: 'path',
            required: true,
            description: 'Topic ID',
            schema: { type: 'string', format: 'uuid' },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Number of posts to return (max 100)',
            schema: { type: 'integer', default: 20, maximum: 100 },
          },
          {
            name: 'offset',
            in: 'query',
            required: false,
            description: 'Number of posts to skip',
            schema: { type: 'integer', default: 0 },
          },
          {
            name: 'tag',
            in: 'query',
            required: false,
            description: 'Filter by tag slug',
            schema: { type: 'string' },
          },
          {
            name: 'sort',
            in: 'query',
            required: false,
            description: 'Sort order',
            schema: { type: 'string', enum: ['new', 'popular'], default: 'new' },
          },
        ],
        responses: {
          '200': {
            description: 'Paginated list of posts (pinned posts first)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    posts: {
                      type: 'array',
                      description: 'Posts in the topic',
                      items: { $ref: '#/components/schemas/Post' },
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
      post: {
        tags: ['Posts'],
        summary: 'Create post in topic',
        description:
          "Creates a new post in a topic. Supports up to 5 tags (created automatically if they don't exist). Triggers async topic score recalculation.",
        operationId: 'createPost',
        parameters: [
          {
            name: 'topicId',
            in: 'path',
            required: true,
            description: 'Topic ID',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title', 'content'],
                properties: {
                  title: { type: 'string', description: 'Post title' },
                  content: { type: 'string', description: 'Post body (markdown supported)' },
                  media: { type: 'object', description: 'Attached media metadata (optional)' },
                  tags: {
                    type: 'array',
                    items: { type: 'string' },
                    maxItems: 5,
                    description: 'Tag names (max 5, auto-created if new)',
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Post created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    post: { $ref: '#/components/schemas/Post' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/api/posts/{postId}': {
      get: {
        tags: ['Posts'],
        summary: 'Get post with comments',
        description:
          'Returns a post with its comments and tags. Increments the view counter.',
        operationId: 'getPost',
        parameters: [
          {
            name: 'postId',
            in: 'path',
            required: true,
            description: 'Post ID',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Post detail with comments and tags',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    post: {
                      allOf: [
                        { $ref: '#/components/schemas/Post' },
                        {
                          type: 'object',
                          properties: {
                            topicTitle: {
                              type: 'string',
                              description: 'Title of the parent topic',
                            },
                          },
                        },
                      ],
                    },
                    comments: {
                      type: 'array',
                      description: 'Comments on the post',
                      items: { $ref: '#/components/schemas/Comment' },
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
      delete: {
        tags: ['Posts'],
        summary: 'Delete post',
        description:
          'Deletes a post and all its comments. Only the author, topic owner, or topic admin can delete.',
        operationId: 'deletePost',
        parameters: [
          {
            name: 'postId',
            in: 'path',
            required: true,
            description: 'Post ID',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Post deleted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true, description: 'Deletion success indicator' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    // ─── Comments ─────────────────────────────────────────────────────────
    '/api/posts/{postId}/comments': {
      post: {
        tags: ['Comments'],
        summary: 'Create comment on post',
        description:
          "Creates a comment on a post. Increments the post's comment count.",
        operationId: 'createComment',
        parameters: [
          {
            name: 'postId',
            in: 'path',
            required: true,
            description: 'Post ID',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['content'],
                properties: {
                  content: { type: 'string', description: 'Comment body (plain text)' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Comment created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    comment: { $ref: '#/components/schemas/Comment' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    // ─── Votes ────────────────────────────────────────────────────────────
    '/api/posts/{postId}/vote': {
      post: {
        tags: ['Votes'],
        summary: 'Toggle vote on post',
        description:
          'Toggles a vote on a post. Sending the same value again removes the vote. Sending the opposite value switches the vote. Returns the updated upvote count.',
        operationId: 'toggleVote',
        parameters: [
          {
            name: 'postId',
            in: 'path',
            required: true,
            description: 'Post ID',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['value'],
                properties: {
                  value: {
                    type: 'integer',
                    enum: [1, -1],
                    description: 'Vote value (1 for upvote, -1 for downvote)',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Vote toggled',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    vote: {
                      type: 'object',
                      nullable: true,
                      description: 'Current vote state (null if vote was removed)',
                      properties: {
                        value: { type: 'integer', description: 'Vote value (1 or -1)' },
                      },
                    },
                    upvoteCount: {
                      type: 'integer',
                      description: 'Updated net upvote count for the post',
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    // ─── Reactions ────────────────────────────────────────────────────────
    '/api/posts/{postId}/reactions': {
      get: {
        tags: ['Reactions'],
        summary: 'Get reactions on post',
        description:
          'Returns all emoji reactions on a post, grouped by emoji with counts and whether the current user has reacted.',
        operationId: 'getReactions',
        parameters: [
          {
            name: 'postId',
            in: 'path',
            required: true,
            description: 'Post ID',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Reaction summaries grouped by emoji',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    reactions: {
                      type: 'array',
                      description: 'Reactions grouped by emoji',
                      items: { $ref: '#/components/schemas/ReactionSummary' },
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
      post: {
        tags: ['Reactions'],
        summary: 'Toggle emoji reaction on post',
        description:
          'Toggles an emoji reaction on a post. Reacting with the same emoji again removes it. Only 6 emojis are allowed.',
        operationId: 'toggleReaction',
        parameters: [
          {
            name: 'postId',
            in: 'path',
            required: true,
            description: 'Post ID',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['emoji'],
                properties: {
                  emoji: {
                    type: 'string',
                    description: 'Emoji character (allowed: thumbs up, heart, fire, laughing, party, surprised)',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Reaction toggled',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    added: {
                      type: 'boolean',
                      description: 'True if reaction was added, false if removed',
                    },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid emoji',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error400' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    // ─── Bookmarks ────────────────────────────────────────────────────────
    '/api/posts/{postId}/bookmark': {
      get: {
        tags: ['Bookmarks'],
        summary: 'Check bookmark status',
        description: 'Checks if the current user has bookmarked a specific post.',
        operationId: 'getBookmarkStatus',
        parameters: [
          {
            name: 'postId',
            in: 'path',
            required: true,
            description: 'Post ID',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Bookmark status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    bookmarked: {
                      type: 'boolean',
                      description: 'Whether the post is bookmarked by the current user',
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
      post: {
        tags: ['Bookmarks'],
        summary: 'Toggle bookmark on post',
        description: 'Toggles a bookmark on a post.',
        operationId: 'toggleBookmark',
        parameters: [
          {
            name: 'postId',
            in: 'path',
            required: true,
            description: 'Post ID',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Bookmark toggled',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    bookmarked: {
                      type: 'boolean',
                      description: 'New bookmark state (true if added, false if removed)',
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/api/bookmarks': {
      get: {
        tags: ['Bookmarks'],
        summary: 'List bookmarked posts',
        description:
          'Lists all posts bookmarked by the current user, sorted by bookmark time (newest first).',
        operationId: 'listBookmarks',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Number of posts to return (max 100)',
            schema: { type: 'integer', default: 20, maximum: 100 },
          },
          {
            name: 'offset',
            in: 'query',
            required: false,
            description: 'Number of posts to skip',
            schema: { type: 'integer', default: 0 },
          },
        ],
        responses: {
          '200': {
            description: 'Bookmarked posts',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    posts: {
                      type: 'array',
                      description: 'Bookmarked posts with bookmarkedAt timestamp',
                      items: {
                        allOf: [
                          { $ref: '#/components/schemas/Post' },
                          {
                            type: 'object',
                            properties: {
                              bookmarkedAt: {
                                type: 'string',
                                format: 'date-time',
                                description: 'When the post was bookmarked',
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    // ─── Pins ─────────────────────────────────────────────────────────────
    '/api/posts/{postId}/pin': {
      post: {
        tags: ['Pins'],
        summary: 'Toggle pin on post',
        description:
          'Toggles pin status on a post. Pinned posts appear at the top of post listings regardless of sort order. Only topic owners and admins can pin/unpin.',
        operationId: 'togglePin',
        parameters: [
          {
            name: 'postId',
            in: 'path',
            required: true,
            description: 'Post ID',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Pin status toggled',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    isPinned: {
                      type: 'boolean',
                      description: 'New pin state',
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    // ─── MyActivity ───────────────────────────────────────────────────────
    '/api/my/posts': {
      get: {
        tags: ['MyActivity'],
        summary: 'List my posts',
        description:
          "Lists the current user's own posts across all topics, sorted by newest first.",
        operationId: 'listMyPosts',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Number of posts to return (max 100)',
            schema: { type: 'integer', default: 20, maximum: 100 },
          },
          {
            name: 'offset',
            in: 'query',
            required: false,
            description: 'Number of posts to skip',
            schema: { type: 'integer', default: 0 },
          },
        ],
        responses: {
          '200': {
            description: "Current user's posts",
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    posts: {
                      type: 'array',
                      description: "User's posts sorted by newest first",
                      items: { $ref: '#/components/schemas/Post' },
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/api/my/likes': {
      get: {
        tags: ['MyActivity'],
        summary: 'List my liked posts',
        description:
          'Lists posts the current user has upvoted (value=1), sorted by newest first.',
        operationId: 'listMyLikes',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Number of posts to return (max 100)',
            schema: { type: 'integer', default: 20, maximum: 100 },
          },
          {
            name: 'offset',
            in: 'query',
            required: false,
            description: 'Number of posts to skip',
            schema: { type: 'integer', default: 0 },
          },
        ],
        responses: {
          '200': {
            description: 'Posts upvoted by current user',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    posts: {
                      type: 'array',
                      description: 'Upvoted posts sorted by newest first',
                      items: { $ref: '#/components/schemas/Post' },
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
  },
};

export async function GET() {
  return NextResponse.json(spec);
}
