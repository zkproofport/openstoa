import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'OpenStoa API',
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
            categoryId: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              description: 'Category ID (null if uncategorized)',
            },
            category: {
              type: 'object',
              nullable: true,
              description: 'Category details',
              properties: {
                id: { type: 'string', format: 'uuid', description: 'Category ID' },
                name: { type: 'string', description: 'Category display name' },
                slug: { type: 'string', description: 'URL-safe category slug' },
                icon: { type: 'string', nullable: true, description: 'Category icon emoji' },
              },
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
  },
  apis: ['./src/app/api/**/route.ts'],
};

export const spec = swaggerJsdoc(options);
