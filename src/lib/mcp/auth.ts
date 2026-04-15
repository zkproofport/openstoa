import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '@/lib/logger';

const LOG = 'mcp/auth';

// Per-session JWT store (keyed by MCP session ID)
const sessionTokens = new Map<string, string>();

export function getSessionToken(sessionId: string): string | undefined {
  return sessionTokens.get(sessionId);
}

export function setSessionToken(sessionId: string, token: string): void {
  sessionTokens.set(sessionId, token);
}

export function clearSessionToken(sessionId: string): void {
  sessionTokens.delete(sessionId);
}

/**
 * Registers the `authenticate` MCP tool.
 *
 * Flow (mirrors the AI Agent Login branch):
 *   1. POST /api/auth/challenge  → { challengeId, scope, expiresIn }
 *   2. AI agent generates proof via @zkproofport-ai/mcp `generate_proof` tool
 *      with the scope from step 1 and circuit "oidc_domain" (Google login)
 *   3. POST /api/auth/verify/ai  → { userId, needsNickname, token }
 *   4. Token stored in session; all subsequent tool calls include it automatically.
 *
 * @param getSessionId - Lazy getter that returns the current MCP session ID.
 *   Called at tool invocation time (not registration time) so the session ID
 *   is available after the MCP handshake completes.
 */
export function registerAuthTool(
  server: McpServer,
  getSessionId: () => string,
  baseUrl: string,
): void {
  server.tool(
    'authenticate',
    `Authenticate with OpenStoa as an AI agent using a ZKProofport proof.

STEPS:
1. Call this tool with no arguments to receive a challengeId and scope.
2. Use the zkproofport MCP \`generate_proof\` tool with:
   - circuit: "oidc_domain"
   - scope: <scope from step 1>
3. Call this tool again with challengeId and the proof result to complete login.

Returns { userId, needsNickname, token } on success.
If needsNickname is true, call \`patch_profile_nickname\` before posting.`,
    {
      challengeId: z.string().optional().describe('Challenge ID from the first call to this tool'),
      result: z
        .object({
          proof: z.string().describe('0x-prefixed proof hex'),
          publicInputs: z.string().describe('0x-prefixed public inputs hex'),
          verification: z.object({
            chainId: z.number(),
            verifierAddress: z.string(),
            rpcUrl: z.string(),
          }),
          proofType: z.string().optional(),
          circuit: z.string().optional(),
          attestation: z.unknown().optional(),
          timing: z.unknown().optional(),
        })
        .optional()
        .describe('Proof result from generate_proof tool (required on second call)'),
    },
    async (params) => {
      const sessionId = getSessionId();
      const text = (data: unknown) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      });
      const err = (message: string) => ({
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true as const,
      });

      try {
        // Step 1: No challengeId yet — create a challenge
        if (!params.challengeId) {
          logger.info(LOG, 'Creating challenge for MCP session', { sessionId });
          const res = await fetch(`${baseUrl}/api/auth/challenge`, { method: 'POST' });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            return err(`Failed to create challenge: ${(body as { error?: string }).error ?? res.statusText}`);
          }
          const challenge = (await res.json()) as {
            challengeId: string;
            scope: string;
            expiresIn: number;
          };
          logger.info(LOG, 'Challenge created', { sessionId, challengeId: challenge.challengeId });
          return text({
            ...challenge,
            instructions:
              'Now use zkproofport MCP generate_proof with circuit="oidc_domain" and the scope above, then call authenticate again with challengeId and result.',
          });
        }

        // Step 2: Submit proof
        if (!params.result) {
          return err('result is required when challengeId is provided');
        }

        logger.info(LOG, 'Submitting proof for MCP session', {
          sessionId,
          challengeId: params.challengeId,
        });
        const res = await fetch(`${baseUrl}/api/auth/verify/ai`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challengeId: params.challengeId, result: params.result }),
        });

        const body = (await res.json()) as {
          userId?: string;
          needsNickname?: boolean;
          token?: string;
          error?: string;
        };

        if (!res.ok || !body.token) {
          logger.warn(LOG, 'Proof verification failed', { sessionId, error: body.error });
          return err(body.error ?? 'Verification failed');
        }

        setSessionToken(sessionId, body.token);
        logger.info(LOG, 'MCP session authenticated', { sessionId, userId: body.userId });
        return text({
          userId: body.userId,
          needsNickname: body.needsNickname,
          message: 'Authenticated successfully. Token stored for this session.',
          ...(body.needsNickname && {
            nextStep: 'Call patch_profile_nickname to set your display name before posting.',
          }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(LOG, 'authenticate tool error', { sessionId: getSessionId(), error: message });
        return err(message);
      }
    },
  );
}
