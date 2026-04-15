import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '@/lib/logger';
import { getSessionToken } from './auth';

const LOG = 'mcp/openapi-tools';

// Paths excluded from MCP tool registration — handled separately or not useful for agents
const EXCLUDED_PATHS = new Set([
  '/api/health',
  '/api/auth/challenge',
  '/api/auth/verify/ai',
  '/api/auth/proof-request',
  '/api/auth/poll/{requestId}',
  '/api/auth/token-login',
  '/api/auth/session',
  '/api/auth/logout',
  '/api/og',
  '/api/ask/stream', // SSE stream, not suitable for MCP
  '/api/topics/{topicId}/chat/subscribe', // SSE stream
  '/api/topics/{topicId}/chat/presence',  // SSE only
  '/api/beta-signup', // Not relevant to agents
  '/api/upload', // Handled by upload_image tool (multipart/form-data via server-side upload)
]);

/**
 * Converts an OpenAPI path + method to an MCP tool name.
 * Examples:
 *   GET  /api/topics            → get_topics
 *   POST /api/topics            → post_topics
 *   GET  /api/topics/{topicId}  → get_topics_topicId
 *   POST /api/topics/{topicId}/posts → post_topics_topicId_posts
 */
function toToolName(method: string, path: string): string {
  const segments = path
    .replace(/^\/api\//, '')
    .replace(/\{([^}]+)\}/g, '$1')
    .split('/')
    .filter(Boolean)
    .map((s) => s.replace(/[^a-zA-Z0-9]/g, '_'));
  return `${method.toLowerCase()}_${segments.join('_')}`;
}

/**
 * Extracts path parameter names from an OpenAPI path template.
 * e.g. /api/topics/{topicId}/posts → ['topicId']
 */
function extractPathParams(path: string): string[] {
  const matches = path.match(/\{([^}]+)\}/g) ?? [];
  return matches.map((m) => m.slice(1, -1));
}

/**
 * Builds a zod schema object for path parameters.
 */
function buildPathParamSchema(pathParams: string[]): Record<string, z.ZodTypeAny> {
  const schema: Record<string, z.ZodTypeAny> = {};
  for (const param of pathParams) {
    schema[param] = z.string().describe(`Path parameter: ${param}`);
  }
  return schema;
}

/**
 * Infers a simple zod type from an OpenAPI schema object.
 */
function inferZodType(schema: Record<string, unknown>): z.ZodTypeAny {
  const type = schema.type as string | undefined;
  const description = schema.description as string | undefined;

  let zodType: z.ZodTypeAny;

  if (type === 'integer' || type === 'number') {
    zodType = z.number();
  } else if (type === 'boolean') {
    zodType = z.boolean();
  } else if (type === 'array') {
    zodType = z.array(z.unknown());
  } else if (type === 'object') {
    zodType = z.record(z.unknown());
  } else {
    zodType = z.string();
  }

  if (description) {
    zodType = zodType.describe(description);
  }

  return zodType;
}

interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: Record<string, unknown>;
  }>;
  requestBody?: {
    required?: boolean;
    content?: {
      'application/json'?: {
        schema?: {
          properties?: Record<string, Record<string, unknown>>;
          required?: string[];
        };
      };
    };
  };
  security?: unknown[];
}

interface OpenAPISpec {
  paths: Record<string, Record<string, OpenAPIOperation>>;
}

/**
 * Registers MCP tools from the OpenAPI spec.
 * Each path+method becomes one tool. Path params, query params, and body fields
 * are flattened into a single zod schema.
 */
export function registerOpenApiTools(
  server: McpServer,
  spec: OpenAPISpec,
  getSessionId: () => string,
  baseUrl: string,
): void {
  const paths = spec.paths;

  for (const [path, methods] of Object.entries(paths)) {
    if (EXCLUDED_PATHS.has(path)) continue;

    for (const [rawMethod, operation] of Object.entries(methods)) {
      const method = rawMethod.toUpperCase();
      if (!['GET', 'POST', 'PATCH', 'DELETE', 'PUT'].includes(method)) continue;

      const toolName = toToolName(method, path);
      const pathParams = extractPathParams(path);

      // Build parameter schema
      const paramSchema: Record<string, z.ZodTypeAny> = {};

      // Path parameters (always required)
      for (const [k, v] of Object.entries(buildPathParamSchema(pathParams))) {
        paramSchema[k] = v;
      }

      // Query parameters
      const queryParams: string[] = [];
      for (const param of operation.parameters ?? []) {
        if (param.in !== 'query') continue;
        queryParams.push(param.name);
        let zodType = inferZodType(param.schema ?? {});
        if (param.description) zodType = zodType.describe(param.description);
        paramSchema[param.name] = param.required ? zodType : zodType.optional();
      }

      // Request body fields (flatten top-level properties)
      const bodyFields: string[] = [];
      const bodyRequired = new Set<string>(
        operation.requestBody?.content?.['application/json']?.schema?.required ?? [],
      );
      const bodyProperties =
        operation.requestBody?.content?.['application/json']?.schema?.properties ?? {};

      for (const [fieldName, fieldSchema] of Object.entries(bodyProperties)) {
        bodyFields.push(fieldName);
        let zodType = inferZodType(fieldSchema);
        paramSchema[fieldName] = bodyRequired.has(fieldName) ? zodType : zodType.optional();
      }

      // Build human-readable description
      const requiresAuth = !operation.security || operation.security.length > 0;
      const authNote = requiresAuth
        ? ' Requires authentication (call authenticate first).'
        : '';
      const desc = [
        operation.summary ?? toolName,
        operation.description ?? '',
        authNote,
      ]
        .filter(Boolean)
        .join('\n\n');

      server.tool(toolName, desc, paramSchema, async (params) => {
        const text = (data: unknown) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        });
        const errResult = (message: string) => ({
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true as const,
        });

        try {
          const sessionId = getSessionId();
          // Substitute path parameters
          let resolvedPath = path;
          for (const p of pathParams) {
            const value = (params as Record<string, unknown>)[p];
            if (!value) return errResult(`Missing path parameter: ${p}`);
            resolvedPath = resolvedPath.replace(`{${p}}`, encodeURIComponent(String(value)));
          }

          // Build query string
          const qs = new URLSearchParams();
          for (const qp of queryParams) {
            const value = (params as Record<string, unknown>)[qp];
            if (value !== undefined && value !== null) {
              qs.set(qp, String(value));
            }
          }
          const qsStr = qs.toString();
          const url = `${baseUrl}${resolvedPath}${qsStr ? `?${qsStr}` : ''}`;

          // Build headers
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          const token = getSessionToken(sessionId);
          if (token) {
            headers['Authorization'] = `Bearer ${token}`;
          }

          // Build body
          let body: string | undefined;
          if (['POST', 'PATCH', 'PUT'].includes(method) && bodyFields.length > 0) {
            const bodyObj: Record<string, unknown> = {};
            for (const f of bodyFields) {
              const value = (params as Record<string, unknown>)[f];
              if (value !== undefined) bodyObj[f] = value;
            }
            if (Object.keys(bodyObj).length > 0) {
              body = JSON.stringify(bodyObj);
            }
          }

          logger.info(LOG, `${method} ${resolvedPath}`, { sessionId, toolName });

          const res = await fetch(url, {
            method,
            headers,
            ...(body ? { body } : {}),
          });

          const contentType = res.headers.get('content-type') ?? '';
          const responseBody = contentType.includes('application/json')
            ? await res.json()
            : await res.text();

          if (!res.ok) {
            const errMsg =
              typeof responseBody === 'object' && responseBody !== null
                ? (responseBody as { error?: string }).error ?? JSON.stringify(responseBody)
                : String(responseBody);
            logger.warn(LOG, `${method} ${resolvedPath} failed`, { sessionId, status: res.status, error: errMsg });
            return errResult(`HTTP ${res.status}: ${errMsg}`);
          }

          return text(responseBody);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(LOG, `${toolName} error`, { sessionId: getSessionId(), error: message });
          return errResult(message);
        }
      });

      logger.info(LOG, `Registered tool: ${toolName}`, { path, method });
    }
  }
}
