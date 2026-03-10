import { NextResponse } from 'next/server';

const spec = {
  openapi: '3.0.0',
  info: {
    title: 'ZK Community API',
    version: '0.1.0',
    description: 'API for ZK-gated community with Coinbase KYC verification',
  },
  servers: [
    {
      url: '',
      description: 'Current server',
    },
  ],
  tags: [
    { name: 'Health', description: 'Service health' },
    { name: 'Auth', description: 'Authentication flows (mobile ZK proof & agent challenge)' },
    { name: 'Profile', description: 'User profile management' },
    { name: 'Topics', description: 'Community topics' },
    { name: 'Posts', description: 'Posts within topics' },
    { name: 'Comments', description: 'Comments on posts' },
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
      Error401: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'Not authenticated' },
        },
      },
      Error403: {
        type: 'object',
        properties: {
          error: {
            type: 'string',
            example: 'Nickname required. Set your nickname at /profile first.',
          },
        },
      },
      Topic: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string', nullable: true },
          requiresCountryProof: { type: 'boolean' },
          allowedCountries: {
            type: 'array',
            items: { type: 'string' },
            nullable: true,
          },
          inviteCode: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Post: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          topicId: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          authorId: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Comment: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          postId: { type: 'string' },
          content: { type: 'string' },
          authorId: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    responses: {
      Unauthorized: {
        description: 'Not authenticated',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error401' },
          },
        },
      },
      Forbidden: {
        description: 'Authenticated but not authorized (e.g. no nickname set)',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error403' },
          },
        },
      },
    },
  },
  security: [{ cookieAuth: [] }, { bearerAuth: [] }],
  paths: {
    '/api/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        security: [],
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    timestamp: { type: 'string', format: 'date-time' },
                    uptime: { type: 'number', description: 'Process uptime in seconds' },
                  },
                },
              },
            },
          },
        },
      },
    },

    '/api/auth/proof-request': {
      post: {
        tags: ['Auth'],
        summary: 'Create relay proof request for mobile flow',
        security: [],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  circuitType: { type: 'string', example: 'coinbase_attestation' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Proof request created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    requestId: { type: 'string' },
                    deepLink: { type: 'string', example: 'zkproofport://...' },
                    scope: { type: 'string' },
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
        security: [],
        parameters: [
          {
            name: 'requestId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Poll result',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      properties: {
                        status: {
                          type: 'string',
                          enum: ['pending', 'failed'],
                        },
                      },
                    },
                    {
                      type: 'object',
                      properties: {
                        status: { type: 'string', enum: ['completed'] },
                        userId: { type: 'string' },
                        needsNickname: { type: 'boolean' },
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
        summary: 'Create challenge for agent auth',
        security: [],
        responses: {
          '200': {
            description: 'Challenge created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    challengeId: { type: 'string' },
                    scope: { type: 'string' },
                    expiresIn: { type: 'number', description: 'Seconds until expiry' },
                  },
                },
              },
            },
          },
        },
      },
    },

    '/api/auth/verify': {
      post: {
        tags: ['Auth'],
        summary: 'Verify proof with challenge (agent flow)',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['challengeId', 'proof', 'publicInputs', 'verifierAddress'],
                properties: {
                  challengeId: { type: 'string' },
                  proof: { type: 'string' },
                  publicInputs: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  verifierAddress: { type: 'string' },
                  chainId: { type: 'number' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Verification successful. Also sets session cookie.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    userId: { type: 'string' },
                    needsNickname: { type: 'boolean' },
                    token: { type: 'string', description: 'Bearer token for agent use' },
                  },
                },
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
        responses: {
          '200': {
            description: 'Current session',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    userId: { type: 'string' },
                    nickname: { type: 'string' },
                    verifiedAt: { type: 'string', format: 'date-time' },
                  },
                },
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
        security: [],
        responses: {
          '200': {
            description: 'Logged out successfully',
          },
        },
      },
    },

    '/api/profile/nickname': {
      put: {
        tags: ['Profile'],
        summary: 'Set nickname',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['nickname'],
                properties: {
                  nickname: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Nickname updated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    nickname: { type: 'string' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/api/topics': {
      get: {
        tags: ['Topics'],
        summary: 'List all topics',
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
                      items: { $ref: '#/components/schemas/Topic' },
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
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title'],
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  requiresCountryProof: { type: 'boolean' },
                  allowedCountries: {
                    type: 'array',
                    items: { type: 'string' },
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
        parameters: [
          {
            name: 'topicId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Topic detail',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    topic: { $ref: '#/components/schemas/Topic' },
                    memberCount: { type: 'number' },
                    isMember: { type: 'boolean' },
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

    '/api/topics/join/{inviteCode}': {
      get: {
        tags: ['Topics'],
        summary: 'Lookup topic by invite code',
        parameters: [
          {
            name: 'inviteCode',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Topic found',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    topic: { $ref: '#/components/schemas/Topic' },
                    isMember: { type: 'boolean' },
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

    '/api/topics/{topicId}/join': {
      post: {
        tags: ['Topics'],
        summary: 'Join topic (optional country proof if required)',
        parameters: [
          {
            name: 'topicId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
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
                  proof: { type: 'string' },
                  publicInputs: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  verifierAddress: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Joined successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
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

    '/api/topics/{topicId}/posts': {
      get: {
        tags: ['Posts'],
        summary: 'List posts in topic',
        parameters: [
          {
            name: 'topicId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'cursor',
            in: 'query',
            schema: { type: 'string' },
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', default: 20 },
          },
        ],
        responses: {
          '200': {
            description: 'Posts list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    posts: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Post' },
                    },
                    nextCursor: { type: 'string', nullable: true },
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
        parameters: [
          {
            name: 'topicId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
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
                  title: { type: 'string' },
                  content: { type: 'string' },
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
        parameters: [
          {
            name: 'postId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Post detail with comments',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    post: { $ref: '#/components/schemas/Post' },
                    comments: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Comment' },
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

    '/api/posts/{postId}/comments': {
      post: {
        tags: ['Comments'],
        summary: 'Create comment on post',
        parameters: [
          {
            name: 'postId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
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
                  content: { type: 'string' },
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
  },
};

export async function GET() {
  return NextResponse.json(spec);
}
