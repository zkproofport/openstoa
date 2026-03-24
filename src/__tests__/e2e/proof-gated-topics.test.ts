import { describe, it, expect } from 'vitest';
import { authGet, authPost, publicGet, getBaseUrl } from './helpers';
import { execSync } from 'child_process';

/**
 * E2E tests for proof-gated topics — uses zkproofport-prove CLI (MCP).
 *
 * Authentication: Google OIDC device flow via zkproofport-prove CLI.
 * The CLI prints a device code to stderr — enter it at https://www.google.com/device
 *
 * Two users:
 * - User A: Login via Google OIDC (global-setup or cached token)
 * - User B: Login via Google OIDC (second account, fresh device flow)
 *
 * Proof types tested:
 * - KYC (coinbase_attestation) — topic creation + join
 * - Country (coinbase_country_attestation) — topic creation + join
 * - Workspace (oidc_domain_attestation) — topic creation + join
 *   - google_workspace with domain
 *   - google_workspace without domain
 *   - workspace (any provider)
 *
 * Edge cases:
 * - Join without proof → 402 with proof guide
 * - Already a member → 409
 * - Non-public visibility → 400
 * - Wrong proof type → rejected
 */

const BASE = getBaseUrl();
/**
 * Run zkproofport-prove CLI and return the proof result.
 * stderr contains device code (for OIDC) — user must enter it manually.
 * stdout contains JSON proof result (with --silent flag).
 */
function runProve(args: string, scope: string, timeoutMs = 180_000): Record<string, unknown> {
  const key = process.env.E2E_ATTESTATION_WALLET_KEY;
  if (!key) throw new Error('E2E_ATTESTATION_WALLET_KEY is required in .env.test');
  const env = { ...process.env, PAYMENT_KEY: key, ATTESTATION_KEY: key };
  const cmd = `npx zkproofport-prove ${args} --scope ${scope} --silent`;
  console.log(`[E2E] Running: ${cmd}`);
  console.log('[E2E] Check stderr for device code if OIDC login required');
  const result = execSync(cmd, {
    env,
    timeout: timeoutMs,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'inherit'], // stderr goes to console (shows device code)
  });
  return JSON.parse(result.trim());
}

/**
 * Get a fresh challenge scope from OpenStoa.
 */
async function getScope(): Promise<{ challengeId: string; scope: string }> {
  const res = await fetch(`${BASE}/api/auth/challenge`, { method: 'POST' });
  return res.json();
}

/**
 * Login to OpenStoa with a proof result.
 */
async function loginWithProof(challengeId: string, proofResult: Record<string, unknown>): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${BASE}/api/auth/verify/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId, result: proofResult }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Helper for authenticated requests with a specific token
function fetchAuth(path: string, token: string, options?: RequestInit) {
  return fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...options?.headers as Record<string, string>, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

// Shared state
let categoryId: string;
let userAToken: string;
let userBToken: string;
let openTopicId: string;
let kycTopicId: string;
let countryTopicId: string;
let workspaceTopicId: string;

describe.sequential('Proof-gated topics — MCP CLI E2E', () => {

  // ══════════════════════════════════════════════════
  // SETUP
  // ══════════════════════════════════════════════════

  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  // ══════════════════════════════════════════════════
  // USER A — LOGIN VIA GOOGLE OIDC
  // ══════════════════════════════════════════════════

  it('User A: login via Google OIDC (enter device code at https://www.google.com/device)', async () => {
    const { challengeId, scope } = await getScope();
    console.log('[E2E] === User A LOGIN ===');
    console.log('[E2E] Enter the device code below at https://www.google.com/device');
    const proofResult = runProve('--login-google', scope, 300_000);
    const { token } = await loginWithProof(challengeId, proofResult);
    userAToken = token;
    expect(userAToken).toBeTruthy();

    // Verify session
    const res = await fetchAuth('/api/auth/session', userAToken);
    expect(res.status).toBe(200);
    console.log('[E2E] User A logged in successfully');
  }, 300_000);

  it('User B: login via Google OIDC (USE DIFFERENT ACCOUNT)', async () => {
    const { challengeId, scope } = await getScope();
    console.log('[E2E] === User B LOGIN ===');
    console.log('[E2E] Enter the device code below at https://www.google.com/device');
    console.log('[E2E] >>> USE A DIFFERENT GOOGLE ACCOUNT <<<');
    const proofResult = runProve('--login-google', scope, 300_000);
    const { token } = await loginWithProof(challengeId, proofResult);
    userBToken = token;
    expect(userBToken).toBeTruthy();
    expect(userBToken).not.toBe(userAToken);
    console.log('[E2E] User B logged in successfully');
  }, 300_000);

  // ══════════════════════════════════════════════════
  // USER A — CREATE TOPICS
  // ══════════════════════════════════════════════════

  it('User A: creates open topic', async () => {
    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({ title: `E2E Open ${Date.now()}`, description: 'No proof', categoryId, proofType: 'none' }),
    });
    expect(res.status).toBe(201);
    openTopicId = (await res.json()).topic.id;
  });

  it('User A: creates KYC-gated topic', async () => {
    // User A logged in via OIDC — no KYC cache. Need to generate KYC proof.
    const { scope } = await getScope();
    console.log('[E2E] User A: generating KYC proof for topic creation...');
    const proofResult = runProve('coinbase_kyc', scope);

    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({
        title: `E2E KYC ${Date.now()}`, description: 'KYC required', categoryId,
        proofType: 'kyc',
        proof: proofResult.proof,
        publicInputs: proofResult.publicInputs,
      }),
    });
    expect(res.status).toBe(201);
    kycTopicId = (await res.json()).topic.id;
  }, 180_000);

  it('User A: creates country-gated topic (KR)', async () => {
    const { scope } = await getScope();
    console.log('[E2E] User A: generating country proof (KR) for topic creation...');
    const proofResult = runProve('coinbase_country --countries KR --included true', scope);

    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({
        title: `E2E Country KR ${Date.now()}`, description: 'KR only', categoryId,
        proofType: 'country', requiresCountryProof: true,
        allowedCountries: ['KR'], countryMode: 'include',
        proof: proofResult.proof,
        publicInputs: proofResult.publicInputs,
      }),
    });
    expect(res.status).toBe(201);
    countryTopicId = (await res.json()).topic.id;
  }, 180_000);

  it('User A: creates workspace-gated topic (Google Workspace)', async () => {
    const { scope } = await getScope();
    console.log('[E2E] User A: Google Workspace device flow — enter code at https://www.google.com/device');
    const proofResult = runProve('--login-google-workspace', scope);

    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({
        title: `E2E Workspace ${Date.now()}`, description: 'Org required', categoryId,
        proofType: 'workspace',
        proof: proofResult.proof,
        publicInputs: proofResult.publicInputs,
      }),
    });
    expect(res.status).toBe(201);
    workspaceTopicId = (await res.json()).topic.id;
  }, 300_000);

  // ══════════════════════════════════════════════════
  // USER B — JOIN OPEN TOPIC
  // ══════════════════════════════════════════════════

  it('User B: joins open topic', async () => {
    const res = await fetchAuth(`/api/topics/${openTopicId}/join`, userBToken, {
      method: 'POST', body: '{}',
    });
    expect(res.status).toBe(201);
  });

  it('User B: joining same topic again → 409', async () => {
    const res = await fetchAuth(`/api/topics/${openTopicId}/join`, userBToken, {
      method: 'POST', body: '{}',
    });
    expect(res.status).toBe(409);
  });

  // ══════════════════════════════════════════════════
  // USER B — JOIN KYC TOPIC (402 → proof → 201)
  // ══════════════════════════════════════════════════

  it('User B: join KYC topic without proof → 402', async () => {
    const res = await fetchAuth(`/api/topics/${kycTopicId}/join`, userBToken, {
      method: 'POST', body: '{}',
    });
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error).toContain('Proof required');
    expect(json.proofRequirement).toBeDefined();
    expect(json.proofRequirement.type).toBe('kyc');
  });

  it('User B: generates KYC proof and joins', async () => {
    const { scope } = await getScope();
    console.log('[E2E] User B: generating KYC proof for join...');
    const proofResult = runProve('coinbase_kyc', scope);

    const res = await fetchAuth(`/api/topics/${kycTopicId}/join`, userBToken, {
      method: 'POST',
      body: JSON.stringify({ proof: proofResult.proof, publicInputs: proofResult.publicInputs }),
    });
    expect(res.status).toBe(201);
  }, 180_000);

  // ══════════════════════════════════════════════════
  // USER B — JOIN COUNTRY TOPIC (402 → proof → 201)
  // ══════════════════════════════════════════════════

  it('User B: join country topic without proof → 402', async () => {
    const res = await fetchAuth(`/api/topics/${countryTopicId}/join`, userBToken, {
      method: 'POST', body: '{}',
    });
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.proofRequirement.type).toBe('country');
  });

  it('User B: generates country proof (KR) and joins', async () => {
    const { scope } = await getScope();
    console.log('[E2E] User B: generating country proof (KR) for join...');
    const proofResult = runProve('coinbase_country --countries KR --included true', scope);

    const res = await fetchAuth(`/api/topics/${countryTopicId}/join`, userBToken, {
      method: 'POST',
      body: JSON.stringify({ proof: proofResult.proof, publicInputs: proofResult.publicInputs }),
    });
    expect(res.status).toBe(201);
  }, 180_000);

  // ══════════════════════════════════════════════════
  // USER B — JOIN WORKSPACE TOPIC (402 → proof → 201)
  // ══════════════════════════════════════════════════

  it('User B: join workspace topic without proof → 402', async () => {
    if (!workspaceTopicId) return;
    const res = await fetchAuth(`/api/topics/${workspaceTopicId}/join`, userBToken, {
      method: 'POST', body: '{}',
    });
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.proofRequirement.type).toMatch(/workspace|google_workspace|microsoft_365/);
  });

  it('User B: generates workspace proof and joins', async () => {
    if (!workspaceTopicId) return;
    const { scope } = await getScope();
    console.log('[E2E] User B: Google Workspace device flow — enter code at https://www.google.com/device');
    const proofResult = runProve('--login-google-workspace', scope);

    const res = await fetchAuth(`/api/topics/${workspaceTopicId}/join`, userBToken, {
      method: 'POST',
      body: JSON.stringify({ proof: proofResult.proof, publicInputs: proofResult.publicInputs }),
    });
    expect(res.status).toBe(201);
  }, 300_000);

  // ══════════════════════════════════════════════════
  // EDGE CASES
  // ══════════════════════════════════════════════════

  it('rejects non-public visibility (private)', async () => {
    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({ title: `E2E Priv ${Date.now()}`, description: 'fail', categoryId, visibility: 'private' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-public visibility (secret)', async () => {
    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({ title: `E2E Sec ${Date.now()}`, description: 'fail', categoryId, visibility: 'secret' }),
    });
    expect(res.status).toBe(400);
  });

  // ══════════════════════════════════════════════════
  // VERIFICATION CACHE
  // ══════════════════════════════════════════════════

  it('User A: badges show cached verifications', async () => {
    const res = await fetchAuth('/api/profile/badges', userAToken);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.badges).toBeDefined();
    expect(Array.isArray(json.badges)).toBe(true);
  });

  it('badges contain no raw PII', async () => {
    const text = await (await fetchAuth('/api/profile/badges', userAToken)).text();
    expect(text).not.toContain('"email"');
    expect(text).not.toContain('"publicInputs"');
  });

  // ══════════════════════════════════════════════════
  // PROOF GUIDE API
  // ══════════════════════════════════════════════════

  it('proof guide: all types return correct circuit', async () => {
    const expected: Record<string, string> = {
      kyc: 'coinbase_attestation',
      country: 'coinbase_country_attestation',
      google_workspace: 'oidc_domain_attestation',
      microsoft_365: 'oidc_domain_attestation',
      workspace: 'oidc_domain_attestation',
    };
    for (const [type, circuit] of Object.entries(expected)) {
      const res = await fetch(`${BASE}/api/docs/proof-guide/${type}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.circuit).toBe(circuit);
      expect(json.steps.agent.length).toBeGreaterThan(0);
    }
  });

  it('proof guide: invalid type → 400', async () => {
    const res = await fetch(`${BASE}/api/docs/proof-guide/invalid`);
    expect(res.status).toBe(400);
  });

  // ══════════════════════════════════════════════════
  // DOCUMENTATION
  // ══════════════════════════════════════════════════

  it('GET /AGENTS.md returns markdown', async () => {
    const res = await fetch(`${BASE}/AGENTS.md`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('OpenStoa');
    expect(text).toContain('Privacy');
  });

  it('GET /skill.md returns skill file', async () => {
    const res = await fetch(`${BASE}/skill.md`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('name: openstoa');
    expect(text).toContain('AUTO-GENERATED API REFERENCE');
  });

  it('proof guide URLs use staging base', async () => {
    const json = await (await fetch(`${BASE}/api/docs/proof-guide/kyc`)).json();
    const codes = json.steps.agent.map((s: { code?: string }) => s.code || '').join('');
    if (BASE.includes('stg-')) {
      expect(codes).toContain('stg-community.zkproofport.app');
    }
  });
});
