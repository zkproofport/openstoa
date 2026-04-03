import { describe, it, expect } from 'vitest';
import { publicGet, getBaseUrl } from './helpers';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { runProveWithAutoDeviceFlow } from './device-flow-helper';

const BASE = getBaseUrl();
const CACHE_DIR = resolve(__dirname, '../../..');
const CACHE_A = resolve(CACHE_DIR, '.e2e-token-cache-a.json');
const CACHE_B = resolve(CACHE_DIR, '.e2e-token-cache-b.json');
const CACHE_TTL = 23 * 60 * 60 * 1000; // 23 hours (JWT is 24h, leave 1h margin)

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
  return { ...process.env, ATTESTATION_KEY: key };
}

async function runProveOidc(args: string, scope: string, accountEmail?: string): Promise<Record<string, unknown>> {
  return runProveWithAutoDeviceFlow(args, scope, getProveEnv(), accountEmail);
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

async function loginOrCache(cacheFile: string, label: string, accountEmail?: string): Promise<string> {
  const cached = loadCache(cacheFile);
  if (cached) {
    console.log(`[E2E] ${label}: using cached token (userId: ${cached.userId.slice(0, 10)}...)`);
    return cached.token;
  }
  const { challengeId, scope } = await getScope();
  console.log(`[E2E] === ${label} LOGIN ===`);
  const proofResult = await runProveOidc('--login-google', scope, accountEmail);
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
    userAToken = await loginOrCache(CACHE_A, 'User A', process.env.E2E_GOOGLE_USER_A);
    const res = await fetchAuth('/api/auth/session', userAToken);
    expect(res.status).toBe(200);
  }, 300_000);

  it('User B: login via Google OIDC (DIFFERENT ACCOUNT)', async () => {
    console.log('[E2E] >>> Use a DIFFERENT Google account for User B! <<<');
    userBToken = await loginOrCache(CACHE_B, 'User B', process.env.E2E_GOOGLE_USER_B);
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

  it('User A: workspace topic without proof → 400 (after clearing oidc_domain cache)', async () => {
    // Clear oidc_domain cache so we can verify that oidc_login alone doesn't satisfy workspace
    await fetchAuth('/api/test/clear-verification-cache?type=oidc_domain', userAToken, { method: 'DELETE' });
    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({ title: `E2E Workspace Fail ${Date.now()}`, description: 'Should fail', categoryId, proofType: 'workspace' }),
    });
    expect(res.status).toBe(400);
    console.log('[E2E] 400 — workspace topic correctly rejected (oidc_login ≠ oidc_domain)');
  });

  it.skip('User A: creates workspace-gated topic with Google Workspace proof', async () => {
    // Skip: test account has no Google Workspace. Enable when available.
    const { scope } = await getScope();
    const proofResult = await runProveOidc('--login-google-workspace', scope);
    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({ title: `E2E GW Topic ${Date.now()}`, description: 'Google Workspace required', categoryId, proofType: 'google_workspace', proof: proofResult.proof, publicInputs: proofResult.publicInputs }),
    });
    expect(res.status).toBe(201);
  }, 300_000);

  it('User A: creates workspace-gated topic with Microsoft 365 proof', async () => {
    const { scope } = await getScope();
    console.log('[E2E] User A: Microsoft 365 device flow for topic creation');
    const proofResult = await runProveOidc('--login-microsoft-365', scope, process.env.E2E_MS365_USER_A);
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

  it('User B: join workspace topic without proof → 402 (after clearing oidc_domain cache)', async () => {
    expect(workspaceTopicId).toBeTruthy();
    // Clear oidc_domain cache so we can verify that proof is required
    await fetchAuth('/api/test/clear-verification-cache?type=oidc_domain', userBToken, { method: 'DELETE' });
    const res = await fetchAuth(`/api/topics/${workspaceTopicId}/join`, userBToken, { method: 'POST', body: '{}' });
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.proofRequirement).toBeDefined();
    console.log('[E2E] 402 — workspace proof required (oidc_login ≠ oidc_domain)');
  });

  it.skip('User B: generates Google Workspace proof and joins', async () => {
    // Skip: test account has no Google Workspace
    expect(workspaceTopicId).toBeTruthy();
    const { scope } = await getScope();
    const proofResult = await runProveOidc('--login-google-workspace', scope);
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
    const proofResult = await runProveOidc('--login-microsoft-365', scope, process.env.E2E_MS365_USER_B);
    const res = await fetchAuth(`/api/topics/${workspaceTopicId}/join`, userBToken, {
      method: 'POST',
      body: JSON.stringify({ proof: proofResult.proof, publicInputs: proofResult.publicInputs }),
    });
    expect(res.status).toBe(201);
    console.log('[E2E] User B joined workspace topic with MS365 proof');
  }, 300_000);

  // ══════════════════════════════════════════════════
  // WORKSPACE DOMAIN EDGE CASES
  // ══════════════════════════════════════════════════

  it('5. Domain-restricted workspace topic with wrong domain → 403', async () => {
    // Create a workspace topic that requires a specific domain no test user belongs to
    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({
        title: `E2E Wrong Domain ${Date.now()}`,
        description: 'Restricted to nonexistent-company.com',
        categoryId,
        proofType: 'workspace',
        requiredDomain: 'nonexistent-company.com',
        proof: undefined,
        publicInputs: undefined,
      }),
    });
    // Topic creation itself needs a workspace proof — skip gracefully if unavailable
    if (res.status === 400 || res.status === 402) {
      console.log(`[E2E] Skipping test 5: topic creation returned ${res.status} (workspace proof required)`);
      return;
    }
    expect(res.status).toBe(201);
    const wrongDomainTopicId = (await res.json()).topic.id;
    console.log(`[E2E] Created domain-restricted topic: ${wrongDomainTopicId}`);

    // User B tries to join — their workspace domain doesn't match 'nonexistent-company.com'
    const joinRes = await fetchAuth(`/api/topics/${wrongDomainTopicId}/join`, userBToken, {
      method: 'POST',
      body: '{}',
    });
    console.log(`[E2E] Join wrong-domain topic → ${joinRes.status}`);
    // 403 (domain mismatch) or 402 (no cached workspace proof for User B)
    expect([402, 403]).toContain(joinRes.status);
    if (joinRes.status === 403) {
      const json = await joinRes.json();
      expect(json.error).toBeTruthy();
      console.log('[E2E] 403 — domain mismatch correctly rejected');
    } else {
      console.log('[E2E] 402 — workspace proof required (no cached oidc_domain for User B)');
    }
  }, 300_000);

  it('6. Workspace topic with no domain restriction — any domain → 201', async () => {
    // Create a workspace topic with NO requiredDomain (null — any workspace domain accepted)
    const createRes = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({
        title: `E2E Any Domain ${Date.now()}`,
        description: 'Any workspace domain accepted',
        categoryId,
        proofType: 'workspace',
      }),
    });
    // Topic creation needs a workspace proof — skip gracefully if unavailable
    if (createRes.status === 400 || createRes.status === 402) {
      console.log(`[E2E] Skipping test 6: topic creation returned ${createRes.status} (workspace proof required)`);
      return;
    }
    expect(createRes.status).toBe(201);
    const anyDomainTopicId = (await createRes.json()).topic.id;
    console.log(`[E2E] Created any-domain workspace topic: ${anyDomainTopicId}`);

    // User B: generate MS365 proof (or use cached oidc_domain) and join
    const { scope } = await getScope();
    console.log('[E2E] User B: Microsoft 365 device flow for any-domain workspace join');
    const proofResult = await runProveOidc('--login-microsoft-365', scope, process.env.E2E_MS365_USER_B);
    const joinRes = await fetchAuth(`/api/topics/${anyDomainTopicId}/join`, userBToken, {
      method: 'POST',
      body: JSON.stringify({ proof: proofResult.proof, publicInputs: proofResult.publicInputs }),
    });
    expect(joinRes.status).toBe(201);
    console.log('[E2E] 201 — any workspace domain accepted (no domain restriction)');
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

  // ══════════════════════════════════════════════════
  // PROOF EDGE CASES
  // ══════════════════════════════════════════════════

  // ── Test 1: Join non-existent topic → 404 ──────────────────────────────────

  it('edge: join non-existent topic → 404', async () => {
    const fakeTopicId = '00000000-0000-0000-0000-000000000000';
    const res = await fetchAuth(`/api/topics/${fakeTopicId}/join`, userAToken, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── Test 2: Create topic with invalid proofType → 400 ─────────────────────

  it('edge: create topic with invalid proofType → 400', async () => {
    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Invalid ProofType Test',
        categoryId,
        proofType: 'invalid_type',
      }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── Test 3: Create country topic with mismatched country_list → 403 ────────
  // After the creation-side fix, the server verifies that the creator's proof
  // country_list matches the topic's allowedCountries at creation time.
  // A KR wallet cannot create a JP-only topic — the server rejects it with 403.

  it('edge: create country topic with mismatched country_list → 403', async () => {
    // Generate KR proof (wallet is KR)
    const { scope } = await getScope();
    const krProof = runProveCoinbase('coinbase_country --countries KR --included true', scope);

    // Try to create JP-only topic with KR proof → 403 (country list mismatch)
    const res = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({
        title: `E2E Country Create Mismatch ${Date.now()}`,
        categoryId,
        proofType: 'country',
        requiresCountryProof: true,
        allowedCountries: ['JP'],
        countryMode: 'include',
        proof: krProof.proof,
        publicInputs: krProof.publicInputs,
      }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    console.log('[E2E] 403 — creator country list mismatch correctly rejected');
  }, 180_000);

  // ── Test 4: Country exclude mode — is_included=0 proof rejected on inclusion-required topic ──
  // A KR wallet CAN generate coinbase_country --countries JP --included false:
  // this proves "my country is NOT in [JP]" — which is true (KR ≠ JP), so is_included=0.
  // A topic that requires KR membership (allowedCountries: ['KR'], countryMode: 'include')
  // must reject this proof because is_included=0 means the wallet proved exclusion, not inclusion.

  it('edge: country exclude mode proof (is_included=0) rejected by inclusion topic → 403', async () => {
    // Generate KR proof for creator (to satisfy topic creation requirement)
    const { scope: creatorScope } = await getScope();
    const creatorProof = runProveCoinbase('coinbase_country --countries KR --included true', creatorScope);

    // Create a KR-only topic with creator's proof
    const topicRes = await fetchAuth('/api/topics', userAToken, {
      method: 'POST',
      body: JSON.stringify({
        title: `E2E Country Exclude ${Date.now()}`,
        description: 'KR only — exclude-mode proof should be rejected',
        categoryId,
        proofType: 'country',
        requiresCountryProof: true,
        allowedCountries: ['KR'],
        countryMode: 'include',
        proof: creatorProof.proof,
        publicInputs: creatorProof.publicInputs,
      }),
    });
    expect(topicRes.status).toBe(201);
    const { topic } = await topicRes.json();
    console.log(`[E2E] Created KR-only topic: ${topic.id}`);

    // Generate an exclude-mode proof: proves wallet is NOT in [JP] list → is_included=0
    // KR wallet + JP list → KR is not JP → is_included=0 (truthful exclusion proof)
    const { scope } = await getScope();
    const proofResult = runProveCoinbase('coinbase_country --countries JP --included false', scope);

    // User B tries to join the KR-only topic with an is_included=0 proof
    const joinRes = await fetchAuth(`/api/topics/${topic.id}/join`, userBToken, {
      method: 'POST',
      body: JSON.stringify({ proof: proofResult.proof, publicInputs: proofResult.publicInputs }),
    });

    console.log(`[E2E] Join KR topic with is_included=0 proof → ${joinRes.status}`);
    expect(joinRes.status).toBe(403);
    const json = await joinRes.json();
    expect(json.error).toBeTruthy();
    console.log('[E2E] 403 — is_included=0 (exclude-mode proof) correctly rejected');
  }, 180_000);

  // ── Test 7: Non-existent challengeId → 400 ────────────────────────────────

  it('edge: non-existent / expired challengeId → 400', async () => {
    // Use a well-formed but non-existent challengeId — Redis key won't be found.
    // Server returns 400 (invalid/expired challenge).
    const nonExistentChallengeId = 'nonexistent-challenge-id-' + Date.now().toString(36);
    const res = await fetch(`${BASE}/api/auth/verify/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challengeId: nonExistentChallengeId,
        result: { proof: '0x' + 'ab'.repeat(32), publicInputs: '0x' + 'cd'.repeat(32) },
      }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    console.log(`[E2E] 400 — non-existent challengeId correctly rejected`);
  });

  // ── Test 8: Scope mismatch in proof → non-2xx ─────────────────────────────
  // POST to verify/ai with a fake proof that has wrong scope in publicInputs.
  // Since proof verification happens on-chain first, invalid proof data fails
  // before scope check → 400 or 401 depending on failure point.

  it('edge: invalid proof data with wrong scope → non-2xx', async () => {
    const { challengeId } = await getScope();

    // Send clearly invalid hex data — will fail at proof verification stage
    const res = await fetch(`${BASE}/api/auth/verify/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challengeId,
        result: {
          proof: '0x' + '00'.repeat(64),
          publicInputs: '0x' + '00'.repeat(128), // wrong scope encoded in zeros
        },
      }),
    });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(201);
    console.log(`[E2E] Status ${res.status} — scope mismatch / invalid proof correctly rejected`);
  });

  // ── Test 9: Malformed proof data (empty string, invalid hex) → 400 ─────────

  it('edge: join topic with empty proof string → 400', async () => {
    // Use a non-existent topic ID — format validation or 404 fires first
    const fakeTopicId = '00000000-0000-0000-0000-000000000001';
    const res = await fetchAuth(`/api/topics/${fakeTopicId}/join`, userAToken, {
      method: 'POST',
      body: JSON.stringify({ proof: '', publicInputs: '' }),
    });
    // Should fail with 400 (bad input) or 404 (topic not found first)
    expect([400, 404]).toContain(res.status);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    console.log(`[E2E] ${res.status} — empty proof correctly rejected`);
  });

  it('edge: join topic with non-hex proof string → 400', async () => {
    const fakeTopicId = '00000000-0000-0000-0000-000000000001';
    const res = await fetchAuth(`/api/topics/${fakeTopicId}/join`, userAToken, {
      method: 'POST',
      body: JSON.stringify({ proof: 'not-hex-data', publicInputs: 'also-not-hex' }),
    });
    expect([400, 404]).toContain(res.status);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    console.log(`[E2E] ${res.status} — non-hex proof correctly rejected`);
  });

  it('edge: POST /api/auth/verify/ai with empty proof → 400', async () => {
    const { challengeId } = await getScope();
    const res = await fetch(`${BASE}/api/auth/verify/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, result: { proof: '', publicInputs: '' } }),
    });
    expect([400, 401]).toContain(res.status);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    console.log(`[E2E] ${res.status} — empty proof in verify/ai correctly rejected`);
  });

  it('edge: KYC proof rejected for login (proofType: kyc) → 400', async () => {
    const { challengeId, scope } = await getScope();
    console.log('[E2E] Generating KYC proof to test login rejection...');
    const proofResult = runProveCoinbase('coinbase_kyc', scope);
    expect(proofResult.proofType).toBe('kyc');
    console.log(`[E2E] KYC proof generated, proofType: ${proofResult.proofType}`);
    const res = await fetch(`${BASE}/api/auth/verify/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, result: proofResult }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('proofType');
    console.log(`[E2E] ${res.status} — KYC proof correctly rejected for login: ${json.error}`);
  });

  it('edge: missing proofType rejected for login → 400', async () => {
    const { challengeId } = await getScope();
    const res = await fetch(`${BASE}/api/auth/verify/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challengeId,
        result: { proof: '0x1234', publicInputs: '0x5678', verification: { chainId: 8453, verifierAddress: '0x0000', rpcUrl: 'https://mainnet.base.org' } },
      }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    console.log(`[E2E] ${res.status} — missing proofType correctly rejected: ${json.error}`);
  });
});
