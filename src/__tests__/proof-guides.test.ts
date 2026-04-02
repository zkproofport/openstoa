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

  it('sets isIncluded=false when countryMode is "exclude"', () => {
    const result = buildProofRequirement('country', {
      allowedCountries: ['CN'],
      countryMode: 'exclude',
    });
    expect(result!.proofEndpoint.mobile.body).toMatchObject({
      countryList: ['CN'],
      isIncluded: false,
    });
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
