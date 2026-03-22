# OpenStoa — Human-Agent Collaboration Log

## Background

OpenStoa is an existing ZK-gated community platform built on ZKProofport infrastructure. It allows users to prove organizational affiliation (Coinbase KYC, country attestation) via zero-knowledge proofs and participate in topic-based discussions — all without revealing personal information.

During **The Synthesis** hackathon (March 13-22, 2026), we refactored OpenStoa to support OIDC-based authentication (Google, Google Workspace, Microsoft 365) and expanded topic gating to support domain-based proof requirements. This enables both humans and AI agents to participate in privacy-preserving community discussions.

---

## Day 1 (March 22) — Device Flow Login & Infrastructure

### Session 1: prove.ts Device Flow Implementation

**Human**: "We need device flow login for the prove.ts CLI tool — Google, Google Workspace, and Microsoft 365."

**Agent**: Implemented three new CLI flags in `proofport-ai/packages/mcp/src/prove.ts`:
- `--login-google`: Google device flow → JWT, no provider (any Google account)
- `--login-google-workspace`: Google device flow → JWT + provider='google' (proves org membership)
- `--login-microsoft-365`: Microsoft device flow → JWT + provider='microsoft' (proves org membership)

**Key decisions**:
- Device flow uses OAuth 2.0 Device Authorization Grant (RFC 8628)
- Google requires a "TVs and Limited Input devices" client type — web client ID doesn't work for device flow
- Found existing TV/Limited Input client credentials in `~/Documents/개인/ZKP/` (created March 17)
- Microsoft device flow uses `tenant=organizations` (allows any org account)
- `--login-*` and `--jwt` are mutually exclusive

**Testing**: Google device flow tested successfully — JWT obtained, passed to generate_proof. E2E tests 6/6 passed (coinbase_kyc, coinbase_country, oidc_domain + verify).

### Session 2: Staging Infrastructure Fix

**Discovery**: Staging server was down (502). Root cause: `@virtuals-protocol/acp-node` threw an uncaught promise rejection, crashing the Node.js process. The Docker container had `--restart no` policy, so it stayed down.

**Fix**: Added `--restart unless-stopped` to both `deploy-blue-green.sh` and `boot-active-slot.sh`. Critical finding: the deploy scripts are **inlined in the GitHub Actions workflow YAML** — changing the shell scripts alone had no effect. Had to update `.github/workflows/deploy-ai-aws.yml` as well.

**Deployed**: Staging redeployed, health check 200, restart policy verified.

### Session 3: npm Publish

Published `@zkproofport-ai/mcp@0.2.2` with device flow login support. Fixed Release Please manifest version mismatch (was at 0.1.7, npm was at 0.2.1).

### Session 4: OpenStoa Migration

**Human**: "Let's submit OpenStoa to the Synthesis hackathon. First, migrate to a public repo."

Migrated OpenStoa from a subdirectory in the monorepo to a standalone public repo (`zkproofport/openstoa`), preserving all 122 commits of git history using `git filter-repo`. The directory was renamed from `zk-community` to `openstoa` during development, and filter-repo handled the path rename correctly.

### Session 5: OIDC Auth Refactoring (In Progress)

**Human**: "OpenStoa is a space where humans and AI agents coexist, built on ZK (ZKProofport). Users should be able to create topics and discuss. Login should use Google any domain (OIDC), and topic creators can set proof requirements for joining."

**Refactoring plan**:
1. **Login**: Change from Coinbase KYC proof → Google OIDC (any domain) for account creation
   - Nullifier derived from email + scope (Sybil-resistant without revealing email)
   - Humans: mobile app relay with oidc_domain circuit
   - AI agents: prove.ts `--login-google` via MCP/SDK
2. **Topic gating**: Expand from country-only to multiple proof types
   - None (open to all logged-in users)
   - Coinbase KYC (prove identity verification)
   - Coinbase Country (prove country membership)
   - Google Workspace (prove domain affiliation, e.g., company.com)
   - Microsoft 365 (prove domain affiliation, e.g., company.onmicrosoft.com)
3. **Documentation**: Update skill.md and README for hackathon submission
