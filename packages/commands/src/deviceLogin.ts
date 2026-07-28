/**
 * Google device-flow login orchestration, ported faithfully from the hosted
 * `src/lib/mcp/auth.ts` that #17 removed when it unified MCP+CLI onto the local
 * `@masselabs/openstoa` stack. It spawns `@zkproofport-ai/mcp`'s `prove.js`
 * (`--login-google`), reads the Google device `verificationUrl` + `userCode`
 * off stderr, then (after the user approves at google.com/device) parses the
 * proof JSON off stdout. The commands core then exchanges that proof for an
 * OpenStoa session via `/api/auth/verify/ai`.
 *
 * This is a Node concern (subprocess spawn) and deliberately lives in the
 * commands core, NOT the portable SDK. `prove.js` calls `process.exit` on
 * import, so we NEVER static-import it — we only resolve its path and spawn it
 * as a child process (matching the original's runtime-resolve approach).
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * A Node `require` for module resolution, created lazily so this works in both
 * the ESM and CJS builds. In ESM `import.meta.url` is a file URL; in the bundled
 * CJS build esbuild leaves `import.meta.url` empty, so we fall back to the entry
 * script (or cwd) — enough to walk node_modules for the prove.js path.
 */
function moduleRequire(): NodeRequire {
  const metaUrl = import.meta.url;
  const base = metaUrl && metaUrl.length > 0 ? metaUrl : pathToFileURL(process.argv[1] ?? process.cwd()).href;
  return createRequire(base);
}

/**
 * Max time to wait for `prove.js` to emit the Google device URL/code on stderr.
 * Google's device-code endpoint is usually sub-second, but we allow generous
 * slack for cold starts and transient upstream latency. (Original: 30s.)
 */
export const DEVICE_INFO_TIMEOUT_MS = 30_000;
/**
 * Number of spawn attempts before giving up. Covers transient prove.js crashes,
 * upstream OAuth flaps, or stderr timing issues. (Original: 2.)
 */
export const MAX_SPAWN_ATTEMPTS = 2;

/** The Google device-flow prompt the user must complete in a browser. */
export interface DeviceCodeInfo {
  verificationUrl: string;
  userCode: string;
}

/**
 * The structural subset of a Node `ChildProcess` the device flow depends on.
 * Kept minimal so tests can inject a fake child without a real subprocess.
 */
export interface ChildProcessLike {
  stdout: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
  stderr: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  kill(): unknown;
  exitCode: number | null;
}

/** Spawn `prove.js --login-google --scope <scope> --silent`. Injectable for tests. */
export type ProveSpawner = (scope: string) => ChildProcessLike;

/**
 * An in-flight device login: the spawned prove process plus its buffered output
 * and the (already surfaced) device code. Held between the two MCP calls, or
 * inline for the CLI's blocking variant.
 */
export interface PendingDeviceLogin {
  challengeId: string;
  scope: string;
  child: ChildProcessLike;
  stdoutBuffer: string;
  stderrBuffer: string;
  verificationUrl: string;
  userCode: string;
  exitPromise: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/**
 * Resolve `@zkproofport-ai/mcp`'s `prove.js`. Uses Node module resolution from
 * this package (finds the dep wherever npm hoisted it) — it computes the path
 * only, it does NOT load the module (prove.js exits on import). Throws an
 * actionable error when the dependency is missing.
 */
export function resolveProvePath(): string {
  try {
    return moduleRequire().resolve('@zkproofport-ai/mcp/dist/prove.js');
  } catch {
    throw new Error(
      'Google device-flow login needs @zkproofport-ai/mcp (its prove.js runs the device flow), ' +
        'but it could not be resolved. Install it: `npm install -g @zkproofport-ai/mcp` ' +
        '(or add it as a dependency of the process running the OpenStoa CLI/MCP).',
    );
  }
}

/** Default spawner: resolves prove.js and launches it with the current Node. */
export const defaultSpawnProve: ProveSpawner = (scope: string): ChildProcessLike => {
  const provePath = resolveProvePath();
  const child = nodeSpawn(
    process.execPath,
    [provePath, '--login-google', '--scope', scope, '--silent'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ZKPROOFPORT_SILENT: '1' },
    },
  );
  return child as unknown as ChildProcessLike;
};

/** Parse the `Open: <url>` / `Code: <code>` lines prove.js prints on stderr. */
export function parseDeviceInfo(stderr: string): { url?: string; code?: string } {
  const urlMatch = stderr.match(/Open:\s*(\S+)/);
  const codeMatch = stderr.match(/Code:\s*(\S+)/);
  return { url: urlMatch?.[1], code: codeMatch?.[1] };
}

async function waitForDeviceInfo(pending: PendingDeviceLogin, timeoutMs: number): Promise<void> {
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
        `zkproofport-prove exited before producing a device code: ${pending.stderrBuffer || pending.stdoutBuffer}`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Timed out waiting for a device code from zkproofport-prove after ${timeoutMs}ms: ${pending.stderrBuffer || '(no stderr)'}`,
  );
}

/**
 * Spawn prove.js and block until the Google device code is on stderr. Retries a
 * bounded number of times (killing a stuck child between attempts). A synchronous
 * spawn/resolution failure (e.g. prove.js not installed) surfaces immediately —
 * it is not a transient condition to retry.
 */
export async function startDeviceLogin(
  spawner: ProveSpawner,
  scope: string,
  challengeId: string,
  timeoutMs: number = DEVICE_INFO_TIMEOUT_MS,
): Promise<PendingDeviceLogin> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_SPAWN_ATTEMPTS; attempt++) {
    // A spawn/resolution error (missing prove.js) is not transient — surface it
    // as-is rather than burying it under "failed after N attempts".
    const child = spawner(scope);
    const pending: PendingDeviceLogin = {
      challengeId,
      scope,
      child,
      stdoutBuffer: '',
      stderrBuffer: '',
      verificationUrl: '',
      userCode: '',
      exitPromise: undefined as unknown as PendingDeviceLogin['exitPromise'],
    };
    pending.exitPromise = new Promise((resolve) => {
      child.stdout?.on('data', (chunk) => {
        pending.stdoutBuffer += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        pending.stderrBuffer += String(chunk);
      });
      child.on('exit', (code) => {
        resolve({ code, stdout: pending.stdoutBuffer, stderr: pending.stderrBuffer });
      });
    });
    try {
      await waitForDeviceInfo(pending, timeoutMs);
      return pending;
    } catch (waitErr) {
      lastError = waitErr as Error;
      child.kill();
    }
  }
  throw new Error(
    `Google device flow failed after ${MAX_SPAWN_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`,
  );
}

/**
 * Await the prove.js exit and return the parsed proof JSON from stdout. Throws
 * with the FULL child output (never truncated) on non-zero exit or unparseable
 * stdout, so the caller can surface the real failure.
 */
export async function awaitProof(pending: PendingDeviceLogin): Promise<unknown> {
  const { code, stdout, stderr } = await pending.exitPromise;
  if (code !== 0) {
    throw new Error(`zkproofport-prove failed (exit ${code}): ${stderr || stdout}`);
  }
  try {
    return JSON.parse(stdout.trim());
  } catch (parseErr) {
    throw new Error(
      `Failed to parse proof JSON from zkproofport-prove: ${(parseErr as Error).message}. stdout=${stdout}`,
    );
  }
}
