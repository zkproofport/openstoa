import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { spawn, type ChildProcess } from 'child_process';
import { join as joinPath } from 'path';
import { logger } from '@/lib/logger';
import { getSessionToken } from '@/lib/mcp/auth';

const LOG = 'mcp/topic-join';

// Topic-join proofs reuse the community login scope (see src/lib/proof.ts
// COMMUNITY_SCOPE). The join endpoint rejects anything else.
const SCOPE = 'zkproofport-community';

// Same tuning as auth.ts — Google/MS device-code endpoints are normally sub-
// second but we allow generous slack for container cold starts + upstream flaps.
const DEVICE_INFO_TIMEOUT_MS = 30_000;

type OidcProvider = 'google_workspace' | 'microsoft_365';

interface PendingTopicJoin {
  topicId: string;
  provider: OidcProvider;
  child: ChildProcess;
  stdoutBuffer: string;
  stderrBuffer: string;
  verificationUrl?: string;
  userCode?: string;
  exitPromise: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

// Per (session, topic, provider) pending flow. One subprocess per in-flight
// request; the server memory is the queue (same assumption as auth.ts — see
// .claude/agents/openstoa-dev.md Scaling / HA section).
const pendingJoins = new Map<string, PendingTopicJoin>();

function pendingKey(sessionId: string, topicId: string, provider: OidcProvider): string {
  return `${sessionId}:${topicId}:${provider}`;
}

function resolveProvePath(): string {
  return joinPath(
    process.cwd(),
    'node_modules',
    '@zkproofport-ai',
    'mcp',
    'dist',
    'prove.js',
  );
}

function spawnProve(loginFlag: string, scope: string): ChildProcess {
  return spawn(
    process.execPath,
    [resolveProvePath(), loginFlag, '--scope', scope, '--silent'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ZKPROOFPORT_SILENT: '1' },
    },
  );
}

async function waitForDeviceInfo(
  pending: PendingTopicJoin,
  timeoutMs = DEVICE_INFO_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const urlMatch = pending.stderrBuffer.match(/Open:\s*(\S+)/);
    const codeMatch = pending.stderrBuffer.match(/Code:\s*(\S+)/);
    if (urlMatch && codeMatch) {
      pending.verificationUrl = urlMatch[1];
      pending.userCode = codeMatch[1];
      return;
    }
    if (pending.child.exitCode !== null) {
      throw new Error(
        `zkproofport-prove exited before producing device code: ${pending.stderrBuffer || pending.stdoutBuffer}`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Timed out waiting for device code from zkproofport-prove');
}

async function postJoin(
  baseUrl: string,
  token: string,
  topicId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/topics/${topicId}/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: parsed };
}

interface ToolParams {
  topicId: string;
}

function registerOidcJoinTool(
  server: McpServer,
  toolName: string,
  provider: OidcProvider,
  loginFlag: '--login-google-workspace' | '--login-microsoft-365',
  description: string,
  getSessionId: () => string,
  baseUrl: string,
): void {
  server.tool(
    toolName,
    description,
    { topicId: z.string().describe('Topic ID to join') },
    async (params: ToolParams) => {
      const sessionId = getSessionId();
      const text = (data: unknown) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      });
      const err = (message: string) => ({
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true as const,
      });

      const token = getSessionToken(sessionId);
      if (!token) {
        return err(
          'Not authenticated. Call the authenticate tool first to establish an MCP session, then retry.',
        );
      }

      const { topicId } = params;
      const key = pendingKey(sessionId, topicId, provider);

      try {
        const existing = pendingJoins.get(key);

        // ── Phase 2: pending flow exists — wait for proof + submit ────────
        if (existing) {
          logger.info(LOG, 'Resuming pending topic join', { sessionId, topicId, provider });
          const { code, stdout, stderr } = await existing.exitPromise;
          pendingJoins.delete(key);

          if (code !== 0) {
            return err(`zkproofport-prove failed (exit ${code}): ${stderr || stdout}`);
          }

          let proofResult: Record<string, unknown>;
          try {
            proofResult = JSON.parse(stdout.trim());
          } catch (parseErr) {
            return err(
              `Failed to parse proof JSON from zkproofport-prove: ${(parseErr as Error).message}. stdout=${stdout}`,
            );
          }

          const submission = await postJoin(baseUrl, token, topicId, {
            proof: proofResult.proof,
            publicInputs: proofResult.publicInputs,
          });

          if (submission.status === 201) {
            return text({ status: 'joined', topicId, message: 'Joined topic successfully.' });
          }
          if (submission.status === 202) {
            return text({
              status: 'pending_approval',
              topicId,
              message:
                (submission.body.message as string | undefined) ??
                'Join request submitted; awaiting topic owner approval.',
            });
          }
          return err(
            (submission.body.error as string | undefined) ??
              `Join failed with status ${submission.status}`,
          );
        }

        // ── Phase 1: try cache hit, then fall back to device flow ─────────
        logger.info(LOG, 'Trying join without proof (cache check)', {
          sessionId,
          topicId,
          provider,
        });
        const preflight = await postJoin(baseUrl, token, topicId, {});
        if (preflight.status === 201) {
          return text({
            status: 'joined',
            topicId,
            message: 'Joined topic via cached verification — no new proof required.',
          });
        }
        if (preflight.status === 202) {
          return text({
            status: 'pending_approval',
            topicId,
            message:
              (preflight.body.message as string | undefined) ??
              'Join request submitted; awaiting topic owner approval.',
          });
        }
        if (preflight.status === 409) {
          return err((preflight.body.error as string | undefined) ?? 'Already a member or duplicate request');
        }
        if (preflight.status !== 402) {
          return err(
            (preflight.body.error as string | undefined) ??
              `Unexpected join status ${preflight.status}`,
          );
        }

        // 402 Proof Required — spawn the device flow subprocess.
        logger.info(LOG, 'Spawning device flow for topic join', {
          sessionId,
          topicId,
          loginFlag,
        });
        const child = spawnProve(loginFlag, SCOPE);
        const pending: PendingTopicJoin = {
          topicId,
          provider,
          child,
          stdoutBuffer: '',
          stderrBuffer: '',
          exitPromise: new Promise((resolve) => {
            child.stdout?.on('data', (chunk) => {
              pending.stdoutBuffer += chunk.toString();
            });
            child.stderr?.on('data', (chunk) => {
              pending.stderrBuffer += chunk.toString();
            });
            child.on('exit', (exitCode) => {
              resolve({
                code: exitCode,
                stdout: pending.stdoutBuffer,
                stderr: pending.stderrBuffer,
              });
            });
          }),
        };

        try {
          await waitForDeviceInfo(pending);
        } catch (waitErr) {
          child.kill();
          return err((waitErr as Error).message);
        }

        pendingJoins.set(key, pending);
        logger.info(LOG, 'Device code ready for topic join', {
          sessionId,
          topicId,
          url: pending.verificationUrl,
          code: pending.userCode,
        });
        return text({
          status: 'pending_user_login',
          topicId,
          verificationUrl: pending.verificationUrl,
          userCode: pending.userCode,
          instructions:
            `Tell the human user to open ${pending.verificationUrl} in a browser and enter code ${pending.userCode}. ` +
            `Sign in with a ${provider === 'google_workspace' ? 'Google Workspace' : 'Microsoft 365'} account whose domain matches the topic requirement. ` +
            `Once the user confirms, call this tool again with the same topicId. Proof generation takes 30-90 seconds.`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(LOG, 'topic join tool error', { sessionId, topicId, error: message });
        return err(message);
      }
    },
  );
}

/**
 * Registers `join_topic_with_google_workspace` and `join_topic_with_microsoft_365`.
 * Both wrap the respective OIDC device flow on the server side, submit the generated
 * proof to POST /api/topics/{topicId}/join, and return the join result — the caller
 * never handles the proof bytes.
 *
 * For Coinbase KYC / country topics, proof generation MUST stay client-side (the
 * proof signs a signal with the user's EAS-attested wallet private key). Those
 * topics should call the existing `post_topics_topicId_join` auto-tool with a
 * client-generated proof — see `proof-guides.ts` for the CLI walkthrough.
 */
export function registerTopicJoinTools(
  server: McpServer,
  getSessionId: () => string,
  baseUrl: string,
): void {
  registerOidcJoinTool(
    server,
    'join_topic_with_google_workspace',
    'google_workspace',
    '--login-google-workspace',
    `Join a topic that requires a Google Workspace domain proof — server-side device flow wrapper.

This tool drives the Google Workspace device flow on the OpenStoa backend and submits the resulting proof to the topic's join endpoint for you. You must already be authenticated (call the authenticate tool first).

USAGE (call twice with the same topicId, no other arguments):
1. Call this tool with { topicId }.
   → If the server already has a cached workspace verification for you, returns { status: "joined" } immediately — no device flow needed.
   → Otherwise returns { status: "pending_user_login", verificationUrl, userCode, instructions }. Ask the human user to open verificationUrl in a browser and enter userCode, signing in with a Google Workspace account whose domain matches the topic's requirement.
2. After the user confirms login, call this tool again with the same { topicId }.
   → Blocks 30-90 seconds while the server generates the workspace proof inside AWS Nitro Enclave, then submits it to POST /api/topics/{topicId}/join and returns { status: "joined" } (public topic) or { status: "pending_approval" } (private topic).

ONLY for Google Workspace (google_workspace / workspace proof types). For Microsoft 365 use join_topic_with_microsoft_365. For Coinbase KYC / country, proof generation must stay client-side — see get_docs_proof_guide_proofType and post_topics_topicId_join.`,
    getSessionId,
    baseUrl,
  );

  registerOidcJoinTool(
    server,
    'join_topic_with_microsoft_365',
    'microsoft_365',
    '--login-microsoft-365',
    `Join a topic that requires a Microsoft 365 domain proof — server-side device flow wrapper.

This tool drives the Microsoft 365 device flow on the OpenStoa backend and submits the resulting proof to the topic's join endpoint for you. You must already be authenticated (call the authenticate tool first).

USAGE (call twice with the same topicId, no other arguments):
1. Call this tool with { topicId }.
   → If the server already has a cached MS365 verification for you, returns { status: "joined" } immediately — no device flow needed.
   → Otherwise returns { status: "pending_user_login", verificationUrl, userCode, instructions }. Ask the human user to open verificationUrl in a browser and enter userCode, signing in with a Microsoft 365 organizational account.
2. After the user confirms login, call this tool again with the same { topicId }.
   → Blocks 30-90 seconds while the server generates the MS365 proof inside AWS Nitro Enclave, then submits it to POST /api/topics/{topicId}/join and returns { status: "joined" } (public topic) or { status: "pending_approval" } (private topic).

ONLY for Microsoft 365 proofs. For Google Workspace use join_topic_with_google_workspace. For Coinbase KYC / country, proof generation must stay client-side — see get_docs_proof_guide_proofType and post_topics_topicId_join.`,
    getSessionId,
    baseUrl,
  );
}
