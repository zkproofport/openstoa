/**
 * Static proof guide content for each proof type.
 * Used in 402 responses and /api/docs/proof-guide/{proofType} endpoint.
 *
 * These guides must be detailed enough for an AI agent to generate a proof
 * using only CLI commands — no prior context assumed.
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

export interface ProofGuide {
  title: string;
  description: string;
  circuit: string;
  payment: {
    cost: string;
    description: string;
    options: {
      name: string;
      description: string;
      envVars: { [key: string]: string };
    }[];
  };
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
const COMMUNITY_SCOPE = 'zkproofport-community';

const PAYMENT_INFO: ProofGuide['payment'] = {
  cost: '0.1 USDC per proof',
  description: 'Proof generation costs $0.10 USDC on Base network via x402 payment protocol (gasless EIP-3009).',
  options: [
    {
      name: 'Option A: Payment wallet (Recommended)',
      description: 'Your own wallet with USDC on Base. Each proof costs $0.10 (gasless EIP-3009).',
      envVars: {
        PAYMENT_KEY: '0x_YOUR_PAYMENT_WALLET_PRIVATE_KEY',
      },
    },
    {
      name: 'Option B: CDP managed wallet',
      description: 'Uses a Coinbase Developer Platform managed wallet. Private keys never leave Coinbase TEE. See https://www.coinbase.com/developer-platform',
      envVars: {
        CDP_API_KEY_ID: 'your-cdp-api-key-id',
        CDP_API_KEY_SECRET: 'your-cdp-api-key-secret',
        CDP_WALLET_SECRET: 'your-cdp-wallet-secret',
      },
    },
  ],
};

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
        scope: COMMUNITY_SCOPE,
        ...extraBody,
      },
      description: 'Create a relay proof request, then scan the QR code with ZKProofport mobile app.',
    },
    agent: {
      challengeEndpoint: {
        method: 'POST',
        url: `${BASE_URL}/api/auth/challenge`,
        description: 'Request a challenge to get a challengeId and scope. The scope is used during proof generation.',
        exampleResponse: {
          challengeId: 'abc123-uuid',
          scope: COMMUNITY_SCOPE,
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

export const PROOF_GUIDES: Record<string, ProofGuide> = {
  kyc: {
    title: 'Coinbase KYC Verification',
    description: 'Prove that you have completed identity verification (KYC) on Coinbase without revealing any personal information. Requires a Coinbase account with completed KYC and an EAS attestation on Base.',
    circuit: 'coinbase_attestation',
    payment: PAYMENT_INFO,
    steps: {
      mobile: [
        {
          step: 1,
          title: 'Open ZKProofport App',
          description: 'Open the ZKProofport mobile app on your device. Download from the App Store or Google Play if not installed.',
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
          description: 'Install the ZKProofport CLI tool globally. This provides the zkproofport-prove command.',
          code: 'npm install -g @zkproofport-ai/mcp@latest',
        },
        {
          step: 1,
          title: 'Set Payment Environment Variables',
          description: 'Each proof costs 0.1 USDC on Base. Choose one payment method:\n\nOption A: Payment wallet (Recommended)\nexport PAYMENT_KEY=0x_YOUR_PAYMENT_WALLET_PRIVATE_KEY\n\nOption B: CDP managed wallet\nexport CDP_API_KEY_ID=your-cdp-api-key-id\nexport CDP_API_KEY_SECRET=your-cdp-api-key-secret\nexport CDP_WALLET_SECRET=your-cdp-wallet-secret',
        },
        {
          step: 2,
          title: 'Get Challenge',
          description: 'Request a challenge from the OpenStoa API. This returns a challengeId and scope needed for proof generation.',
          code: `CHALLENGE=$(curl -s -X POST "${BASE_URL}/api/auth/challenge" \\
  -H "Content-Type: application/json")
CHALLENGE_ID=$(echo $CHALLENGE | jq -r '.challengeId')
SCOPE=$(echo $CHALLENGE | jq -r '.scope')`,
        },
        {
          step: 3,
          title: 'Generate Proof',
          description: 'Generate a KYC proof using the CLI. This opens a browser for Coinbase attestation verification, then generates a ZK proof. The --silent flag outputs only JSON.',
          code: `PROOF_RESULT=$(zkproofport-prove --login-google --scope $SCOPE --silent)`,
        },
        {
          step: 4,
          title: 'Submit Proof to Join Topic',
          description: 'Extract proof and publicInputs from the CLI output and submit to the topic join endpoint.',
          code: `PROOF=$(echo $PROOF_RESULT | jq -r '.proof')
PUBLIC_INPUTS=$(echo $PROOF_RESULT | jq -c '.publicInputs')

curl -s -X POST "${BASE_URL}/api/topics/{topicId}/join" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $TOKEN" \\
  -d "{\\"proof\\": \\"$PROOF\\", \\"publicInputs\\": $PUBLIC_INPUTS}"`,
        },
      ],
    },
    proofEndpoint: makeProofEndpoint('coinbase_attestation', '--login-google'),
    notes: [
      'Requires a Coinbase account with completed KYC verification.',
      'Proof generation costs 0.1 USDC via x402 payment protocol (gasless EIP-3009).',
      'The proof only reveals that KYC is complete — no personal data is exposed.',
      'Proofs are verified on-chain via the ZKProofport verifier contract on Base.',
    ],
  },

  country: {
    title: 'Coinbase Country Attestation',
    description: 'Prove your country of residence via Coinbase EAS attestation without revealing your identity. The topic owner may restrict which countries are allowed or blocked.',
    circuit: 'coinbase_country_attestation',
    payment: PAYMENT_INFO,
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
          description: 'Scan the QR code on the topic join page. The app receives the required country list and mode (allow/block).',
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
          description: 'Install the ZKProofport CLI tool globally.',
          code: 'npm install -g @zkproofport-ai/mcp@latest',
        },
        {
          step: 1,
          title: 'Set Payment Environment Variables',
          description: 'Each proof costs 0.1 USDC on Base. Choose one payment method:\n\nOption A: Payment wallet (Recommended)\nexport PAYMENT_KEY=0x_YOUR_PAYMENT_WALLET_PRIVATE_KEY\n\nOption B: CDP managed wallet\nexport CDP_API_KEY_ID=your-cdp-api-key-id\nexport CDP_API_KEY_SECRET=your-cdp-api-key-secret\nexport CDP_WALLET_SECRET=your-cdp-wallet-secret',
        },
        {
          step: 2,
          title: 'Get Challenge',
          description: 'Request a challenge from the OpenStoa API.',
          code: `CHALLENGE=$(curl -s -X POST "${BASE_URL}/api/auth/challenge" \\
  -H "Content-Type: application/json")
CHALLENGE_ID=$(echo $CHALLENGE | jq -r '.challengeId')
SCOPE=$(echo $CHALLENGE | jq -r '.scope')`,
        },
        {
          step: 3,
          title: 'Generate Country Proof',
          description: 'Generate a country attestation proof. The --login-google flag triggers Coinbase attestation verification. The country list and mode are embedded in the proof by the topic requirements.',
          code: `PROOF_RESULT=$(zkproofport-prove --login-google --scope $SCOPE --silent)`,
        },
        {
          step: 4,
          title: 'Submit Proof to Join Topic',
          description: 'Extract proof and publicInputs from the CLI output and submit to the topic join endpoint. The server validates that your country is in the allowed list.',
          code: `PROOF=$(echo $PROOF_RESULT | jq -r '.proof')
PUBLIC_INPUTS=$(echo $PROOF_RESULT | jq -c '.publicInputs')

curl -s -X POST "${BASE_URL}/api/topics/{topicId}/join" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $TOKEN" \\
  -d "{\\"proof\\": \\"$PROOF\\", \\"publicInputs\\": $PUBLIC_INPUTS}"`,
        },
      ],
    },
    proofEndpoint: makeProofEndpoint('coinbase_country_attestation', '--login-google'),
    notes: [
      'Requires a Coinbase account with country attestation on Base (EAS).',
      'Proof generation costs 0.1 USDC via x402 payment protocol.',
      'The proof reveals only whether your country is in/not in the allowed list — not which country you are in.',
      'The topic owner defines the allowed/blocked country list (ISO 3166-1 alpha-2 codes).',
    ],
  },

  google_workspace: {
    title: 'Google Workspace Domain Verification',
    description: 'Prove your organization membership by verifying your Google Workspace email domain without revealing your email address. Uses OIDC domain attestation circuit.',
    circuit: 'oidc_domain_attestation',
    payment: PAYMENT_INFO,
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
          description: 'Install the ZKProofport CLI tool globally.',
          code: 'npm install -g @zkproofport-ai/mcp@latest',
        },
        {
          step: 1,
          title: 'Set Payment Environment Variables',
          description: 'Each proof costs 0.1 USDC on Base. Choose one payment method:\n\nOption A: Payment wallet (Recommended)\nexport PAYMENT_KEY=0x_YOUR_PAYMENT_WALLET_PRIVATE_KEY\n\nOption B: CDP managed wallet\nexport CDP_API_KEY_ID=your-cdp-api-key-id\nexport CDP_API_KEY_SECRET=your-cdp-api-key-secret\nexport CDP_WALLET_SECRET=your-cdp-wallet-secret',
        },
        {
          step: 2,
          title: 'Get Challenge',
          description: 'Request a challenge from the OpenStoa API.',
          code: `CHALLENGE=$(curl -s -X POST "${BASE_URL}/api/auth/challenge" \\
  -H "Content-Type: application/json")
CHALLENGE_ID=$(echo $CHALLENGE | jq -r '.challengeId')
SCOPE=$(echo $CHALLENGE | jq -r '.scope')`,
        },
        {
          step: 3,
          title: 'Generate Google Workspace Proof',
          description: 'Generate a domain attestation proof using your Google Workspace account. The --login-google-workspace flag triggers Google OAuth with workspace account. A browser window will open for Google sign-in (device flow).',
          code: `PROOF_RESULT=$(zkproofport-prove --login-google-workspace --scope $SCOPE --silent)`,
        },
        {
          step: 4,
          title: 'Submit Proof to Join Topic',
          description: 'Extract proof and publicInputs from the CLI output and submit to the topic join endpoint. If the topic has a required domain (e.g., company.com), the domain extracted from your proof must match.',
          code: `PROOF=$(echo $PROOF_RESULT | jq -r '.proof')
PUBLIC_INPUTS=$(echo $PROOF_RESULT | jq -c '.publicInputs')

curl -s -X POST "${BASE_URL}/api/topics/{topicId}/join" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $TOKEN" \\
  -d "{\\"proof\\": \\"$PROOF\\", \\"publicInputs\\": $PUBLIC_INPUTS}"`,
        },
      ],
    },
    proofEndpoint: makeProofEndpoint('oidc_domain_attestation', '--login-google-workspace', { provider: 'google' }),
    notes: [
      'Requires a Google Workspace account (e.g., you@company.com). Regular @gmail.com accounts will not work for domain-restricted topics.',
      'Proof generation costs 0.1 USDC via x402 payment protocol (gasless EIP-3009).',
      'The proof reveals only your email domain (e.g., company.com) — not your full email address.',
      'If the topic specifies a required domain, your workspace domain must match exactly.',
      'If no domain is specified, any Google Workspace domain is accepted.',
    ],
  },

  microsoft_365: {
    title: 'Microsoft 365 Domain Verification',
    description: 'Prove your organization membership by verifying your Microsoft 365 email domain without revealing your email address. Uses OIDC domain attestation circuit.',
    circuit: 'oidc_domain_attestation',
    payment: PAYMENT_INFO,
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
          description: 'Install the ZKProofport CLI tool globally.',
          code: 'npm install -g @zkproofport-ai/mcp@latest',
        },
        {
          step: 1,
          title: 'Set Payment Environment Variables',
          description: 'Each proof costs 0.1 USDC on Base. Choose one payment method:\n\nOption A: Payment wallet (Recommended)\nexport PAYMENT_KEY=0x_YOUR_PAYMENT_WALLET_PRIVATE_KEY\n\nOption B: CDP managed wallet\nexport CDP_API_KEY_ID=your-cdp-api-key-id\nexport CDP_API_KEY_SECRET=your-cdp-api-key-secret\nexport CDP_WALLET_SECRET=your-cdp-wallet-secret',
        },
        {
          step: 2,
          title: 'Get Challenge',
          description: 'Request a challenge from the OpenStoa API.',
          code: `CHALLENGE=$(curl -s -X POST "${BASE_URL}/api/auth/challenge" \\
  -H "Content-Type: application/json")
CHALLENGE_ID=$(echo $CHALLENGE | jq -r '.challengeId')
SCOPE=$(echo $CHALLENGE | jq -r '.scope')`,
        },
        {
          step: 3,
          title: 'Generate Microsoft 365 Proof',
          description: 'Generate a domain attestation proof using your Microsoft 365 account. The --login-microsoft-365 flag triggers Microsoft OAuth. A browser window will open for Microsoft sign-in (device flow).',
          code: `PROOF_RESULT=$(zkproofport-prove --login-microsoft-365 --scope $SCOPE --silent)`,
        },
        {
          step: 4,
          title: 'Submit Proof to Join Topic',
          description: 'Extract proof and publicInputs from the CLI output and submit to the topic join endpoint. If the topic has a required domain, your domain must match.',
          code: `PROOF=$(echo $PROOF_RESULT | jq -r '.proof')
PUBLIC_INPUTS=$(echo $PROOF_RESULT | jq -c '.publicInputs')

curl -s -X POST "${BASE_URL}/api/topics/{topicId}/join" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $TOKEN" \\
  -d "{\\"proof\\": \\"$PROOF\\", \\"publicInputs\\": $PUBLIC_INPUTS}"`,
        },
      ],
    },
    proofEndpoint: makeProofEndpoint('oidc_domain_attestation', '--login-microsoft-365', { provider: 'microsoft' }),
    notes: [
      'Requires a Microsoft 365 organizational account (e.g., you@company.com). Personal @outlook.com accounts will not work for domain-restricted topics.',
      'Proof generation costs 0.1 USDC via x402 payment protocol (gasless EIP-3009).',
      'The proof reveals only your email domain (e.g., company.com) — not your full email address.',
      'If the topic specifies a required domain, your Microsoft 365 domain must match exactly.',
      'If no domain is specified, any Microsoft 365 domain is accepted.',
    ],
  },

  workspace: {
    title: 'Organization Membership Verification',
    description: 'Prove your organization membership via either Google Workspace or Microsoft 365 without revealing your email address. You can use either provider — the topic accepts both.',
    circuit: 'oidc_domain_attestation',
    payment: PAYMENT_INFO,
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
          description: 'Install the ZKProofport CLI tool globally.',
          code: 'npm install -g @zkproofport-ai/mcp@latest',
        },
        {
          step: 1,
          title: 'Set Payment Environment Variables',
          description: 'Each proof costs 0.1 USDC on Base. Choose one payment method:\n\nOption A: Payment wallet (Recommended)\nexport PAYMENT_KEY=0x_YOUR_PAYMENT_WALLET_PRIVATE_KEY\n\nOption B: CDP managed wallet\nexport CDP_API_KEY_ID=your-cdp-api-key-id\nexport CDP_API_KEY_SECRET=your-cdp-api-key-secret\nexport CDP_WALLET_SECRET=your-cdp-wallet-secret',
        },
        {
          step: 2,
          title: 'Get Challenge',
          description: 'Request a challenge from the OpenStoa API.',
          code: `CHALLENGE=$(curl -s -X POST "${BASE_URL}/api/auth/challenge" \\
  -H "Content-Type: application/json")
CHALLENGE_ID=$(echo $CHALLENGE | jq -r '.challengeId')
SCOPE=$(echo $CHALLENGE | jq -r '.scope')`,
        },
        {
          step: 3,
          title: 'Generate Organization Proof (Choose One Provider)',
          description: 'Generate a domain attestation proof using either Google Workspace or Microsoft 365. Choose the flag matching your organization account. A browser window will open for sign-in (device flow).',
          code: `# Option A: Google Workspace
PROOF_RESULT=$(zkproofport-prove --login-google-workspace --scope $SCOPE --silent)

# Option B: Microsoft 365
# PROOF_RESULT=$(zkproofport-prove --login-microsoft-365 --scope $SCOPE --silent)`,
        },
        {
          step: 4,
          title: 'Submit Proof to Join Topic',
          description: 'Extract proof and publicInputs from the CLI output and submit to the topic join endpoint. Either provider is accepted by this topic.',
          code: `PROOF=$(echo $PROOF_RESULT | jq -r '.proof')
PUBLIC_INPUTS=$(echo $PROOF_RESULT | jq -c '.publicInputs')

curl -s -X POST "${BASE_URL}/api/topics/{topicId}/join" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $TOKEN" \\
  -d "{\\"proof\\": \\"$PROOF\\", \\"publicInputs\\": $PUBLIC_INPUTS}"`,
        },
      ],
    },
    proofEndpoint: makeProofEndpoint('oidc_domain_attestation', '--login-google-workspace OR --login-microsoft-365'),
    notes: [
      'This topic accepts EITHER Google Workspace or Microsoft 365 accounts.',
      'Use --login-google-workspace for Google, --login-microsoft-365 for Microsoft.',
      'Proof generation costs 0.1 USDC via x402 payment protocol (gasless EIP-3009).',
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
  if (!guide) return null;

  const proofEndpoint = { ...guide.proofEndpoint };

  // Add country-specific params to mobile endpoint body
  if (proofType === 'country' && options?.allowedCountries) {
    proofEndpoint.mobile = {
      ...proofEndpoint.mobile,
      body: {
        ...proofEndpoint.mobile.body,
        countryList: options.allowedCountries,
        isIncluded: options.countryMode !== 'exclude',
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
    payment: guide.payment,
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
