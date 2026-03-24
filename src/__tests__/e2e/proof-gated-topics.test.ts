import { describe, it, expect } from 'vitest';
import { publicGet, getBaseUrl } from './helpers';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const BASE = getBaseUrl();
const CACHE_DIR = resolve(__dirname, '../../..');
const CACHE_A = resolve(CACHE_DIR, '.e2e-token-cache-a.json');
const CACHE_B = resolve(CACHE_DIR, '.e2e-token-cache-b.json');
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ─── Token cache ─────────────────────────────────────────────────────
interface TokenCache { token: string; userId: string; createdAt: number; }

function loadCache(path: string): TokenCache | null {
  if (!existsSync(path)) return null;
  try {
    const c: TokenCache = JSON.parse(readFileSync(path, 'utf-8'));
    if (Date.now() - c.createdAt < CACHE_TTL) return c;
  } catch {}
  return null;
}

function saveCache(path: string, token: string, userId: string) {
  writeFileSync(path, JSON.stringify({ token, userId, createdAt: Date.now() }));
}

// ─── Proof helpers ───────────────────────────────────────────────────
function getProveEnv(): NodeJS.ProcessEnv {
  const key = process.env.E2E_ATTESTATION_WALLET_KEY;
  if (!key) throw new Error('E2E_ATTESTATION_WALLET_KEY is required in .env.test');
  return { ...process.env, PAYMENT_KEY: key, ATTESTATION_KEY: key };
}

function runProveOidc(args: string, scope: string): Record<string, unknown> {
  const cmd = `npx zkproofport-prove ${args} --scope ${scope} --silent`;
  console.log(`[E2E] OIDC: ${cmd}`);
  console.log('[E2E] >>> Enter device code at https://www.google.com/device <<<');
  const result = execSync(cmd, { env: getProveEnv(), timeout: 300_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'inherit'] });
  return JSON.parse(result.trim());
}

function runProveCoinbase(args: string, scope: string): Record<string, unknown> {
  const cmd = `npx zkproofport-prove ${args} --scope ${scope} --silent 2>/dev/null`;
  console.log(`[E2E] Coinbase: ${cmd}`);
  const result = execSync(cmd, { env: getProveEnv(), timeout: 180_000, encoding: 'utf-8' }) as string;
  console.log('[E2E] Coinbase proof completed');
  return JSON.parse(result.trim());
}

async function getScope(): Promise<{ challengeId: string; scope: string }> {
  const res = await fetch(`${BASE}/api/auth/challenge`, { method: 'POST' });
  if (!res.ok) throw new Error(`Challenge failed: ${res.status}`);
  return res.json();
}

async function loginWithProof(challengeId: string, proofResult: Record<string, unknown>): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${BASE}/api/auth/verify/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId, result: proofResult }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function fetchAuth(path: string, token: string, options?: RequestInit) {
  return fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...options?.headers as Record<string, string>, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

async function loginOrCache(cacheFile: string, label: string): Promise<string> {
  const cached = loadCache(cacheFile);
  if (cached) {
    console.log(`[E2E] ${label}: using cached token (userId: ${cached.userId.slice(0, 10)}...)`);
    return cached.token;
  }
  const { challengeId, scope } = await getScope();
  console.log(`[E2E] === ${label} LOGIN ===`);
  const proofResult = runProveOidc('--login-google', scope);
  const { token, userId } = await loginWithProof(challengeId, proofResult);
  saveCache(cacheFile, token, userId);
  console.log(`[E2E] ${label} logged in (userId: ${userId.slice(0, 10)}...)`);
  return token;
}

// ─── Shared state ────────────────────────────────────────────────────
let categoryId: string;
let userAToken: string;
let userBToken: string;
let openTopicId: string;
let kycTopicId: string;
let countryTopicId: string;
let workspaceTopicId: string;

describe.sequential('Proof-gated topics — MCP CLI E2E', () => {

  // ══════════════════════════════════════════════════
  // SETUP + LOGIN
  // ══════════════════════════════════════════════════

  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  it('User A: login via Google OIDC', async () => {
    userAToken = await loginOrCache(CACHE_A, 'User A');
    const res = await fetchAuth('/api/auth/session', userAToken);
    expect(res.status).toBe(200);
  }, 300_000);

  it('User B: login via Google OIDC (DIFFERENT ACCOUNT)', async () => {
    console.log('[E2E] >>> Use a DIFFERENT Google account for User B! <<<');
    userBToken = await loginOrCache(CACHE_B, 'User B');
    expect(userBToken).not.toBe(userAToken);
    // Verify different users
    const resA = await (await fetchAuth('/api/auth/session', userAToken)).json();
    const resB = await (await fetchAuth('/api/auth/session', userBToken)).json();
    expect(resA.userId).not.toBe(resB.userId);
    console.log(`[E2E] User A: ${resA.userId.slice(0, 10)}..., User B: ${resB.userId.slice(0, 10)}...`);
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
    const { scope } = await getScope();
    const proofResult = runProveCoinbase('coinbase_kyc', scope);
    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({ title: `E2E KYC ${Date.now()}`, description: 'KYC required', categoryId, proofType: 'kyc', proof: proofResult.proof, publicInputs: proofResult.publicInputs }),
    });
    expect(res.status).toBe(201);
    kycTopicId = (await res.json()).topic.id;
  }, 180_000);

  it('User A: creates country-gated topic (KR)', async () => {
    const { scope } = await getScope();
    const proofResult = runProveCoinbase('coinbase_country --countries KR --included true', scope);
    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({ title: `E2E Country ${Date.now()}`, description: 'KR only', categoryId, proofType: 'country', requiresCountryProof: true, allowedCountries: ['KR'], countryMode: 'include', proof: proofResult.proof, publicInputs: proofResult.publicInputs }),
    });
    expect(res.status).toBe(201);
    countryTopicId = (await res.json()).topic.id;
  }, 180_000);

  it('User A: workspace topic without proof → 400 (login cache ≠ workspace proof)', async () => {
    // OIDC login caches as 'oidc_login', NOT 'oidc_domain'
    // So workspace topic creation should FAIL without explicit workspace proof
    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({ title: `E2E Workspace Fail ${Date.now()}`, description: 'Should fail', categoryId, proofType: 'workspace' }),
    });
    expect(res.status).toBe(400);
    console.log('[E2E] Workspace topic correctly rejected without workspace proof');
  });

  it.skip('User A: creates workspace-gated topic with Google Workspace proof', async () => {
    // Skip: test account has no Google Workspace. Enable when available.
    const { scope } = await getScope();
    const proofResult = runProveOidc('--login-google-workspace', scope);
    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({ title: `E2E GW Topic ${Date.now()}`, description: 'Google Workspace required', categoryId, proofType: 'google_workspace', proof: proofResult.proof, publicInputs: proofResult.publicInputs }),
    });
    expect(res.status).toBe(201);
  }, 300_000);

  it('User A: creates workspace-gated topic with Microsoft 365 proof', async () => {
    const { scope } = await getScope();
    console.log('[E2E] User A: Microsoft 365 device flow for topic creation');
    const proofResult = runProveOidc('--login-microsoft-365', scope);
    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({ title: `E2E MS365 Topic ${Date.now()}`, description: 'Org required', categoryId, proofType: 'workspace', proof: proofResult.proof, publicInputs: proofResult.publicInputs }),
    });
    expect(res.status).toBe(201);
    workspaceTopicId = (await res.json()).topic.id;
  }, 300_000);

  // ══════════════════════════════════════════════════
  // USER B — JOIN OPEN TOPIC
  // ══════════════════════════════════════════════════

  it('User B: joins open topic', async () => {
    const res = await fetchAuth(`/api/topics/${openTopicId}/join`, userBToken, { method: 'POST', body: '{}' });
    expect(res.status).toBe(201);
  });

  it('User B: joining open topic again → 409', async () => {
    const res = await fetchAuth(`/api/topics/${openTopicId}/join`, userBToken, { method: 'POST', body: '{}' });
    expect(res.status).toBe(409);
  });

  // ══════════════════════════════════════════════════
  // USER B — JOIN KYC TOPIC
  // ══════════════════════════════════════════════════

  it('User B: join KYC topic without proof → 402 or 201 (cached)', async () => {
    expect(kycTopicId).toBeTruthy();
    const res = await fetchAuth(`/api/topics/${kycTopicId}/join`, userBToken, { method: 'POST', body: '{}' });
    expect([201, 402]).toContain(res.status);
    if (res.status === 402) {
      const json = await res.json();
      expect(json.proofRequirement).toBeDefined();
      expect(json.proofRequirement.type).toBe('kyc');
      console.log('[E2E] 402 — proof required for KYC topic');
    } else {
      console.log('[E2E] 201 — KYC verification cached from previous run');
    }
  });

  it('User B: generates KYC proof and joins (if not already member)', async () => {
    expect(kycTopicId).toBeTruthy();
    // Check if already member
    const check = await fetchAuth(`/api/topics/${kycTopicId}/join`, userBToken, { method: 'POST', body: '{}' });
    if (check.status === 409) {
      console.log('[E2E] User B already a member of KYC topic');
      return;
    }
    // Generate proof and join
    const { scope } = await getScope();
    const proofResult = runProveCoinbase('coinbase_kyc', scope);
    const res = await fetchAuth(`/api/topics/${kycTopicId}/join`, userBToken, {
      method: 'POST',
      body: JSON.stringify({ proof: proofResult.proof, publicInputs: proofResult.publicInputs }),
    });
    expect(res.status).toBe(201);
    console.log('[E2E] User B joined KYC topic with proof');
  }, 180_000);

  // ══════════════════════════════════════════════════
  // USER B — JOIN COUNTRY TOPIC
  // ══════════════════════════════════════════════════

  it('User B: join country topic without proof → 402 or 201 (cached)', async () => {
    expect(countryTopicId).toBeTruthy();
    const res = await fetchAuth(`/api/topics/${countryTopicId}/join`, userBToken, { method: 'POST', body: '{}' });
    expect([201, 402]).toContain(res.status);
    if (res.status === 402) {
      const json = await res.json();
      expect(json.proofRequirement.type).toBe('country');
      console.log('[E2E] 402 — proof required for country topic');
    } else {
      console.log('[E2E] 201 — country verification cached');
    }
  });

  it('User B: generates country proof and joins (if not already member)', async () => {
    expect(countryTopicId).toBeTruthy();
    const check = await fetchAuth(`/api/topics/${countryTopicId}/join`, userBToken, { method: 'POST', body: '{}' });
    if (check.status === 409) {
      console.log('[E2E] User B already a member of country topic');
      return;
    }
    const { scope } = await getScope();
    const proofResult = runProveCoinbase('coinbase_country --countries KR --included true', scope);
    const res = await fetchAuth(`/api/topics/${countryTopicId}/join`, userBToken, {
      method: 'POST',
      body: JSON.stringify({ proof: proofResult.proof, publicInputs: proofResult.publicInputs }),
    });
    expect(res.status).toBe(201);
    console.log('[E2E] User B joined country topic with proof');
  }, 180_000);

  // ══════════════════════════════════════════════════
  // USER B — JOIN WORKSPACE TOPIC
  // ══════════════════════════════════════════════════

  it('User B: join workspace topic without proof → 402', async () => {
    expect(workspaceTopicId).toBeTruthy();
    const res = await fetchAuth(`/api/topics/${workspaceTopicId}/join`, userBToken, { method: 'POST', body: '{}' });
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.proofRequirement).toBeDefined();
    console.log('[E2E] 402 — workspace proof required (login cache ≠ workspace)');
  });

  it.skip('User B: generates Google Workspace proof and joins', async () => {
    // Skip: test account has no Google Workspace
    expect(workspaceTopicId).toBeTruthy();
    const { scope } = await getScope();
    const proofResult = runProveOidc('--login-google-workspace', scope);
    const res = await fetchAuth(`/api/topics/${workspaceTopicId}/join`, userBToken, {
      method: 'POST',
      body: JSON.stringify({ proof: proofResult.proof, publicInputs: proofResult.publicInputs }),
    });
    expect(res.status).toBe(201);
  }, 300_000);

  it('User B: generates Microsoft 365 proof and joins', async () => {
    expect(workspaceTopicId).toBeTruthy();
    const { scope } = await getScope();
    console.log('[E2E] User B: Microsoft 365 device flow for join');
    const proofResult = runProveOidc('--login-microsoft-365', scope);
    const res = await fetchAuth(`/api/topics/${workspaceTopicId}/join`, userBToken, {
      method: 'POST',
      body: JSON.stringify({ proof: proofResult.proof, publicInputs: proofResult.publicInputs }),
    });
    expect(res.status).toBe(201);
    console.log('[E2E] User B joined workspace topic with MS365 proof');
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
  // VERIFICATION CACHE + PRIVACY
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
      kyc: 'coinbase_attestation', country: 'coinbase_country_attestation',
      google_workspace: 'oidc_domain_attestation', microsoft_365: 'oidc_domain_attestation',
      workspace: 'oidc_domain_attestation',
    };
    for (const [type, circuit] of Object.entries(expected)) {
      const res = await fetch(`${BASE}/api/docs/proof-guide/${type}`);
      expect(res.status).toBe(200);
      expect((await res.json()).circuit).toBe(circuit);
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
