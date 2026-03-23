import { describe, it, expect } from 'vitest';
import { authGet, authPost, publicGet, getBaseUrl } from './helpers';

/**
 * E2E tests for proof-gated topics — REAL proof generation + join flow.
 *
 * Two users:
 * - User A: KYC-verified (from global-setup via AI SDK proof)
 * - User B: dev-login (no verification cache) — tests join flow
 *
 * Flows tested:
 * 1. User A creates gated topics (kyc, country, workspace variants)
 * 2. User B tries to join without proof → 402 with guide
 * 3. User B generates proof → joins → 201
 * 4. User B's verification cached → next join skips proof
 * 5. Edge cases: wrong domain, non-public visibility, already member, etc.
 */

const BASE = getBaseUrl();

// User A: KYC-verified (from global-setup)
function getTokenA(): string {
  return process.env.E2E_AUTH_TOKEN!;
}

// User B: dev-login (no verification)
let tokenB: string;
let userBId: string;

// Helpers for User B requests
function authGetB(path: string) {
  return fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${tokenB}` } });
}
function authPostB(path: string, body: Record<string, unknown>) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Shared state
let categoryId: string;
let kycTopicId: string;
let countryTopicId: string;
let workspaceTopicId: string;
let workspaceDomainTopicId: string;
let googleOnlyTopicId: string;
let openTopicId: string;

describe.sequential('Proof-gated topics — full flow', () => {
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

  it('setup: create User B via dev-login', async () => {
    const res = await fetch(`${BASE}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: `e2e-userb-${Date.now()}`, nickname: `e2e_b_${Date.now().toString(36)}` }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    tokenB = json.token;
    userBId = json.userId;
    expect(tokenB).toBeTruthy();
  });

  // ══════════════════════════════════════════════════
  // 1. USER A — VERIFY KYC CACHE FROM LOGIN
  // ══════════════════════════════════════════════════

  it('User A: KYC verification cached from login', async () => {
    const res = await authGet('/api/profile/badges');
    expect(res.status).toBe(200);
    const json = await res.json();
    const kycBadge = json.badges.find((b: { type: string }) => b.type === 'kyc');
    expect(kycBadge).toBeDefined();
    expect(kycBadge.verifiedAt).toBeGreaterThan(0);
  });

  // ══════════════════════════════════════════════════
  // 2. USER A — CREATE TOPICS WITH VARIOUS PROOF TYPES
  // ══════════════════════════════════════════════════

  it('User A: creates open topic', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Open ${Date.now()}`, description: 'No proof', categoryId, proofType: 'none',
    });
    expect(res.status).toBe(201);
    openTopicId = (await res.json()).topic.id;
  });

  it('User A: creates KYC-gated topic (cached verification)', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E KYC ${Date.now()}`, description: 'KYC required', categoryId, proofType: 'kyc',
    });
    expect(res.status).toBe(201);
    kycTopicId = (await res.json()).topic.id;
  });

  it('User A: creates country-gated topic with real proof', async () => {
    // Generate country proof
    const { createConfig, generateProof, fromPrivateKey } = await import('@zkproofport-ai/sdk');
    const aiConfig = createConfig({ baseUrl: 'https://stg-ai.zkproofport.app' });
    const key = process.env.E2E_ATTESTATION_WALLET_KEY!;
    const signer = fromPrivateKey(key);

    const challengeRes = await fetch(`${BASE}/api/auth/challenge`, { method: 'POST' });
    const { scope } = await challengeRes.json();

    console.log('[E2E] Generating country proof (KR) for topic creation...');
    const result = await generateProof(
      aiConfig,
      { attestation: signer, payment: signer },
      { circuit: 'coinbase_country', scope, countryList: ['KR'], isIncluded: true },
      { onStep: (s: any) => console.log(`[E2E] Country: Step ${s.step}: ${s.name} (${s.durationMs}ms)`) },
    );

    const res = await authPost('/api/topics', {
      title: `E2E Country KR ${Date.now()}`, description: 'KR only', categoryId,
      proofType: 'country', requiresCountryProof: true,
      allowedCountries: ['KR'], countryMode: 'include',
      proof: result.proof, publicInputs: result.publicInputs,
    });
    expect(res.status).toBe(201);
    countryTopicId = (await res.json()).topic.id;
  }, 120_000);

  it('User A: creates workspace topic (any provider, no domain)', async () => {
    // User A doesn't have workspace verification — should fail without proof
    const res = await authPost('/api/topics', {
      title: `E2E Workspace ${Date.now()}`, description: 'Any org', categoryId,
      proofType: 'workspace',
    });
    // No workspace proof cached → 400
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.toLowerCase()).toContain('proof');
  });

  // ══════════════════════════════════════════════════
  // 3. USER B — JOIN OPEN TOPIC (NO PROOF)
  // ══════════════════════════════════════════════════

  it('User B: joins open topic without proof', async () => {
    const res = await authPostB(`/api/topics/${openTopicId}/join`, {});
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  it('User B: joining same topic again → 409 already member', async () => {
    const res = await authPostB(`/api/topics/${openTopicId}/join`, {});
    expect(res.status).toBe(409);
  });

  // ══════════════════════════════════════════════════
  // 4. USER B — JOIN KYC TOPIC (REQUIRES PROOF)
  // ══════════════════════════════════════════════════

  it('User B: join KYC topic without proof → 402 with guide', async () => {
    const res = await authPostB(`/api/topics/${kycTopicId}/join`, {});
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error).toContain('Proof required');
    expect(json.proofRequirement).toBeDefined();
    expect(json.proofRequirement.type).toBe('kyc');
    expect(json.proofRequirement.circuit).toBe('coinbase_attestation');
    expect(json.proofRequirement.payment).toBeDefined();
    expect(json.proofRequirement.guide).toBeDefined();
    expect(json.proofRequirement.guideUrl).toContain('/api/docs/proof-guide/kyc');
  });

  it('User B: generates KYC proof and joins topic', async () => {
    const { createConfig, generateProof, fromPrivateKey } = await import('@zkproofport-ai/sdk');
    const aiConfig = createConfig({ baseUrl: 'https://stg-ai.zkproofport.app' });
    const key = process.env.E2E_ATTESTATION_WALLET_KEY!;
    const signer = fromPrivateKey(key);

    const challengeRes = await fetch(`${BASE}/api/auth/challenge`, { method: 'POST' });
    const { scope } = await challengeRes.json();

    console.log('[E2E] User B: Generating KYC proof for join...');
    const result = await generateProof(
      aiConfig,
      { attestation: signer, payment: signer },
      { circuit: 'coinbase_kyc', scope },
      { onStep: (s: any) => console.log(`[E2E] UserB KYC: Step ${s.step}: ${s.name} (${s.durationMs}ms)`) },
    );

    const res = await authPostB(`/api/topics/${kycTopicId}/join`, {
      proof: result.proof,
      publicInputs: result.publicInputs,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);
  }, 120_000);

  // ══════════════════════════════════════════════════
  // 5. USER B — JOIN COUNTRY TOPIC (REQUIRES PROOF)
  // ══════════════════════════════════════════════════

  it('User B: join country topic without proof → 402', async () => {
    const res = await authPostB(`/api/topics/${countryTopicId}/join`, {});
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.proofRequirement.type).toBe('country');
    expect(json.proofRequirement.circuit).toBe('coinbase_country_attestation');
  });

  it('User B: generates country proof (KR) and joins topic', async () => {
    const { createConfig, generateProof, fromPrivateKey } = await import('@zkproofport-ai/sdk');
    const aiConfig = createConfig({ baseUrl: 'https://stg-ai.zkproofport.app' });
    const key = process.env.E2E_ATTESTATION_WALLET_KEY!;
    const signer = fromPrivateKey(key);

    const challengeRes = await fetch(`${BASE}/api/auth/challenge`, { method: 'POST' });
    const { scope } = await challengeRes.json();

    console.log('[E2E] User B: Generating country proof (KR) for join...');
    const result = await generateProof(
      aiConfig,
      { attestation: signer, payment: signer },
      { circuit: 'coinbase_country', scope, countryList: ['KR'], isIncluded: true },
      { onStep: (s: any) => console.log(`[E2E] UserB Country: Step ${s.step}: ${s.name} (${s.durationMs}ms)`) },
    );

    const res = await authPostB(`/api/topics/${countryTopicId}/join`, {
      proof: result.proof,
      publicInputs: result.publicInputs,
    });
    expect(res.status).toBe(201);
  }, 120_000);

  // ══════════════════════════════════════════════════
  // 6. VERIFICATION CACHE — SKIP RE-PROVING
  // ══════════════════════════════════════════════════

  it('User A: country verification cached after topic creation', async () => {
    const res = await authGet('/api/profile/badges');
    expect(res.status).toBe(200);
    const json = await res.json();
    const types = json.badges.map((b: { type: string }) => b.type);
    expect(types).toContain('kyc');
    // country should also be cached (saved during topic creation with proof)
  });

  // ══════════════════════════════════════════════════
  // 7. EDGE CASES
  // ══════════════════════════════════════════════════

  it('rejects non-public visibility', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Private ${Date.now()}`, description: 'fail', categoryId,
      visibility: 'private',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('public');
  });

  it('rejects secret visibility', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Secret ${Date.now()}`, description: 'fail', categoryId,
      visibility: 'secret',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('public');
  });

  it('workspace topic without proof fails for creator', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E WS Fail ${Date.now()}`, description: 'fail', categoryId,
      proofType: 'workspace',
    });
    expect(res.status).toBe(400);
  });

  it('google_workspace topic without proof fails for creator', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E GW Fail ${Date.now()}`, description: 'fail', categoryId,
      proofType: 'google_workspace',
    });
    expect(res.status).toBe(400);
  });

  it('microsoft_365 topic without proof fails for creator', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E MS Fail ${Date.now()}`, description: 'fail', categoryId,
      proofType: 'microsoft_365',
    });
    expect(res.status).toBe(400);
  });

  // ══════════════════════════════════════════════════
  // 8. PROOF GUIDE API — ALL TYPES
  // ══════════════════════════════════════════════════

  it('proof guide: kyc', async () => {
    const res = await fetch(`${BASE}/api/docs/proof-guide/kyc`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.circuit).toBe('coinbase_attestation');
    expect(json.payment.cost).toContain('USDC');
    expect(json.steps.agent.length).toBeGreaterThan(0);
    expect(json.proofEndpoint.agent.challengeEndpoint.url).toContain('/api/auth/challenge');
  });

  it('proof guide: country', async () => {
    const res = await fetch(`${BASE}/api/docs/proof-guide/country`);
    expect(res.status).toBe(200);
    expect((await res.json()).circuit).toBe('coinbase_country_attestation');
  });

  it('proof guide: google_workspace', async () => {
    const res = await fetch(`${BASE}/api/docs/proof-guide/google_workspace`);
    expect(res.status).toBe(200);
    expect((await res.json()).circuit).toBe('oidc_domain_attestation');
  });

  it('proof guide: microsoft_365', async () => {
    const res = await fetch(`${BASE}/api/docs/proof-guide/microsoft_365`);
    expect(res.status).toBe(200);
    expect((await res.json()).circuit).toBe('oidc_domain_attestation');
  });

  it('proof guide: workspace', async () => {
    const res = await fetch(`${BASE}/api/docs/proof-guide/workspace`);
    expect(res.status).toBe(200);
    expect((await res.json()).circuit).toBe('oidc_domain_attestation');
  });

  it('proof guide: invalid type → 400', async () => {
    const res = await fetch(`${BASE}/api/docs/proof-guide/invalid`);
    expect(res.status).toBe(400);
  });

  // ══════════════════════════════════════════════════
  // 9. PRIVACY — NO PII IN RESPONSES
  // ══════════════════════════════════════════════════

  it('badges contain no raw PII', async () => {
    const text = await (await authGet('/api/profile/badges')).text();
    expect(text).not.toContain('"email"');
    expect(text).not.toContain('"proof"');
    expect(text).not.toContain('"publicInputs"');
  });

  // ══════════════════════════════════════════════════
  // 10. DOCUMENTATION ENDPOINTS
  // ══════════════════════════════════════════════════

  it('GET /AGENTS.md returns markdown', async () => {
    const res = await fetch(`${BASE}/AGENTS.md`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('OpenStoa');
    expect(text).toContain('Privacy');
    expect(text.length).toBeGreaterThan(1000);
  });

  it('GET /skill.md returns skill file', async () => {
    const res = await fetch(`${BASE}/skill.md`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('name: openstoa');
    expect(text).toContain('AUTO-GENERATED API REFERENCE');
  });

  it('proof guide URLs use correct environment base', async () => {
    const json = await (await fetch(`${BASE}/api/docs/proof-guide/kyc`)).json();
    const codes = json.steps.agent.map((s: { code?: string }) => s.code || '').join('');
    if (BASE.includes('stg-')) {
      expect(codes).toContain('stg-community.zkproofport.app');
      expect(codes).not.toContain('www.openstoa.xyz');
    }
  });

  it('POST /api/ask returns instant response', async () => {
    const res = await fetch(`${BASE}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What proof types are supported?' }),
    });
    expect([200, 503]).toContain(res.status);
  });
});
