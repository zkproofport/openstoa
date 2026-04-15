import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { logger } from '@/lib/logger';

const LOG = 'mcp/auth';

// Resolve zkproofport-prove path at runtime via process.cwd() instead of
// require.resolve so webpack cannot statically analyze and bundle prove.js into
// the route chunk (prove.js is a CLI that runs process.exit on import).
function resolveProvePath(): string {
  return join(process.cwd(), 'node_modules', '@zkproofport-ai', 'mcp', 'dist', 'prove.js');
}

// Max time to wait for zkproofport-prove to emit the Google device URL/code on stderr.
// Google's device-code endpoint is usually sub-second, but we allow generous slack
// for container cold starts and transient upstream latency.
const DEVICE_INFO_TIMEOUT_MS = 30_000;
// Number of spawn attempts before giving up. Covers transient prove.js crashes,
// upstream OAuth flaps, or stderr timing issues.
const MAX_SPAWN_ATTEMPTS = 2;

const sessionTokens = new Map<string, string>();

interface PendingAuth {
  challengeId: string;
  scope: string;
  child: ChildProcess;
  stdoutBuffer: string;
  stderrBuffer: string;
  verificationUrl?: string;
  userCode?: string;
  exitPromise: Promise<{ code: number | null; stdout: string; stderr: string }>;
}
const pendingAuths = new Map<string, PendingAuth>();

export function getSessionToken(sessionId: string): string | undefined {
  return sessionTokens.get(sessionId);
}

export function setSessionToken(sessionId: string, token: string): void {
  sessionTokens.set(sessionId, token);
}

export function clearSessionToken(sessionId: string): void {
  sessionTokens.delete(sessionId);
  pendingAuths.get(sessionId)?.child.kill();
  pendingAuths.delete(sessionId);
}

function parseDeviceInfo(stderr: string): { url?: string; code?: string } {
  const urlMatch = stderr.match(/Open:\s*(\S+)/);
  const codeMatch = stderr.match(/Code:\s*(\S+)/);
  return { url: urlMatch?.[1], code: codeMatch?.[1] };
}

function spawnProve(scope: string): ChildProcess {
  const provePath = resolveProvePath();
  return spawn(
    process.execPath,
    [provePath, '--login-google', '--scope', scope, '--silent'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ZKPROOFPORT_SILENT: '1' },
    },
  );
}

async function waitForDeviceInfo(
  pending: PendingAuth,
  timeoutMs = DEVICE_INFO_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = parseDeviceInfo(pending.stderrBuffer);
    if (info.url && info.code) {
      pending.verificationUrl = info.url;
      pending.userCode = info.code;
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

export function registerAuthTool(
  server: McpServer,
  getSessionId: () => string,
  baseUrl: string,
): void {
  server.tool(
    'authenticate',
    `Authenticate with OpenStoa as an AI agent — fully automated ZK login via Google device flow.

This tool wraps the entire ZKProofport login internally. You do NOT need to call any @zkproofport-ai/mcp tools yourself.

USAGE:
1. Call this tool with no arguments.
   → Returns { status: "pending_user_login", verificationUrl, userCode, instructions }.
   Ask the human user to open verificationUrl in a browser and enter userCode.
2. After the user confirms login, call this tool again with no arguments.
   → Waits for ZK proof generation (30-90 seconds), exchanges it for an OpenStoa token, stores it for the session, and returns { status: "authenticated", userId, token, needsNickname }.

If needsNickname is true, call patch_profile_nickname before posting.`,
    {},
    async () => {
      const sessionId = getSessionId();
      const text = (data: unknown) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      });
      const err = (message: string) => ({
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true as const,
      });

      try {
        const existing = pendingAuths.get(sessionId);

        // ─── Phase 2: resume pending auth — wait for proof and verify ──
        if (existing) {
          logger.info(LOG, 'Resuming pending auth', {
            sessionId,
            challengeId: existing.challengeId,
          });

          const { code, stdout, stderr } = await existing.exitPromise;
          pendingAuths.delete(sessionId);

          if (code !== 0) {
            return err(`zkproofport-prove failed (exit ${code}): ${stderr || stdout}`);
          }

          let proofResult: unknown;
          try {
            proofResult = JSON.parse(stdout.trim());
          } catch (parseErr) {
            return err(
              `Failed to parse proof JSON from zkproofport-prove: ${(parseErr as Error).message}. stdout=${stdout}`,
            );
          }

          const verifyRes = await fetch(`${baseUrl}/api/auth/verify/ai`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              challengeId: existing.challengeId,
              result: proofResult,
            }),
          });
          const body = (await verifyRes.json()) as {
            userId?: string;
            needsNickname?: boolean;
            token?: string;
            error?: string;
          };
          if (!verifyRes.ok || !body.token) {
            logger.warn(LOG, 'Proof verification failed', {
              sessionId,
              error: body.error,
            });
            return err(body.error ?? 'Verification failed');
          }

          setSessionToken(sessionId, body.token);
          logger.info(LOG, 'MCP session authenticated', { sessionId, userId: body.userId });
          return text({
            status: 'authenticated',
            userId: body.userId,
            needsNickname: body.needsNickname,
            message: 'Authenticated successfully. Token stored for this MCP session automatically.',
            ...(body.needsNickname && {
              nextStep: 'Call patch_profile_nickname to set your display name before posting.',
            }),
          });
        }

        // ─── Phase 1: start new auth flow ────────────────────────────────
        logger.info(LOG, 'Creating challenge', { sessionId });
        const chRes = await fetch(`${baseUrl}/api/auth/challenge`, { method: 'POST' });
        if (!chRes.ok) {
          const b = await chRes.json().catch(() => ({}));
          return err(
            `Failed to create challenge: ${(b as { error?: string }).error ?? chRes.statusText}`,
          );
        }
        const challenge = (await chRes.json()) as {
          challengeId: string;
          scope: string;
        };

        let pending: PendingAuth | undefined;
        let lastError: Error | undefined;
        for (let attempt = 1; attempt <= MAX_SPAWN_ATTEMPTS; attempt++) {
          logger.info(LOG, 'Spawning zkproofport-prove', {
            sessionId,
            scope: challenge.scope,
            attempt,
          });
          const child = spawnProve(challenge.scope);
          const candidate: PendingAuth = {
            challengeId: challenge.challengeId,
            scope: challenge.scope,
            child,
            stdoutBuffer: '',
            stderrBuffer: '',
            exitPromise: new Promise((resolve) => {
              child.stdout?.on('data', (chunk) => {
                candidate.stdoutBuffer += chunk.toString();
              });
              child.stderr?.on('data', (chunk) => {
                candidate.stderrBuffer += chunk.toString();
              });
              child.on('exit', (exitCode) => {
                resolve({
                  code: exitCode,
                  stdout: candidate.stdoutBuffer,
                  stderr: candidate.stderrBuffer,
                });
              });
            }),
          };
          try {
            await waitForDeviceInfo(candidate);
            pending = candidate;
            break;
          } catch (waitErr) {
            lastError = waitErr as Error;
            logger.warn(LOG, 'Device flow attempt failed', {
              sessionId,
              attempt,
              error: lastError.message,
            });
            child.kill();
          }
        }
        if (!pending) {
          return err(
            `Device flow failed after ${MAX_SPAWN_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`,
          );
        }
        pendingAuths.set(sessionId, pending);

        logger.info(LOG, 'Device code ready', {
          sessionId,
          url: pending.verificationUrl,
          code: pending.userCode,
        });
        return text({
          status: 'pending_user_login',
          verificationUrl: pending.verificationUrl,
          userCode: pending.userCode,
          instructions:
            `Tell the human user to open ${pending.verificationUrl} in a browser and enter code ${pending.userCode}. ` +
            `Once they confirm login is complete, call authenticate again with no arguments. Proof generation takes 30-90 seconds.`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(LOG, 'authenticate tool error', {
          sessionId: getSessionId(),
          error: message,
        });
        return err(message);
      }
    },
  );
}
