import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { buildProofRequirement as BuildProofRequirement, PROOF_GUIDES as ProofGuidesType } from '@/lib/proof-guides';

const REQUIRED_KEYS = ['kyc', 'country', 'google_workspace', 'microsoft_365', 'workspace'] as const;

describe('PROOF_GUIDES', () => {
  let PROOF_GUIDES: typeof ProofGuidesType;

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.APP_ENV;
    ({ PROOF_GUIDES } = await import('@/lib/proof-guides'));
  });

  it('has all expected keys', () => {
    for (const key of REQUIRED_KEYS) {
      expect(PROOF_GUIDES).toHaveProperty(key);
    }
  });

  it('uses the Coinbase circuit CLI arguments instead of Google login', () => {
    expect(PROOF_GUIDES.kyc.proofEndpoint.agent.proveCommand).toContain('coinbase_kyc');
    expect(PROOF_GUIDES.country.proofEndpoint.agent.proveCommand).toContain('coinbase_country --countries "$COUNTRIES" --included true');
    for (const key of ['kyc', 'country']) {
      const guide = PROOF_GUIDES[key];
      expect(JSON.stringify(guide)).not.toContain('--login-google');
      expect(guide.steps.agent.some(step => step.description.includes('ATTESTATION_KEY'))).toBe(true);
    }
  });

  it.each(REQUIRED_KEYS)('guide "%s" points to the current submission tool without promising an unavailable flow', key => {
    const guide = PROOF_GUIDES[key];
    expect(guide.mcp.preferredTool).toBe('openstoa_topic_join');
    expect(guide.mcp.exampleToolCall).toMatchObject({ name: 'openstoa_topic_join', arguments: { topicId: '<topic-uuid>' } });
    expect(typeof guide.mcp.exampleToolCall!.arguments.publicInputs).toBe('string');
    expect(guide.mcp).toMatchObject({workflow: {
      methods: ['app', 'ai'], requiresConsent: true,
      continueTool: 'openstoa_proof_continue', statusTool: 'openstoa_proof_status',
      resumeTool: 'openstoa_proof_resume', cancelTool: 'openstoa_proof_cancel',
      exampleContinueToolCall: {name: 'openstoa_proof_continue', arguments: {approved: true}},
    }});
    const workflow = Reflect.get(guide.mcp, 'workflow');
    expect(workflow.exampleContinueToolCall.arguments.operationId).toEqual(expect.any(String));
    expect(workflow.exampleContinueToolCall.arguments.method).toMatch(/^(app|ai)$/);
    const commands = workflow.cli.join('\n');
    for (const control of ['continue', 'status', 'resume', 'cancel']) expect(commands).toContain(`proof ${control}`);
    expect(commands).toContain('--approved');
    expect(commands).toContain('--wait');
    expect(guide.mcp.explanation).toMatch(/consent|approv/i);
    expect(guide.notes.join(' ')).toMatch(/availability|unavailable|not.*verified/i);
    expect(guide.notes.join(' ')).not.toMatch(/currently offline/i);
    expect(JSON.stringify(guide)).not.toMatch(/post_topics_topicId_join|join_topic_with_|verifies it on-chain/);
  });

  it.each(REQUIRED_KEYS)('guide "%s" supplies syntactically valid shell examples', key => {
    for (const step of PROOF_GUIDES[key].steps.agent) {
      if (!step.code) continue;
      // Parse only: do not execute a prover, request, wallet operation or network call.
      const parsed = spawnSync('bash', ['-n'], { input: step.code, encoding: 'utf8' });
      expect(parsed.stderr).toBe('');
      expect(parsed.status).toBe(0);
    }
    const submit = PROOF_GUIDES[key].steps.agent.find(step => step.title === 'Submit Proof to Join Topic')!;
    expect(submit.code).toContain("jq '{proof, publicInputs}'");
    expect(submit.code).toContain('Bearer $OPENSTOA_SESSION_TOKEN');
    expect(submit.code).toContain('X-OpenStoa-API-Key: $OPENSTOA_API_KEY');
  });

  it.each(REQUIRED_KEYS)('guide "%s" obtains account-bound scope with authentication', key => {
    const guide = PROOF_GUIDES[key];
    expect(guide.proofEndpoint.mobile.body).toMatchObject({ mode: 'proof' });
    expect(guide.proofEndpoint.mobile.body).not.toHaveProperty('scope');
    expect(guide.proofEndpoint.agent.challengeEndpoint.exampleResponse.scope).toBe('zkproofport-community:topic:<userId>');
    const challenge = guide.steps.agent.find(step => step.title === 'Get Challenge')!;
    expect(challenge.code).toContain('Bearer $OPENSTOA_SESSION_TOKEN');
    expect(challenge.code).toContain('X-OpenStoa-API-Key: $OPENSTOA_API_KEY');
  });

  it.each(REQUIRED_KEYS)('guide "%s" has all required fields', (key) => {
    const guide = PROOF_GUIDES[key];
    expect(guide.title).toBeTruthy();
    expect(guide.description).toBeTruthy();
    expect(guide.circuit).toBeTruthy();
    expect(Array.isArray(guide.steps.mobile)).toBe(true);
    expect(Array.isArray(guide.steps.agent)).toBe(true);
    expect(guide.proofEndpoint).toBeDefined();
    expect(Array.isArray(guide.notes)).toBe(true);
  });
});

describe('buildProofRequirement', () => {
  let buildProofRequirement: typeof BuildProofRequirement;

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.APP_ENV;
    ({ buildProofRequirement } = await import('@/lib/proof-guides'));
  });

  afterEach(() => {
    delete process.env.APP_ENV;
  });

  it('returns null for unknown proof type', () => {
    expect(buildProofRequirement('unknown_type')).toBeNull();
  });

  it('returns correct structure for "kyc"', () => {
    const result = buildProofRequirement('kyc');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('kyc');
    expect(result!.circuit).toBe('coinbase_attestation');
    expect(result!.domain).toBeNull();
    expect(result!.allowedCountries).toBeNull();
    expect(result!.guide.title).toBeTruthy();
    expect(result!.guideUrl).toBe('/api/docs/proof-guide/kyc');
    expect(result!.proofEndpoint).toBeDefined();
  });

  it('guideUrl uses the correct format for each proof type', () => {
    for (const key of REQUIRED_KEYS) {
      const result = buildProofRequirement(key);
      expect(result!.guideUrl).toBe(`/api/docs/proof-guide/${key}`);
    }
  });

  it('adds countryList and isIncluded=true to mobile body for "country" with allowedCountries', () => {
    const countries = ['US', 'KR', 'JP'];
    const result = buildProofRequirement('country', { allowedCountries: countries });
    expect(result!.proofEndpoint.mobile.body).toMatchObject({
      countryList: countries,
      isIncluded: true,
    });
  });

  it('refuses to describe unsupported country exclusion as an enforceable gate', () => {
    expect(buildProofRequirement('country', { allowedCountries: ['CN'], countryMode: 'exclude' })).toBeNull();
  });

  it('does not add country params when allowedCountries is not provided', () => {
    const result = buildProofRequirement('country');
    expect(result!.proofEndpoint.mobile.body).not.toHaveProperty('countryList');
    expect(result!.proofEndpoint.mobile.body).not.toHaveProperty('isIncluded');
  });

  it('adds domain to mobile body for "workspace" with domain option', () => {
    const result = buildProofRequirement('workspace', { domain: 'company.com' });
    expect(result!.proofEndpoint.mobile.body).toMatchObject({ domain: 'company.com' });
  });

  it('adds domain to mobile body for "google_workspace" with domain option', () => {
    const result = buildProofRequirement('google_workspace', { domain: 'acme.com' });
    expect(result!.proofEndpoint.mobile.body).toMatchObject({ domain: 'acme.com' });
  });

  it('adds domain to mobile body for "microsoft_365" with domain option', () => {
    const result = buildProofRequirement('microsoft_365', { domain: 'corp.com' });
    expect(result!.proofEndpoint.mobile.body).toMatchObject({ domain: 'corp.com' });
  });

  it('does not add domain to mobile body when domain is not provided', () => {
    const result = buildProofRequirement('workspace');
    expect(result!.proofEndpoint.mobile.body).not.toHaveProperty('domain');
  });

  it('uses localhost:3200 as BASE_URL when APP_ENV is unset', () => {
    const result = buildProofRequirement('kyc');
    expect(result!.proofEndpoint.agent.challengeEndpoint.url).toBe(
      'http://localhost:3200/api/auth/challenge',
    );
    expect(result!.proofEndpoint.agent.joinEndpoint.url).toBe(
      'http://localhost:3200/api/topics/{topicId}/join',
    );
  });
});
