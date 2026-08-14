import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSDKInstance = vi.hoisted(() => ({
  createRelayRequest: vi.fn().mockResolvedValue({ requestId: 'req-123', deepLink: 'zkproofport://test' }),
  pollResult: vi.fn().mockResolvedValue({ status: 'completed', proof: '0x...' }),
  setSigner: vi.fn(),
}));

vi.mock('@zkproofport-app/sdk', () => {
  const SDK = vi.fn().mockImplementation(() => mockSDKInstance);
  (SDK as any).create = vi.fn().mockImplementation(() => mockSDKInstance);
  return { ProofportSDK: SDK };
});

vi.mock('ethers', () => ({
  ethers: { Wallet: { createRandom: vi.fn().mockReturnValue({}) } },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockSDKInstance.createRelayRequest.mockResolvedValue({ requestId: 'req-123', deepLink: 'zkproofport://test' });
  mockSDKInstance.pollResult.mockResolvedValue({ status: 'completed', proof: '0x...' });
  delete process.env.RELAY_URL;
  vi.resetModules();
});

describe('createRelayProofRequest', () => {
  it('returns requestId and deepLink', async () => {
    const { createRelayProofRequest } = await import('@/lib/relay');

    const result = await createRelayProofRequest('zkproofport-community');

    expect(result.requestId).toBe('req-123');
    expect(result.deepLink).toBe('zkproofport://test');
  });

  it('uses ProofportSDK constructor with RELAY_URL when set', async () => {
    process.env.RELAY_URL = 'http://relay:4001';
    vi.resetModules();

    const { ProofportSDK } = await import('@zkproofport-app/sdk');
    const { createRelayProofRequest } = await import('@/lib/relay');

    await createRelayProofRequest('zkproofport-community');

    expect(ProofportSDK).toHaveBeenCalledWith({ relayUrl: 'http://relay:4001' });
    expect((ProofportSDK as any).create).not.toHaveBeenCalled();
  });

  it('uses ProofportSDK.create() when RELAY_URL is not set', async () => {
    vi.resetModules();

    const { ProofportSDK } = await import('@zkproofport-app/sdk');
    const { createRelayProofRequest } = await import('@/lib/relay');

    await createRelayProofRequest('zkproofport-community');

    expect((ProofportSDK as any).create).toHaveBeenCalled();
    expect(ProofportSDK).not.toHaveBeenCalledWith(expect.objectContaining({ relayUrl: expect.anything() }));
  });

  it('passes countryList for coinbase_country_attestation circuit', async () => {
    const { createRelayProofRequest } = await import('@/lib/relay');

    await createRelayProofRequest('zkproofport-community', {
      circuitType: 'coinbase_country_attestation',
      countryList: ['US', 'KR'],
      isIncluded: true,
    });

    const [, inputs] = mockSDKInstance.createRelayRequest.mock.calls[0];
    expect(inputs.countryList).toEqual(['US', 'KR']);
    expect(inputs.isIncluded).toBe(true);
  });

  it('passes domain and provider for oidc_domain_attestation circuit', async () => {
    const { createRelayProofRequest } = await import('@/lib/relay');

    await createRelayProofRequest('zkproofport-community', {
      circuitType: 'oidc_domain_attestation',
      domain: 'company.com',
      provider: 'google',
    });

    const [, inputs] = mockSDKInstance.createRelayRequest.mock.calls[0];
    expect(inputs.domain).toBe('company.com');
    expect(inputs.provider).toBe('google');
  });
});

describe('pollProofResult', () => {
  it('returns the result from SDK pollResult', async () => {
    const { pollProofResult } = await import('@/lib/relay');

    const result = await pollProofResult('req-123');

    expect(mockSDKInstance.pollResult).toHaveBeenCalledWith('req-123');
    expect(result).toMatchObject({ status: 'completed', proof: '0x...' });
  });

  /**
   * The typed-error wrapper closing the auth/poll route's residual leak:
   * the SDK's ONLY signal for "the relay genuinely has no record of this
   * request" is throwing the exact literal 'Request not found or expired'
   * (verified against the installed package). Everything else the SDK
   * throws carries the relay's own (potentially arbitrary) response text.
   */
  it('converts the SDK\'s exact "not found or expired" message into RelayRequestNotFoundError', async () => {
    mockSDKInstance.pollResult.mockRejectedValue(new Error('Request not found or expired'));
    const { pollProofResult, RelayRequestNotFoundError } = await import('@/lib/relay');

    await expect(pollProofResult('gone-123')).rejects.toBeInstanceOf(RelayRequestNotFoundError);
  });

  it('does NOT convert a message that merely CONTAINS "not found" — only an exact match qualifies', async () => {
    // Regression guard for the bug this replaces: a substring test would have
    // wrongly classified this as "not found" and (worse) echoed the whole
    // upstream-controlled text to the client.
    mockSDKInstance.pollResult.mockRejectedValue(
      new Error('upstream service https://internal-relay-7.corp:9443/health not found, connection refused'),
    );
    const { pollProofResult, RelayRequestNotFoundError } = await import('@/lib/relay');

    await expect(pollProofResult('req-x')).rejects.not.toBeInstanceOf(RelayRequestNotFoundError);
  });

  it('does NOT convert a message that merely CONTAINS "expired" — only an exact match qualifies', async () => {
    mockSDKInstance.pollResult.mockRejectedValue(new Error('TLS certificate for relay.internal expired 2026-01-01'));
    const { pollProofResult, RelayRequestNotFoundError } = await import('@/lib/relay');

    await expect(pollProofResult('req-y')).rejects.not.toBeInstanceOf(RelayRequestNotFoundError);
  });

  it('passes through any other error unchanged — no message rewriting, no swallowing', async () => {
    const original = new Error('relay says: db pool exhausted at proofport-relay/src/index.ts:88');
    mockSDKInstance.pollResult.mockRejectedValue(original);
    const { pollProofResult } = await import('@/lib/relay');

    await expect(pollProofResult('req-z')).rejects.toBe(original);
  });

  it('passes through a non-Error thrown value unchanged', async () => {
    mockSDKInstance.pollResult.mockRejectedValue('a raw string throw');
    const { pollProofResult } = await import('@/lib/relay');

    await expect(pollProofResult('req-w')).rejects.toBe('a raw string throw');
  });
});
