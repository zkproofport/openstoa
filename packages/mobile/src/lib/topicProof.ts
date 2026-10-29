import type { HostApi, ProofInputs, ProofResult } from '@openstoa/miniapp-bridge';
import type { OpenStoaClient } from '../api/openstoaClient';

interface TopicProofRequirements {
  proofType?: string;
  allowedCountries?: string[] | null;
  requiredDomain?: string | null;
}

/** Request the authenticated account's scope; never substitute a topic ID or login scope. */
export async function generateTopicProof(
  client: OpenStoaClient,
  host: HostApi,
  topic: TopicProofRequirements,
  workspaceProvider?: 'google' | 'microsoft' | null,
): Promise<ProofResult | undefined> {
  if (!topic.proofType || topic.proofType === 'none') return undefined;
  const circuits: Record<string, ProofInputs['circuit']> = {
    kyc: 'coinbase_attestation',
    country: 'coinbase_country_attestation',
    google_workspace: 'oidc_domain_attestation',
    microsoft_365: 'oidc_domain_attestation',
    workspace: 'oidc_domain_attestation',
  };
  const circuit = Object.hasOwn(circuits, topic.proofType) ? circuits[topic.proofType] : undefined;
  if (!circuit) throw new Error(`Unknown proof type: ${topic.proofType}`);
  const inputs: Omit<ProofInputs, 'scope'> = { circuit };
  if (topic.proofType === 'country') {
    if (!topic.allowedCountries?.length) throw new Error('Country proof requires allowed countries');
    inputs.countryList = topic.allowedCountries;
    inputs.isIncluded = true;
  }
  if (circuit === 'oidc_domain_attestation') {
    // An absent domain permits any organization; the host obtains its domain
    // from the selected provider's organization account during proof generation.
    if (topic.requiredDomain?.trim()) inputs.domain = topic.requiredDomain.trim();
    if (topic.proofType === 'google_workspace') inputs.provider = 'google';
    else if (topic.proofType === 'microsoft_365') inputs.provider = 'microsoft';
    else {
      if (!workspaceProvider) throw new Error('Choose a workspace provider');
      inputs.provider = workspaceProvider;
    }
  }
  const challenge = await client.post<{ scope: string }>('/api/auth/challenge');
  if (!challenge.scope?.trim()) throw new Error('Missing topic proof scope');
  const result = await host.generateProof({ ...inputs, scope: challenge.scope });
  if (!result.proof || !Array.isArray(result.publicInputs) || result.publicInputs.length === 0) {
    throw new Error('Proof generation did not return a complete proof');
  }
  const signerVariant = checkedSignerVariant(result.signerVariant);
  return {
    proof: result.proof,
    publicInputs: result.publicInputs,
    ...(signerVariant !== undefined ? { signerVariant } : {}),
  };
}

/**
 * The circuit packages a host proof can come from (core's SIGNER_VARIANTS).
 * The server picks the verifier by this value, so an unknown one is refused
 * here rather than posted for it to judge against the wrong package.
 */
export const SIGNER_VARIANTS = ['standard', 'android', 'android_factory'] as const;
export type SignerVariant = (typeof SIGNER_VARIANTS)[number];

/** Absent means standard and stays absent; anything else must be a known variant. */
function checkedSignerVariant(value: unknown): SignerVariant | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (SIGNER_VARIANTS as readonly string[]).includes(value)) return value as SignerVariant;
  const shown = typeof value === 'string' ? JSON.stringify(value) : `of type ${value === null ? 'null' : typeof value}`;
  throw new Error(`Unknown signerVariant ${shown}. Known: ${SIGNER_VARIANTS.join(', ')}.`);
}
