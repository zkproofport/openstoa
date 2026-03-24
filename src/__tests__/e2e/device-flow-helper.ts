/**
 * Run zkproofport-prove with automatic device code entry via Playwright stealth.
 *
 * Spawns the prove CLI, watches stderr for device codes, launches Playwright
 * to enter them automatically. Falls back to manual entry if Playwright fails.
 */

import { spawn } from 'child_process';
import { enterDeviceCode } from './playwright-device-flow';

const DEVICE_CODE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/**
 * Detect provider from stderr output containing a device URL.
 */
function detectProvider(line: string): 'google' | 'microsoft' | null {
  if (line.includes('google.com/device')) return 'google';
  if (line.includes('login.microsoft')) return 'microsoft';
  return null;
}

/**
 * Run zkproofport-prove with automatic device code entry.
 *
 * @param args - CLI arguments (e.g. '--login-google', '--login-microsoft-365')
 * @param scope - The scope/challenge string
 * @param env - Environment variables (must include PAYMENT_KEY, ATTESTATION_KEY)
 * @returns Parsed proof result JSON from stdout
 */
export async function runProveWithAutoDeviceFlow(
  args: string,
  scope: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const cmd = `npx zkproofport-prove ${args} --scope ${scope} --silent`;
  console.log(`[E2E] OIDC (auto): ${cmd}`);

  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['zkproofport-prove', ...args.split(/\s+/), '--scope', scope, '--silent'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let detectedProvider: 'google' | 'microsoft' | null = null;
    let deviceCodeHandled = false;

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`[E2E] OIDC proof timed out after ${DEVICE_CODE_TIMEOUT / 1000}s`));
    }, DEVICE_CODE_TIMEOUT);

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;

      // Log stderr lines for visibility
      for (const line of chunk.split('\n').filter(Boolean)) {
        console.log(`[E2E] stderr: ${line}`);

        // Detect provider from URL line (comes before the code line)
        const provider = detectProvider(line);
        if (provider) {
          detectedProvider = provider;
        }

        // Watch for "Code: XXXXX" pattern
        const codeMatch = line.match(/Code:\s*(\S+)/);
        if (codeMatch && !deviceCodeHandled) {
          deviceCodeHandled = true;
          const code = codeMatch[1];
          const provider = detectedProvider || 'google'; // default to google if URL not seen yet
          console.log(`[E2E] Detected ${provider} device code: ${code}`);

          // Launch Playwright to enter the code — don't block on failure
          enterDeviceCode(provider, code).catch((err) => {
            console.error(`[E2E] Playwright auto-entry failed, manual entry required: ${err}`);
            console.log(`[E2E] >>> Enter code ${code} manually <<<`);
          });
        }
      }
    });

    child.on('close', (exitCode) => {
      clearTimeout(timeout);

      if (exitCode !== 0) {
        console.error(`[E2E] OIDC proof failed (exit ${exitCode})`);
        if (stderr) console.error(`[E2E] stderr: ${stderr}`);
        if (stdout) console.error(`[E2E] stdout: ${stdout}`);
        reject(new Error(`OIDC proof exited with code ${exitCode}: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        console.log('[E2E] OIDC proof completed (auto device flow)');
        resolve(result);
      } catch (err) {
        reject(new Error(`Failed to parse proof output: ${stdout}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
