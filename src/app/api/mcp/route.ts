import { NextRequest } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '@/lib/mcp/server';
import { registerAuthTool, clearSessionToken } from '@/lib/mcp/auth';
import { registerOpenApiTools } from '@/lib/mcp/openapi-tools';
import { logger } from '@/lib/logger';
import openApiSpec from '@/generated/openapi-spec.json';

const ROUTE = '/api/mcp';

// Active transports keyed by MCP session ID
const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

function getBaseUrl(request: NextRequest): string {
  const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? request.nextUrl.host;
  return `${proto}://${host}`;
}

async function handleMcpRequest(request: NextRequest): Promise<Response> {
  const sessionId = request.headers.get('mcp-session-id');
  logger.info(ROUTE, `${request.method} request`, { sessionId: sessionId ?? 'new' });

  // Reuse existing transport for known session
  if (sessionId && transports.has(sessionId)) {
    return transports.get(sessionId)!.handleRequest(request);
  }

  // New session: create transport + server, register tools, connect
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
      logger.info(ROUTE, 'MCP session initialized', { sessionId: sid });
    },
    onsessionclosed: (sid) => {
      transports.delete(sid);
      clearSessionToken(sid);
      logger.info(ROUTE, 'MCP session closed', { sessionId: sid });
    },
    enableJsonResponse: false,
  });

  const server = createMcpServer();
  const baseUrl = getBaseUrl(request);

  // Lazy getter: transport.sessionId is set after connect() + first initialize request
  const getSessionId = () => transport.sessionId ?? 'unknown';

  registerAuthTool(server, getSessionId, baseUrl);
  registerOpenApiTools(
    server,
    openApiSpec as Parameters<typeof registerOpenApiTools>[1],
    getSessionId,
    baseUrl,
  );

  await server.connect(transport);

  return transport.handleRequest(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  return handleMcpRequest(request);
}

export async function GET(request: NextRequest): Promise<Response> {
  return handleMcpRequest(request);
}

export async function DELETE(request: NextRequest): Promise<Response> {
  return handleMcpRequest(request);
}
