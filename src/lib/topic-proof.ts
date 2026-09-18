import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import {
  COMMUNITY_SCOPE, computeScopeHash, extractScope, extractCountryList,
  extractIsIncluded, extractDomain, verifyTrustedTopicProof,
} from './proof';
import { circuitToCacheType, getVerificationCache, saveVerificationCache } from './verification-cache';
import { buildProofRequirement } from './proof-guides';

// Login and topic credentials may use different identities. The proof commits
// to the requesting account through scope, never by equating their nullifiers.
export function topicProofScope(userId: string): string {
  return `${COMMUNITY_SCOPE}:topic:${userId}`;
}

const CIRCUITS: Record<string, string> = {
  kyc: 'coinbase_attestation',
  country: 'coinbase_country_attestation',
  workspace: 'oidc_domain_attestation',
  google_workspace: 'oidc_domain_attestation',
  microsoft_365: 'oidc_domain_attestation',
};
const INPUT_COUNTS: Record<string, number> = {
  coinbase_attestation: 128,
  coinbase_country_attestation: 150,
  oidc_domain_attestation: 148,
};
const REQUIRED_PROVIDERS: Record<string, number> = { google_workspace: 0, microsoft_365: 1 };

// This is a limited consumer-domain policy, not proof of subscription or
// employment. The circuit authenticates an email domain, not hidden hd/tid claims.
const CONSUMER_DOMAINS: Record<number, readonly string[]> = {
  0: ['gmail.com', 'googlemail.com'],
  1: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
};
function acceptsWorkspaceDomain(domain: string | undefined, provider: number | undefined): boolean {
  if (!domain || provider === undefined || !Object.hasOwn(CONSUMER_DOMAINS, provider)) return false;
  return !CONSUMER_DOMAINS[provider].includes(domain.toLowerCase());
}

export interface TopicProofRequirement {
  proofType?: string | null;
  requiresCountryProof?: boolean | null;
  requiredDomain?: string | null;
  allowedCountries?: string[] | null;
  countryMode?: string | null;
}

function countryPredicate(topic: TopicProofRequirement): string {
  if (!Array.isArray(topic.allowedCountries)
    || topic.allowedCountries.length < 1
    || topic.allowedCountries.length > 10
    || topic.allowedCountries.some(country => typeof country !== 'string' || !/^[A-Za-z]{2}$/.test(country))) {
    throw new Error('Invalid country predicate');
  }
  // The topic schema stores an inclusion list, not an exclusion mode.
  const mode = topic.countryMode ?? 'include';
  if (mode !== 'include') throw new Error('Invalid country mode');
  const countries = [...new Set(topic.allowedCountries.map(country => country.toUpperCase()))].sort();
  return createHash('sha256').update(JSON.stringify([mode, countries])).digest('hex');
}

/** Shared by creation, direct join, and invitation join. No caller metadata is trusted. */
export async function requireTopicProof(
  userId: string,
  topic: TopicProofRequirement,
  body: unknown,
): Promise<NextResponse | null> {
  const type = topic.proofType || (topic.requiresCountryProof ? 'country' : 'none');
  if (type === 'none') return null;
  const circuit = Object.hasOwn(CIRCUITS, type) ? CIRCUITS[type] : undefined;
  if (!circuit) {
    return NextResponse.json({ error: `Unsupported topic proof type: ${type}` }, { status: 400 });
  }

  const scope = topicProofScope(userId);
  const scopeHash = computeScopeHash(scope);
  const domain = topic.requiredDomain?.trim().toLowerCase();
  let predicate: string | undefined;
  try {
    if (type === 'country') predicate = countryPredicate(topic);
  } catch {
    return NextResponse.json({ error: 'Invalid country predicate' }, { status: 400 });
  }
  const expectedProvider = REQUIRED_PROVIDERS[type];
  const data = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown> : {};

  if (data.proof === undefined && data.publicInputs === undefined) {
    const record = await getVerificationCache(userId, type);
    if (record?.topicScope === scopeHash
      && (!predicate || record.countryPredicate === predicate)
      && (!domain || record.domain === domain)
      && (circuit !== 'oidc_domain_attestation' || acceptsWorkspaceDomain(record.domain, record.provider))
      && (expectedProvider === undefined || record.provider === expectedProvider)) {
      return null;
    }
    return NextResponse.json({
      error: 'Proof required to join this topic',
      proofScope: scope,
      proofRequirement: buildProofRequirement(type, {
        domain: topic.requiredDomain,
        allowedCountries: topic.allowedCountries,
      }),
    }, { status: 402 });
  }

  try {
    const { proof, publicInputs } = data;
    if (typeof proof !== 'string' || proof.length > 131074 || !/^0x(?:[0-9a-fA-F]{2})+$/.test(proof)) {
      throw new Error('Invalid proof');
    }
    const count = INPUT_COUNTS[circuit];
    let inputs: string[];
    if (typeof publicInputs === 'string' && new RegExp(`^0x[0-9a-fA-F]{${count * 64}}$`).test(publicInputs)) {
      inputs = publicInputs.slice(2).match(/.{64}/g)!.map(value => '0x' + value);
    } else if (Array.isArray(publicInputs) && publicInputs.length === count
      && publicInputs.every(value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value))) {
      inputs = publicInputs as string[];
    } else {
      throw new Error('Invalid public inputs');
    }
    if (extractScope(inputs, circuit) !== scopeHash) throw new Error('Proof scope mismatch');

    let verifiedDomain: string | undefined;
    let provider: number | undefined;
    if (type === 'country') {
      const actual = countryPredicate({
        allowedCountries: extractCountryList(inputs, circuit),
        countryMode: extractIsIncluded(inputs, circuit) ? 'include' : 'exclude',
      });
      if (actual !== predicate) throw new Error('Country predicate mismatch');
    }
    if (circuit === 'oidc_domain_attestation') {
      verifiedDomain = extractDomain(inputs, circuit)?.toLowerCase().trim();
      provider = Number(BigInt(inputs[147]));
      if (!acceptsWorkspaceDomain(verifiedDomain, provider)
        || (domain && domain !== verifiedDomain)
        || (expectedProvider !== undefined && expectedProvider !== provider)) {
        throw new Error('Workspace predicate mismatch');
      }
    }
    const verification = await verifyTrustedTopicProof(circuit, proof, inputs);
    if (!verification.valid) throw new Error('Proof verification failed');
    await saveVerificationCache(userId, circuitToCacheType(circuit), {
      domain: verifiedDomain, topicScope: scopeHash, countryPredicate: predicate, provider,
    });
    return null;
  } catch {
    return NextResponse.json({ error: 'Invalid or unverifiable topic proof', proofScope:scope, proofRequirement:buildProofRequirement(type,{domain:topic.requiredDomain,allowedCountries:topic.allowedCountries}) }, { status: 400 });
  }
}
