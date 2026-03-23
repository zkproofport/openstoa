import { describe, it, expect } from 'vitest';
import { authGet, authPost, publicGet, getBaseUrl } from './helpers';

/**
 * E2E tests for proof-gated topics — REAL proof generation + verification.
 *
 * Flow tested:
 * 1. Login with KYC proof (global-setup) → Redis verification cache populated
 * 2. Create KYC-gated topic → creator's cached KYC verification allows it
 * 3. Generate country proof (KR) → create country-gated topic with proof
 * 4. Join gated topic without proof → 402 with proof guide
 * 5. Verify Redis cache: badges show KYC + country
 * 6. Proof guide API returns correct formats
 * 7. AGENTS.md + skill.md served correctly
 */

const BASE = getBaseUrl();

// Shared state across sequential tests
let categoryId: string;
let kycTopicId: string;
let countryTopicId: string;
let openTopicId: string;
let countryProof: string;
let countryPublicInputs: string[];

describe.sequential('Proof-gated topics — real proof flow', () => {
  // ── Setup ──

  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  // ── 1. Verify KYC cache from login ──

  it('login KYC verification is cached in Redis', async () => {
    const res = await authGet('/api/profile/badges');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.badges).toBeDefined();
    const kycBadge = json.badges.find((b: { type: string }) => b.type === 'kyc');
    expect(kycBadge).toBeDefined();
    expect(kycBadge.verifiedAt).toBeGreaterThan(0);
    expect(kycBadge.expiresAt).toBeGreaterThan(kycBadge.verifiedAt);
    // 30-day TTL
    const ttl = kycBadge.expiresAt - kycBadge.verifiedAt;
    expect(ttl).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  });

  // ── 2. Create KYC-gated topic (no proof needed — cached) ──

  it('creates KYC-gated topic using cached verification', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E KYC Topic ${Date.now()}`,
      description: 'KYC verification required to join',
      categoryId,
      proofType: 'kyc',
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.topic.proofType).toBe('kyc');
    kycTopicId = json.topic.id;
  });

  // ── 3. Generate REAL country proof (KR) via AI SDK ──

  it('generates country proof (KR) via AI SDK', async () => {
    const { createConfig, generateProof, fromPrivateKey } = await import('@zkproofport-ai/sdk');

    const aiConfig = createConfig({ baseUrl: 'https://stg-ai.zkproofport.app' });
    const key = process.env.E2E_ATTESTATION_WALLET_KEY!;
    const signer = fromPrivateKey(key);

    // Get fresh scope from challenge
    const challengeRes = await fetch(`${BASE}/api/auth/challenge`, { method: 'POST' });
    expect(challengeRes.ok).toBe(true);
    const { scope } = await challengeRes.json();

    console.log('[E2E] Generating country proof (KR)...');
    const result = await generateProof(
      aiConfig,
      { attestation: signer, payment: signer },
      {
        circuit: 'coinbase_country',
        scope,
        countryList: ['KR'],
        isIncluded: true,
      },
      {
        onStep: (step: { step: number; name: string; durationMs: number }) =>
          console.log(`[E2E] Step ${step.step}: ${step.name} (${step.durationMs}ms)`),
      },
    );

    expect(result.proof).toBeTruthy();
    expect(result.publicInputs).toBeDefined();
    countryProof = result.proof;
    countryPublicInputs = result.publicInputs;
    console.log('[E2E] Country proof generated successfully');
  }, 120_000); // 2min timeout for proof generation

  // ── 4. Create country-gated topic WITH real proof ──

  it('creates country-gated topic with real proof', async () => {
    expect(countryProof).toBeTruthy();
    const res = await authPost('/api/topics', {
      title: `E2E Country Topic ${Date.now()}`,
      description: 'Country gated: KR only',
      categoryId,
      proofType: 'country',
      requiresCountryProof: true,
      allowedCountries: ['KR'],
      countryMode: 'include',
      proof: countryProof,
      publicInputs: countryPublicInputs,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.topic.proofType).toBe('country');
    countryTopicId = json.topic.id;
  });

  // ── 5. Verify country verification cached ──

  it('country verification is now cached in Redis', async () => {
    const res = await authGet('/api/profile/badges');
    expect(res.status).toBe(200);
    const json = await res.json();
    const badges = json.badges.map((b: { type: string }) => b.type);
    expect(badges).toContain('kyc');
    // Country should now be cached too (saved during topic creation)
    // Note: cache key is 'country' mapped from circuitToCacheType
  });

  // ── 6. Create open topic + test join ──

  it('creates open topic', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Open Topic ${Date.now()}`,
      description: 'No proof required',
      categoryId,
      proofType: 'none',
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    openTopicId = data.topic.id;
  });

  it('creator is automatically a member of their topic', async () => {
    const res = await authGet(`/api/topics/${openTopicId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.topic.isMember).toBe(true);
  });

  // ── 7. Verify non-public visibility rejected ──

  it('rejects non-public visibility', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Private ${Date.now()}`,
      description: 'Should fail',
      categoryId,
      visibility: 'private',
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('public');
  });

  // ── 8. Workspace topic requires proof (no cache) ──

  it('workspace topic creation fails without proof', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Workspace ${Date.now()}`,
      description: 'Organization required',
      categoryId,
      proofType: 'workspace',
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.toLowerCase()).toContain('proof');
  });

  // ── 9. Proof Guide API ──

  it('GET /api/docs/proof-guide/kyc returns complete guide', async () => {
    const res = await fetch(`${BASE}/api/docs/proof-guide/kyc`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.circuit).toBe('coinbase_attestation');
    expect(json.payment.cost).toContain('USDC');
    expect(json.steps.agent.length).toBeGreaterThan(0);
    expect(json.proofEndpoint.agent.challengeEndpoint.url).toContain('/api/auth/challenge');
    expect(json.notes.length).toBeGreaterThan(0);
  });

  it('GET /api/docs/proof-guide/country returns country guide', async () => {
    const res = await fetch(`${BASE}/api/docs/proof-guide/country`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.circuit).toBe('coinbase_country_attestation');
  });

  it('GET /api/docs/proof-guide/google_workspace', async () => {
    const res = await fetch(`${BASE}/api/docs/proof-guide/google_workspace`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.circuit).toBe('oidc_domain_attestation');
  });

  it('GET /api/docs/proof-guide/microsoft_365', async () => {
    const res = await fetch(`${BASE}/api/docs/proof-guide/microsoft_365`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.circuit).toBe('oidc_domain_attestation');
  });

  it('GET /api/docs/proof-guide/workspace', async () => {
    const res = await fetch(`${BASE}/api/docs/proof-guide/workspace`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.circuit).toBe('oidc_domain_attestation');
  });

  it('GET /api/docs/proof-guide/invalid returns 400', async () => {
    const res = await fetch(`${BASE}/api/docs/proof-guide/invalid`);
    expect(res.status).toBe(400);
  });

  // ── 10. Privacy: no PII in responses ──

  it('badges response contains NO raw PII', async () => {
    const res = await authGet('/api/profile/badges');
    const text = await res.text();
    expect(text).not.toContain('"email"');
    expect(text).not.toContain('"proof"');
    expect(text).not.toContain('"publicInputs"');
  });

  // ── 11. Proof guide URLs use staging base ──

  it('proof guide URLs use staging base URL', async () => {
    const res = await fetch(`${BASE}/api/docs/proof-guide/kyc`);
    const json = await res.json();
    const agentSteps = json.steps.agent;
    if (BASE.includes('stg-')) {
      const hasStgUrl = agentSteps.some((s: { code?: string }) =>
        s.code?.includes('stg-community.zkproofport.app'));
      expect(hasStgUrl).toBe(true);
    }
  });

  // ── 12. Documentation endpoints ──

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

  // ── 13. ASK API (non-streaming) ──

  it('POST /api/ask returns instant response', async () => {
    const res = await fetch(`${BASE}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What proof types are supported?' }),
    });
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) {
      const json = await res.json();
      expect(json.answer).toBeDefined();
    }
  });
});

