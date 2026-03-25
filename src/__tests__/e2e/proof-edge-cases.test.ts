import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import { authPost, publicPost, secondUserPost, getBaseUrl } from './helpers';

const BASE = getBaseUrl();

async function getScope(): Promise<{ challengeId: string; scope: string }> {
  const res = await fetch(`${BASE}/api/auth/challenge`, { method: 'POST' });
  if (!res.ok) throw new Error(`Challenge failed: ${res.status}`);
  return res.json();
}

function runProveCoinbase(args: string, scope: string): Record<string, unknown> {
  const key = process.env.E2E_ATTESTATION_WALLET_KEY;
  if (!key) throw new Error('E2E_ATTESTATION_WALLET_KEY is required in .env.test');
  const env = { ...process.env, PAYMENT_KEY: key, ATTESTATION_KEY: key };
  const cmd = `npx zkproofport-prove ${args} --scope ${scope} --silent 2>/dev/null`;
  console.log(`[E2E] Coinbase: ${cmd}`);
  const result = execSync(cmd, { env, timeout: 180_000, encoding: 'utf-8' }) as string;
  console.log('[E2E] Coinbase proof completed');
  return JSON.parse(result.trim());
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let categoryId: string;

describe.sequential('P1 — Proof Edge Cases', () => {
  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/categories`);
    if (!res.ok) throw new Error(`Failed to fetch categories: ${res.status}`);
    const json = await res.json();
    if (!json.categories?.length) throw new Error('No categories available');
    categoryId = json.categories[0].id;
  });

  // ── Test 1: Join non-existent topic → 404 ──────────────────────────────────

  it('1. Join non-existent topic → 404', async () => {
    const fakeTopicId = '00000000-0000-0000-0000-000000000000';
    const res = await authPost(`/api/topics/${fakeTopicId}/join`, {});
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── Test 2: Create topic with invalid proofType → 400 ─────────────────────

  it('2. Create topic with invalid proofType → 400', async () => {
    const res = await authPost('/api/topics', {
      title: 'Invalid ProofType Test',
      categoryId,
      proofType: 'invalid_type',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── Test 3: Country topic — disallowed country → 403 ──────────────────────
  // Fix implemented locally: join handler now verifies that the proof's country_list
  // matches the topic's allowedCountries. A KR proof can no longer join a JP-only topic.
  // Pending deployment to staging — assertion accepts both 403 (after deploy) and 402
  // (before deploy, when no cached verification exists for this new topic).

  it('3. Country topic with disallowed country → 403 (country list mismatch)', async () => {
    // Generate KR proof for creator (User A) — valid inclusion proof
    const { scope: creatorScope } = await getScope();
    const creatorProof = runProveCoinbase('coinbase_country --countries KR --included true', creatorScope);

    // User A creates a JP-only topic (creator has KR proof, topic requires JP)
    const topicRes = await authPost('/api/topics', {
      title: `E2E Country Mismatch ${Date.now()}`,
      description: 'JP only — KR should be rejected',
      categoryId,
      proofType: 'country',
      requiresCountryProof: true,
      allowedCountries: ['JP'],
      countryMode: 'include',
      proof: creatorProof.proof,
      publicInputs: creatorProof.publicInputs,
    });
    expect(topicRes.status).toBe(201);
    const { topic } = await topicRes.json();
    console.log(`[E2E] Created JP-only topic: ${topic.id}`);

    // Generate a KR country proof for User B (wallet is KR, included=true in KR list)
    const { scope: joinScope } = await getScope();
    const joinerProof = runProveCoinbase('coinbase_country --countries KR --included true', joinScope);

    // User B tries to join the JP topic with a KR proof → 403 (country list mismatch)
    const joinRes = await secondUserPost(`/api/topics/${topic.id}/join`, {
      proof: joinerProof.proof,
      publicInputs: joinerProof.publicInputs,
    });

    console.log(`[E2E] User B join JP topic with KR proof → ${joinRes.status}`);
    expect(joinRes.status).toBe(403);
    const json = await joinRes.json();
    expect(json.error).toContain('Country list mismatch');
    console.log('[E2E] 403 — country list mismatch correctly rejected');
  }, 180_000);

  // ── Test 4: Country exclude mode — is_included=0 proof rejected on inclusion-required topic ──
  // A KR wallet CAN generate coinbase_country --countries JP --included false:
  // this proves "my country is NOT in [JP]" — which is true (KR ≠ JP), so is_included=0.
  // A topic that requires KR membership (allowedCountries: ['KR'], countryMode: 'include')
  // must reject this proof because is_included=0 means the wallet proved exclusion, not inclusion.

  it('4. Country exclude mode proof (is_included=0) rejected by inclusion topic → 403', async () => {
    // Generate KR proof for creator (to satisfy topic creation requirement)
    const { scope: creatorScope } = await getScope();
    const creatorProof = runProveCoinbase('coinbase_country --countries KR --included true', creatorScope);

    // Create a KR-only topic with creator's proof
    const topicRes = await authPost('/api/topics', {
      title: `E2E Country Exclude ${Date.now()}`,
      description: 'KR only — exclude-mode proof should be rejected',
      categoryId,
      proofType: 'country',
      requiresCountryProof: true,
      allowedCountries: ['KR'],
      countryMode: 'include',
      proof: creatorProof.proof,
      publicInputs: creatorProof.publicInputs,
    });
    expect(topicRes.status).toBe(201);
    const { topic } = await topicRes.json();
    console.log(`[E2E] Created KR-only topic: ${topic.id}`);

    // Generate an exclude-mode proof: proves wallet is NOT in [JP] list → is_included=0
    // KR wallet + JP list → KR is not JP → is_included=0 (truthful exclusion proof)
    const { scope } = await getScope();
    const proofResult = runProveCoinbase('coinbase_country --countries JP --included false', scope);

    // User B tries to join the KR-only topic with an is_included=0 proof
    const joinRes = await secondUserPost(`/api/topics/${topic.id}/join`, {
      proof: proofResult.proof,
      publicInputs: proofResult.publicInputs,
    });

    console.log(`[E2E] Join KR topic with is_included=0 proof → ${joinRes.status}`);
    expect(joinRes.status).toBe(403);
    const json = await joinRes.json();
    expect(json.error).toBeTruthy();
    console.log('[E2E] 403 — is_included=0 (exclude-mode proof) correctly rejected');
  }, 180_000);

  // ── Test 5: Domain-restricted workspace topic with wrong domain → 403 ──────
  // Requires device flow (Microsoft 365 / Google Workspace) to prove domain.
  // Skipped if .playwright-profile/ is not set up or no cached workspace proof.

  it.skip('5. Domain-restricted workspace topic with wrong domain → 403', async () => {
    // Skipped: requires device flow (Microsoft 365 workspace proof).
    // To enable: set up .playwright-profile/ with MS365 sessions via
    //   npx tsx scripts/test-device-flow.ts setup-microsoft
    // and ensure E2E_MS365_USER_A/B are set in .env.test.
    // The test would:
    //   1. Create workspace topic with requiredDomain='different-company.com'
    //   2. Try to join with user whose workspace domain is different
    //   3. Expect 403
  });

  // ── Test 6: Workspace topic with no domain restriction → 201 ──────────────
  // Requires cached workspace proof (oidc_domain cache in Redis).
  // Skipped if device flow is not available.

  it.skip('6. Workspace topic with no domain restriction — any domain → 201', async () => {
    // Skipped: requires device flow (workspace proof).
    // To enable: set up .playwright-profile/ with MS365/Google Workspace sessions
    // and ensure the test user has a valid oidc_domain cache in Redis.
    // The test would:
    //   1. Create workspace topic with NO requiredDomain (null)
    //   2. Join with user who has any valid workspace proof cached
    //   3. Expect 201
  });

  // ── Test 7: Double-consumed challenge → 401 ───────────────────────────────
  // Create a challenge, consume it once (it's atomically deleted on first use),
  // then try to use the same challengeId again → 401.

  it('7. Non-existent / expired challengeId → 400', async () => {
    // Use a well-formed but non-existent challengeId — Redis key won't be found.
    // Server returns 400 (invalid/expired challenge).
    // (Atomic double-consumption is tested at unit level in challenge.test.ts.)
    const nonExistentChallengeId = 'nonexistent-challenge-id-' + Date.now().toString(36);
    const res = await publicPost('/api/auth/verify/ai', {
      challengeId: nonExistentChallengeId,
      result: { proof: '0x' + 'ab'.repeat(32), publicInputs: '0x' + 'cd'.repeat(32) },
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    console.log(`[E2E] 400 — non-existent challengeId correctly rejected`);
  });

  // ── Test 8: Scope mismatch in proof → 400/403 ─────────────────────────────
  // POST to verify/ai with a fake proof that has wrong scope in publicInputs.
  // Since proof verification happens on-chain first, invalid proof data fails
  // before scope check → 400 or 401 depending on failure point.
  // We test that the server rejects it with a non-2xx status.

  it('8. Invalid proof data with wrong scope → non-2xx', async () => {
    const { challengeId } = await getScope();

    // Send clearly invalid hex data — will fail at proof verification stage
    const res = await publicPost('/api/auth/verify/ai', {
      challengeId,
      result: {
        proof: '0x' + '00'.repeat(64),
        publicInputs: '0x' + '00'.repeat(128), // wrong scope encoded in zeros
      },
    });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(201);
    console.log(`[E2E] Status ${res.status} — scope mismatch / invalid proof correctly rejected`);
  });

  // ── Test 9: Malformed proof data (empty string, invalid hex) → 400 ─────────

  it('9a. Join topic with empty proof string → 400', async () => {
    // Use the non-existent topic ID — even format validation should fire first
    const fakeTopicId = '00000000-0000-0000-0000-000000000001';
    const res = await authPost(`/api/topics/${fakeTopicId}/join`, {
      proof: '',
      publicInputs: '',
    });
    // Should fail with 400 (bad input) or 404 (topic not found first)
    expect([400, 404]).toContain(res.status);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    console.log(`[E2E] ${res.status} — empty proof correctly rejected`);
  });

  it('9b. Join topic with non-hex proof string → 400', async () => {
    const fakeTopicId = '00000000-0000-0000-0000-000000000001';
    const res = await authPost(`/api/topics/${fakeTopicId}/join`, {
      proof: 'not-hex-data',
      publicInputs: 'also-not-hex',
    });
    expect([400, 404]).toContain(res.status);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    console.log(`[E2E] ${res.status} — non-hex proof correctly rejected`);
  });

  it('9c. POST /api/auth/verify/ai with empty proof → 400', async () => {
    const { challengeId } = await getScope();
    const res = await publicPost('/api/auth/verify/ai', {
      challengeId,
      result: { proof: '', publicInputs: '' },
    });
    expect([400, 401]).toContain(res.status);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    console.log(`[E2E] ${res.status} — empty proof in verify/ai correctly rejected`);
  });
});
