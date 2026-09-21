/**
 * Static proof guide content for each proof type.
 * Used in 402 responses and /api/docs/proof-guide/{proofType} endpoint.
 *
 * These guides must be detailed enough for an AI agent to generate a proof
 * using the published CLI interfaces. Remote proving availability is stated explicitly.
 */

export interface ProofGuideStep {
  step: number;
  title: string;
  description: string;
  code?: string;
}

export interface ProofEndpoint {
  mobile: {
    method: string;
    url: string;
    body: Record<string, unknown>;
    description: string;
  };
  agent: {
    challengeEndpoint: {
      method: string;
      url: string;
      description: string;
      exampleResponse: Record<string, unknown>;
    };
    proveCommand: string;
    joinEndpoint: {
      method: string;
      url: string;
      description: string;
      exampleBody: Record<string, unknown>;
    };
  };
}

export interface ProofMcpGuidance {
  /** Entry tool for a join; missing proof returns the saved workflow below. */
  preferredTool: string | null;
  workflow: {
    methods: readonly string[];
    requiresConsent: boolean;
    continueTool: string;
    statusTool: string;
    resumeTool: string;
    cancelTool: string;
    exampleContinueToolCall: { name: string; arguments: Record<string, unknown> };
    cli: readonly string[];
  };
  /**
   * Short explanation of how the MCP tool works, or (when preferredTool is null)
   * which proof-generation prerequisites remain outside OpenStoa.
   */
  explanation: string;
  /** Concrete example JSON-RPC tool call the agent should issue. */
  exampleToolCall?: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ProofGuide {
  title: string;
  description: string;
  circuit: string;
  /**
   * How MCP-connected agents should handle this proof type. Read this BEFORE
   * falling back to the CLI steps below.
   */
  mcp: ProofMcpGuidance;
  steps: {
    mobile: ProofGuideStep[];
    agent: ProofGuideStep[];
  };
  proofEndpoint: ProofEndpoint;
  notes: string[];
}

function getBaseUrl(): string {
  if (process.env.APP_ENV === 'production') return 'https://www.openstoa.xyz';
  if (process.env.APP_ENV === 'staging') return 'https://stg-community.zkproofport.app';
  return 'http://localhost:3200';
}

const BASE_URL = getBaseUrl();
const TOPIC_SCOPE_EXAMPLE = 'zkproofport-community:topic:<userId>';

function makeProofEndpoint(
  circuitType: string,
  proveFlag: string,
  extraBody?: Record<string, unknown>,
): ProofEndpoint {
  return {
    mobile: {
      method: 'POST',
      url: '/api/auth/proof-request',
      body: {
        circuitType,
        mode: 'proof',
        ...extraBody,
      },
      description: 'Create an authenticated proof-only relay request. The server binds the scope to your account. Scan the QR code with ZKProofport mobile app.',
    },
    agent: {
      challengeEndpoint: {
        method: 'POST',
        url: `${BASE_URL}/api/auth/challenge`,
        description: 'Authenticate with your existing OpenStoa API key to obtain the account-bound topic scope. Topic join submits proof and publicInputs, not challengeId; this request does not log you in.',
        exampleResponse: {
          challengeId: 'abc123-uuid',
          scope: TOPIC_SCOPE_EXAMPLE,
          expiresIn: 300,
        },
      },
      proveCommand: `zkproofport-prove ${proveFlag} --scope $SCOPE --silent`,
      joinEndpoint: {
        method: 'POST',
        url: `${BASE_URL}/api/topics/{topicId}/join`,
        description: 'Submit the generated proof and publicInputs to join the topic. Extract proof and publicInputs from the CLI output.',
        exampleBody: {
          proof: '0x28a3c1...',
          publicInputs: ['0x00000001...', '0x00000002...'],
        },
      },
    },
  };
}

const PROVER_AVAILABILITY = 'AI proof generation depends on external prover and identity-provider availability and current payment terms. Ask for consent before starting; app mode provides a human-approved QR/deep-link alternative. An API key does not replace a topic proof. These instructions describe the repository build; check installed CLI/MCP versions. Successful cryptographic E2E for every provider has not been established by local workflow tests.';

function proofSubmissionGuidance(prerequisites: string): ProofMcpGuidance {
  return {
    preferredTool: 'openstoa_topic_join',
    workflow: {
      methods: ['app', 'ai'], requiresConsent: true,
      continueTool: 'openstoa_proof_continue', statusTool: 'openstoa_proof_status',
      resumeTool: 'openstoa_proof_resume', cancelTool: 'openstoa_proof_cancel',
      exampleContinueToolCall: { name: 'openstoa_proof_continue', arguments: { operationId: '<operationId>', method: 'app', approved: true } },
      cli: [
        'openstoa topics join <topicId>',
        'openstoa proof continue <operationId> --approved --method app',
        'openstoa proof continue <operationId> --approved --method ai --wait',
        'openstoa proof status <operationId>',
        'openstoa proof resume <operationId> --wait',
        'openstoa proof cancel <operationId>',
      ],
    },
    explanation: `${prerequisites} Start the original create/join/invite action using your login session and owner-issued permission key. A missing or invalid proof returns proof_required and operationId. Obtain explicit user consent, then use openstoa_proof_continue with app or ai; use provider google/microsoft for domain proofs, not Coinbase proofs. App mode returns browserUrl for QR/deep-link approval; AI domain proving provides a device verification URL/code. Poll openstoa_proof_status, then call openstoa_proof_resume when proof_ready. Cancel with openstoa_proof_cancel. Keep the same credential/server/vault; operation expiry is 15 minutes. Never resubmit an uncertain action automatically. The raw-proof example below remains available: use concatenated hex publicInputs for MCP; REST also accepts field arrays. Private/secret topics still require an invite. Topic proving does not issue a login session or API key.`,
    exampleToolCall: {
      name: 'openstoa_topic_join',
      arguments: { topicId: '<topic-uuid>', proof: '<proof-hex>', publicInputs: '<concatenated-public-inputs-hex>' },
    },
  };
}

export const PROOF_GUIDES: Record<string, ProofGuide> = {
  kyc: {
    title: 'Coinbase KYC Verification',
    description: 'Prove that a wallet holds a Coinbase identity-verification attestation without sending identity documents to OpenStoa. Requires a Coinbase account with completed KYC and an EAS attestation on Base.',
    circuit: 'coinbase_attestation',
    mcp: proofSubmissionGuidance('Coinbase KYC needs an EAS-attested wallet. AI mode needs ATTESTATION_KEY in the local prover environment; app mode uses the wallet in the phone app and does not require sharing its key. Never send a private key to OpenStoa.'),
    steps: {
      mobile: [
        {
          step: 1,
          title: 'Open ZKProofport App',
          description: 'Open the ZKProofport mobile app. Android is available on Google Play without a beta signup: https://play.google.com/store/apps/details?id=com.masselabs.zkproofport. iOS has not been released yet; request availability information on the OpenStoa home page.',
        },
        {
          step: 2,
          title: 'Scan QR Code',
          description: 'Scan the QR code displayed on the topic join page. The app will connect to the relay server.',
        },
        {
          step: 3,
          title: 'Generate Proof',
          description: 'The app generates a zero-knowledge proof of your Coinbase KYC status on-device using mopro. This takes a few seconds.',
        },
      ],
      agent: [
        {
          step: 0,
          title: 'Install / Update CLI',
          description: 'Install the ZKProofport prove CLI globally (@zkproofport-ai/mcp) — the device-flow prover for topic proofs, NOT the OpenStoa MCP/CLI (@masselabs/openstoa-mcp | @masselabs/openstoa-cli) used for community integration. This provides the zkproofport-prove command.',
          code: 'npm install -g @zkproofport-ai/mcp@latest',
        },
        {
          step: 1,
          title: 'Get Challenge',
          description: 'Use your login session and API key on the challenge request and use its account-bound scope exactly. Do not use the login scope or topic ID. Topic join does not submit challengeId.',
          code: `CHALLENGE=$(curl -s -X POST "${BASE_URL}/api/auth/challenge" \\
  -H "Authorization: Bearer $OPENSTOA_SESSION_TOKEN" -H "X-OpenStoa-API-Key: $OPENSTOA_API_KEY" -H "Content-Type: application/json")
SCOPE=$(echo $CHALLENGE | jq -r '.scope')`,
        },
        {
          step: 2,
          title: 'Generate Proof',
          description: 'Configure ATTESTATION_KEY locally for the wallet that holds the Coinbase EAS attestation, then select coinbase_kyc. This is not a browser-login command. The --silent flag outputs only JSON. External prover availability and payment terms must be checked before use; app mode is also supported.',
          code: `PROOF_RESULT=$(zkproofport-prove coinbase_kyc --scope "$SCOPE" --silent)`,
        },
        {
          step: 3,
          title: 'Submit Proof to Join Topic',
          description: 'Extract proof and publicInputs from the CLI output and submit to the topic join endpoint.',
          code: `printf '%s' "$PROOF_RESULT" | jq '{proof, publicInputs}' | \\
curl --fail-with-body -sS -X POST "${BASE_URL}/api/topics/{topicId}/join" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $OPENSTOA_SESSION_TOKEN" -H "X-OpenStoa-API-Key: $OPENSTOA_API_KEY" \\
  --data-binary @-`,
        },
      ],
    },
    proofEndpoint: makeProofEndpoint('coinbase_attestation', 'coinbase_kyc'),
    notes: [
      PROVER_AVAILABILITY,
      'Requires a Coinbase account with completed KYC verification.',
      'The proof only reveals that KYC is complete — no personal data is exposed.',
      'The mobile relay polling path checks proofs on-chain before returning them; generating or submitting proof bytes does not itself establish verification.',
    ],
  },

  country: {
    title: 'Coinbase Country Attestation',
    description: 'Prove your country of residence via Coinbase EAS attestation without revealing your identity. The topic owner may restrict the allowed countries.',
    circuit: 'coinbase_country_attestation',
    mcp: proofSubmissionGuidance('Country proving requires an EAS-attested wallet and the exact topic country list. AI mode uses ATTESTATION_KEY in the local prover environment; app mode uses the phone wallet without sharing its key.'),
    steps: {
      mobile: [
        {
          step: 1,
          title: 'Open ZKProofport App',
          description: 'Open the ZKProofport mobile app on your device.',
        },
        {
          step: 2,
          title: 'Scan QR Code',
          description: 'Scan the QR code on the topic join page. The app receives the allowed country list and generates an inclusion proof.',
        },
        {
          step: 3,
          title: 'Generate Country Proof',
          description: 'The app verifies your country of residence via Coinbase EAS attestation and generates a ZK proof that your country matches the topic requirements.',
        },
      ],
      agent: [
        {
          step: 0,
          title: 'Install / Update CLI',
          description: 'Install the ZKProofport prove CLI globally (@zkproofport-ai/mcp) — the device-flow prover for topic proofs, NOT the OpenStoa MCP/CLI (@masselabs/openstoa-mcp | @masselabs/openstoa-cli) used for community integration.',
          code: 'npm install -g @zkproofport-ai/mcp@latest',
        },
        {
          step: 1,
          title: 'Get Challenge',
          description: 'Use your login session and API key on the challenge request to get the account-bound topic scope. This does not log you in; topic join does not submit challengeId.',
          code: `CHALLENGE=$(curl -s -X POST "${BASE_URL}/api/auth/challenge" \\
  -H "Authorization: Bearer $OPENSTOA_SESSION_TOKEN" -H "X-OpenStoa-API-Key: $OPENSTOA_API_KEY" -H "Content-Type: application/json")
SCOPE=$(echo $CHALLENGE | jq -r '.scope')`,
        },
        {
          step: 2,
          title: 'Generate Country Proof',
          description: 'Configure ATTESTATION_KEY locally for the EAS-attested wallet. Set COUNTRIES to the exact comma-separated allowedCountries returned by the topic, such as KR,US. The join API uses inclusion proofs (--included true). External prover availability and payment terms must be checked before use; app mode is also supported.',
          code: `PROOF_RESULT=$(zkproofport-prove coinbase_country --countries "$COUNTRIES" --included true --scope "$SCOPE" --silent)`,
        },
        {
          step: 3,
          title: 'Submit Proof to Join Topic',
          description: 'Extract proof and publicInputs from the CLI output and submit to the topic join endpoint. The request must contain the exact country list required by the topic.',
          code: `printf '%s' "$PROOF_RESULT" | jq '{proof, publicInputs}' | \\
curl --fail-with-body -sS -X POST "${BASE_URL}/api/topics/{topicId}/join" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $OPENSTOA_SESSION_TOKEN" -H "X-OpenStoa-API-Key: $OPENSTOA_API_KEY" \\
  --data-binary @-`,
        },
      ],
    },
    proofEndpoint: makeProofEndpoint('coinbase_country_attestation', 'coinbase_country --countries "$COUNTRIES" --included true'),
    notes: [
      PROVER_AVAILABILITY,
      'Requires a Coinbase account with country attestation on Base (EAS).',
      'The proof reveals only whether your country is in/not in the allowed list — not which country you are in.',
      'The topic owner defines the allowed country list (ISO 3166-1 alpha-2 codes); direct topic join requires an inclusion proof.',
    ],
  },

  google_workspace: {
    title: 'Google Workspace Domain Verification',
    description: 'Prove the email domain associated with your Google account without revealing the full email address. The circuit does not prove employment, directory membership, or a Workspace subscription.',
    circuit: 'oidc_domain_attestation',
    mcp: proofSubmissionGuidance('Generate an OIDC domain proof for a Google Workspace account before submission.'),
    steps: {
      mobile: [
        {
          step: 1,
          title: 'Open ZKProofport App',
          description: 'Open the ZKProofport mobile app on your device.',
        },
        {
          step: 2,
          title: 'Scan QR Code',
          description: 'Scan the QR code on the topic join page.',
        },
        {
          step: 3,
          title: 'Sign in with Google Workspace',
          description: 'The app redirects you to Google sign-in. Sign in with your Google Workspace account (e.g., you@company.com). A ZK proof is generated from your OIDC token proving your email domain without revealing your full email.',
        },
      ],
      agent: [
        {
          step: 0,
          title: 'Install / Update CLI',
          description: 'Install the ZKProofport prove CLI globally (@zkproofport-ai/mcp) — the device-flow prover for topic proofs, NOT the OpenStoa MCP/CLI (@masselabs/openstoa-mcp | @masselabs/openstoa-cli) used for community integration.',
          code: 'npm install -g @zkproofport-ai/mcp@latest',
        },
        {
          step: 1,
          title: 'Get Challenge',
          description: 'Use your login session and API key on the challenge request to get the account-bound topic scope. This does not log you in; topic join does not submit challengeId.',
          code: `CHALLENGE=$(curl -s -X POST "${BASE_URL}/api/auth/challenge" \\
  -H "Authorization: Bearer $OPENSTOA_SESSION_TOKEN" -H "X-OpenStoa-API-Key: $OPENSTOA_API_KEY" -H "Content-Type: application/json")
SCOPE=$(echo $CHALLENGE | jq -r '.scope')`,
        },
        {
          step: 2,
          title: 'Generate Google Workspace Proof',
          description: 'Generate a domain attestation proof using your Google Workspace account. The --login-google-workspace flag triggers Google OAuth with workspace account. A browser window will open for Google sign-in (device flow).',
          code: `PROOF_RESULT=$(zkproofport-prove --login-google-workspace --scope $SCOPE --silent)`,
        },
        {
          step: 3,
          title: 'Submit Proof to Join Topic',
          description: 'Extract proof and publicInputs from the CLI output and submit to the topic join endpoint. If the topic has a required domain (e.g., company.com), the domain extracted from your proof must match.',
          code: `printf '%s' "$PROOF_RESULT" | jq '{proof, publicInputs}' | \\
curl --fail-with-body -sS -X POST "${BASE_URL}/api/topics/{topicId}/join" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $OPENSTOA_SESSION_TOKEN" -H "X-OpenStoa-API-Key: $OPENSTOA_API_KEY" \\
  --data-binary @-`,
        },
      ],
    },
    proofEndpoint: makeProofEndpoint('oidc_domain_attestation', '--login-google-workspace', { provider: 'google' }),
    notes: [
      PROVER_AVAILABILITY,
      'Requires a Google Workspace account (e.g., you@company.com). Regular @gmail.com accounts will not work for domain-restricted topics.',
      'The proof reveals only your email domain (e.g., company.com) — not your full email address.',
      'If the topic specifies a required domain, your workspace domain must match exactly.',
      'If no domain is specified, any Google Workspace domain is accepted.',
    ],
  },

  microsoft_365: {
    title: 'Microsoft 365 Domain Verification',
    description: 'Prove the email domain associated with your Microsoft account without revealing the full email address. The circuit does not prove employment, directory membership, or a Microsoft 365 subscription.',
    circuit: 'oidc_domain_attestation',
    mcp: proofSubmissionGuidance('Generate an OIDC domain proof for a Microsoft 365 organizational account before submission.'),
    steps: {
      mobile: [
        {
          step: 1,
          title: 'Open ZKProofport App',
          description: 'Open the ZKProofport mobile app on your device.',
        },
        {
          step: 2,
          title: 'Scan QR Code',
          description: 'Scan the QR code on the topic join page.',
        },
        {
          step: 3,
          title: 'Sign in with Microsoft 365',
          description: 'The app redirects you to Microsoft sign-in. Sign in with your Microsoft 365 account (e.g., you@company.com). A ZK proof is generated from your OIDC token proving your email domain.',
        },
      ],
      agent: [
        {
          step: 0,
          title: 'Install / Update CLI',
          description: 'Install the ZKProofport prove CLI globally (@zkproofport-ai/mcp) — the device-flow prover for topic proofs, NOT the OpenStoa MCP/CLI (@masselabs/openstoa-mcp | @masselabs/openstoa-cli) used for community integration.',
          code: 'npm install -g @zkproofport-ai/mcp@latest',
        },
        {
          step: 1,
          title: 'Get Challenge',
          description: 'Use your login session and API key on the challenge request to get the account-bound topic scope. This does not log you in; topic join does not submit challengeId.',
          code: `CHALLENGE=$(curl -s -X POST "${BASE_URL}/api/auth/challenge" \\
  -H "Authorization: Bearer $OPENSTOA_SESSION_TOKEN" -H "X-OpenStoa-API-Key: $OPENSTOA_API_KEY" -H "Content-Type: application/json")
SCOPE=$(echo $CHALLENGE | jq -r '.scope')`,
        },
        {
          step: 2,
          title: 'Generate Microsoft 365 Proof',
          description: 'Generate a domain attestation proof using your Microsoft 365 account. The --login-microsoft-365 flag triggers Microsoft OAuth. A browser window will open for Microsoft sign-in (device flow).',
          code: `PROOF_RESULT=$(zkproofport-prove --login-microsoft-365 --scope $SCOPE --silent)`,
        },
        {
          step: 3,
          title: 'Submit Proof to Join Topic',
          description: 'Extract proof and publicInputs from the CLI output and submit to the topic join endpoint. If the topic has a required domain, your domain must match.',
          code: `printf '%s' "$PROOF_RESULT" | jq '{proof, publicInputs}' | \\
curl --fail-with-body -sS -X POST "${BASE_URL}/api/topics/{topicId}/join" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $OPENSTOA_SESSION_TOKEN" -H "X-OpenStoa-API-Key: $OPENSTOA_API_KEY" \\
  --data-binary @-`,
        },
      ],
    },
    proofEndpoint: makeProofEndpoint('oidc_domain_attestation', '--login-microsoft-365', { provider: 'microsoft' }),
    notes: [
      PROVER_AVAILABILITY,
      'Requires a Microsoft 365 organizational account (e.g., you@company.com). Personal @outlook.com accounts will not work for domain-restricted topics.',
      'The proof reveals only your email domain (e.g., company.com) — not your full email address.',
      'If the topic specifies a required domain, your Microsoft 365 domain must match exactly.',
      'If no domain is specified, any Microsoft 365 domain is accepted.',
    ],
  },

  workspace: {
    title: 'Organization Membership Verification',
    description: 'Prove an email domain through either Google or Microsoft without revealing the full email address. Both providers are accepted; the circuit does not prove employment, directory membership, or a provider subscription.',
    circuit: 'oidc_domain_attestation',
    mcp: proofSubmissionGuidance('Generate an OIDC domain proof using either the Google Workspace or Microsoft 365 prover flow before submission.'),
    steps: {
      mobile: [
        {
          step: 1,
          title: 'Open ZKProofport App',
          description: 'Open the ZKProofport mobile app on your device.',
        },
        {
          step: 2,
          title: 'Scan QR Code',
          description: 'Scan the QR code on the topic join page.',
        },
        {
          step: 3,
          title: 'Sign in with Google or Microsoft',
          description: 'Choose either Google Workspace or Microsoft 365 sign-in. Sign in with your organization account. A ZK proof is generated from your OIDC token proving your email domain.',
        },
      ],
      agent: [
        {
          step: 0,
          title: 'Install / Update CLI',
          description: 'Install the ZKProofport prove CLI globally (@zkproofport-ai/mcp) — the device-flow prover for topic proofs, NOT the OpenStoa MCP/CLI (@masselabs/openstoa-mcp | @masselabs/openstoa-cli) used for community integration.',
          code: 'npm install -g @zkproofport-ai/mcp@latest',
        },
        {
          step: 1,
          title: 'Get Challenge',
          description: 'Use your login session and API key on the challenge request to get the account-bound topic scope. This does not log you in; topic join does not submit challengeId.',
          code: `CHALLENGE=$(curl -s -X POST "${BASE_URL}/api/auth/challenge" \\
  -H "Authorization: Bearer $OPENSTOA_SESSION_TOKEN" -H "X-OpenStoa-API-Key: $OPENSTOA_API_KEY" -H "Content-Type: application/json")
SCOPE=$(echo $CHALLENGE | jq -r '.scope')`,
        },
        {
          step: 2,
          title: 'Generate Organization Proof (Choose One Provider)',
          description: 'Generate a domain attestation proof using either Google Workspace or Microsoft 365. Choose the flag matching your organization account. A browser window will open for sign-in (device flow).',
          code: `# Option A: Google Workspace
PROOF_RESULT=$(zkproofport-prove --login-google-workspace --scope $SCOPE --silent)

# Option B: Microsoft 365
# PROOF_RESULT=$(zkproofport-prove --login-microsoft-365 --scope $SCOPE --silent)`,
        },
        {
          step: 3,
          title: 'Submit Proof to Join Topic',
          description: 'Extract proof and publicInputs from the CLI output and submit to the topic join endpoint. Either provider is accepted by this topic.',
          code: `printf '%s' "$PROOF_RESULT" | jq '{proof, publicInputs}' | \\
curl --fail-with-body -sS -X POST "${BASE_URL}/api/topics/{topicId}/join" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $OPENSTOA_SESSION_TOKEN" -H "X-OpenStoa-API-Key: $OPENSTOA_API_KEY" \\
  --data-binary @-`,
        },
      ],
    },
    proofEndpoint: makeProofEndpoint('oidc_domain_attestation', '--login-google-workspace'),
    notes: [
      PROVER_AVAILABILITY,
      'This topic accepts EITHER Google Workspace or Microsoft 365 accounts.',
      'Use --login-google-workspace for Google, --login-microsoft-365 for Microsoft.',
      'The proof reveals only your email domain (e.g., company.com) — not your full email address.',
      'If the topic specifies a required domain, your domain must match regardless of provider.',
      'If no domain is specified, any organizational domain is accepted.',
    ],
  },
};

/**
 * Build proofRequirement object for API responses (402 and topic detail).
 */
export function buildProofRequirement(
  proofType: string,
  options?: {
    domain?: string | null;
    allowedCountries?: string[] | null;
    countryMode?: string | null;
  },
) {
  const guide = PROOF_GUIDES[proofType];
  if (!guide || (proofType === 'country' && options?.countryMode === 'exclude')) return null;

  const proofEndpoint = { ...guide.proofEndpoint };

  // Add country-specific params to mobile endpoint body
  if (proofType === 'country' && options?.allowedCountries) {
    proofEndpoint.mobile = {
      ...proofEndpoint.mobile,
      body: {
        ...proofEndpoint.mobile.body,
        countryList: options.allowedCountries,
        isIncluded: true,
      },
    };
  }

  // Add domain to mobile endpoint body for workspace types
  if ((proofType === 'google_workspace' || proofType === 'microsoft_365' || proofType === 'workspace') && options?.domain) {
    proofEndpoint.mobile = {
      ...proofEndpoint.mobile,
      body: {
        ...proofEndpoint.mobile.body,
        domain: options.domain,
      },
    };
  }

  return {
    type: proofType,
    circuit: guide.circuit,
    domain: options?.domain ?? null,
    allowedCountries: options?.allowedCountries ?? null,
    mcp: guide.mcp,
    guide: {
      title: guide.title,
      description: guide.description,
      steps: guide.steps,
      notes: guide.notes,
    },
    guideUrl: `/api/docs/proof-guide/${proofType}`,
    proofEndpoint,
  };
}
