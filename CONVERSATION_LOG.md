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
- Found existing TV/Limited Input client credentials in local files (created March 17)
- Microsoft device flow uses `tenant=organizations` (allows any org account)
- `--login-*` and `--jwt` are mutually exclusive

**Testing**: Google device flow tested successfully — JWT obtained, passed to generate_proof. E2E tests 6/6 passed on staging (coinbase_kyc, coinbase_country, oidc_domain + on-chain verify).

### Session 2: Staging Infrastructure Fix

**Discovery**: Staging server was down (502). Root cause: `@virtuals-protocol/acp-node` threw an uncaught promise rejection, crashing the Node.js process. The Docker container had `--restart no` policy, so it stayed down for 16 hours.

**Fix**: Added `--restart unless-stopped` to app container docker run commands. Critical finding: the deploy scripts are **inlined in the GitHub Actions workflow YAML** (`deploy-ai-aws.yml`) — changing the shell scripts in `aws/` alone had no effect. Had to update all three locations: `deploy-blue-green.sh`, `boot-active-slot.sh`, and the workflow YAML.

**Deployed**: Staging redeployed with restart policy verified (`docker inspect` confirmed `unless-stopped`).

### Session 3: npm Publish & Production Deploy

- Published `@zkproofport-ai/mcp@0.2.2` to npm with device flow login support
- Fixed Release Please manifest version mismatch (manifest had 0.1.7, npm had 0.2.1)
- Deployed proofport-ai to production with enclave (`deploy_enclave=true`) for OIDC circuit support
- Updated MCP README with device flow login documentation

### Session 4: OpenStoa Migration to Public Repo

**Human**: "Let's submit OpenStoa to the Synthesis hackathon. First, migrate to a public repo."

**Agent**: Migrated OpenStoa from a subdirectory in the monorepo to a standalone public repo (`zkproofport/openstoa`), preserving all 122 commits of git history using `git filter-repo`. The directory was renamed from `zk-community` to `openstoa` during development, and filter-repo handled the path rename correctly. Re-added as git submodule in parent repo.

---

## Day 1 (March 22) — OIDC Auth Refactoring

### Session 5: Backend OIDC Login Support

**Human**: "OpenStoa is a space where humans and AI agents coexist. Login should use Google any domain (OIDC), and topic creators can set proof requirements for joining."

**Agent**: Implemented OIDC login support in parallel using two executor agents:

**Auth refactoring (agent 1)**:
- `src/lib/proof.ts`: Added `extractDomain()` and `detectCircuit()` functions
- `src/app/api/auth/verify/ai/route.ts`: Circuit detection via verifier address (primary) with public input count fallback
- Challenge endpoint already circuit-agnostic — no changes needed

**Topic gating expansion (agent 2)**:
- `src/lib/db/schema.ts`: Added `proofType` ('none'|'kyc'|'country'|'google_workspace'|'microsoft_365') and `requiredDomain` fields
- `src/app/api/topics/route.ts`: Topic creation accepts proofType + requiredDomain
- `src/app/api/topics/[topicId]/join/route.ts`: Multi-type proof verification for topic join

**Key architectural decision**: Circuit detection by verifier address instead of public input count. The OIDC circuit has 148 public inputs (not 420 as previously assumed in the SDK). Verifier address mapping: `0xf7de...` → coinbase_attestation, `0x9677...` → oidc_domain_attestation.

### Session 6: SDK Public Input Layout Fix

**Discovery**: `@zkproofport-app/sdk` had incorrect OIDC layout offsets (assumed 420 fields based on byte-level expansion). Actual circuit layout from `main.nr`:
- `pubkey_modulus_limbs: pub [u128; 18]` → 18 fields
- `domain: pub BoundedVec<u8, 64>` → 65 fields (1 len + 64 storage)
- `scope: pub [u8; 32]` → 32 fields
- `nullifier: pub [u8; 32]` → 32 fields
- `provider: pub u8` → 1 field
- **Total: 148 fields**

**Fix**: Updated `proofport-app-sdk` constants and extraction functions. Published `@zkproofport-app/sdk@0.2.6` via GitHub Release → npm-publish workflow. Tests updated and passing (20/20).

**Human insisted**: "SDK에서 추출하는 함수 사용하라고! 없으면 SDK에서 추가해서 openstoa에서는 그 SDK 사용해야해!" — This was the correct approach: fix the SDK upstream, not hardcode constants in OpenStoa.

### Session 7: Full Login Flow Test (Production)

Successfully tested the complete authentication flow:
1. `POST /api/auth/challenge` → challengeId + scope
2. `zkproofport-prove --login-google --scope $SCOPE --silent` → Google device flow → JWT → ZK proof (production server, E2E encrypted, TEE)
3. `POST /api/auth/verify/ai` → nullifier extraction → session token issued
4. `GET /api/topics?view=all` with Bearer token → API access confirmed

**Nullifier**: `0xfb2bb249b1e226d1a41d8bd420c752e96596c48c30593d21e1be2a04be142d1c` (derived from email + scope, privacy-preserving)

---

## Day 1 (March 22) — Features & Testing

### Session 8: ASK AI Feature

**Agent**: Created `/api/ask` endpoint with Gemini 2.5 Flash (primary) → OpenAI gpt-4o-mini (fallback). Added "ASK" button in header with modal UI. Endpoint added to OpenAPI spec (41 paths total).

**Bug found**: Initially used `gemini-2.0-flash` which is deprecated. Updated to `gemini-2.5-flash`.

### Session 9: Frontend & Documentation Updates

- **Landing page**: Updated Human side to "Login with Google" (OIDC), Agent side code examples use `--login-google`
- **Docs page**: Rewritten from Coinbase KYC to OIDC-based login guide with PAYMENT_KEY + CDP wallet options
- **skill.md**: Updated auth flow for device flow login + topic proof generation guide with ATTESTATION_KEY for Coinbase circuits
- **README.md**: Full auth flow (challenge → proof → verify → token)
- **DB**: Removed `community_` table prefix, dedicated `openstoa` database, migration to `db:push` mode

### Session 10: Admin Role & Topic proofType UI

**Human**: "Category API는 어드민 전용! proofType UI 추가! 채팅에서 @ask 기능!"

**Agent**: Implemented in parallel:
- **Admin role**: Added `role` field to users ('user'|'admin'), Category POST restricted to admin (403 for non-admin), removed POST from OpenAPI
- **Topic creation UI**: Replaced "Require Country Proof" checkbox with proofType dropdown (none/kyc/country/google_workspace/microsoft_365) with conditional domain input
- **Chat @ask**: Messages starting with `@ask` trigger LLM response via Gemini/OpenAI, saved to chat history with 🤖 prefix

### Session 11: Comprehensive E2E Testing

**API testing**: All 43 endpoints tested with authentication:
- Auth (challenge, verify, session, logout, poll, token-login, proof-request) ✅
- Topics CRUD (create, list, detail, join, invite, members, requests) ✅
- Posts CRUD (create, detail, comments, vote, reactions, bookmark, pin, record) ✅
- Chat (send, history with pagination, SSE subscribe, presence, @ask) ✅
- Profile (nickname, image GET/PUT) ✅
- Feed, stats, tags, bookmarks, recorded, upload, categories ✅
- ASK (Gemini response) ✅
- OpenAPI JSON (41 paths, /api/ask included) ✅

**Page testing**: All 15 pages verified via agent-browser with screenshots:
- Landing, Topics Feed, Topics All, Topic New, Topic Detail (x2), Members (x2), Join, Post Detail (x2), My Posts, Recorded, Docs, Profile ✅

**Issues found and fixed**:
- `poll/{requestId}` returned 500 for not-found → fixed to 404
- SSE subscribe returned 500 → resolved after server restart (schema sync)
- OpenAPI JSON route imported from non-existent generated file → restored auto-generation via `generate-skill.ts`

**Human feedback**: "기존에 openapi가 자동생성되도록 되어 있을텐데 충돌은 없는거야? 지금 당장 오류 없앨려고?" — Correctly identified that the agent was bypassing the auto-generation mechanism. Restored original pattern and documented in `openstoa-dev.md`.

---

## Architecture Summary

```
Human (mobile)  ──→  ZKProofport App  ──→  ZK Proof  ──→  OpenStoa
AI Agent (CLI)  ──→  prove.ts          ──→  ZK Proof  ──→  OpenStoa
                                                              │
                                              ┌───────────────┼───────────────┐
                                              │               │               │
                                          Topics/Posts    Real-time Chat   On-chain Record
                                          (PostgreSQL)    (Redis Pub/Sub)  (Base chain)
                                              │               │
                                          Proof Gating    @ask AI
                                          (KYC/Country/   (Gemini/OpenAI)
                                           Workspace/M365)
```

---

## Day 2 (March 23) — Mobile Login Fix, Verification Badges, Invites

### Session 12: Mobile OIDC Login Debugging

**Issue**: Mobile app generates OIDC proof successfully, but OpenStoa keeps polling forever — login never completes.

**Investigation**: Analyzed relay logs and community Cloud Run logs simultaneously. Relay showed `status=completed` with proof data, but community backend kept polling.

**Root cause found**: `poll/[requestId]/route.ts` hardcoded `'coinbase_attestation'` for scope/nullifier extraction (lines 144, 156). When an OIDC proof arrived, it extracted scope at coinbase offsets (64-95) instead of OIDC offsets (83-114) → scope mismatch → 400 error → ProofGate silently retried forever.

**Fix**: Replaced hardcoded circuit with `detectCircuit(result.publicInputs, result.verifierAddress)`.

**Human**: "proofport-ai/sdk 에서는 정상 파싱해서 로그인 되던거 아니야?" — Correctly identified that the AI login path (verify/ai) already used `detectCircuit`, but the mobile path (poll) didn't.

### Session 13: Mobile App Domain Auto-extraction

**Issue**: Mobile app required domain input for OIDC proof generation — button disabled without domain.

**Changes**:
- `DomainInputScreen.tsx`: Domain optional for all modes (any email, workspace, ms365)
- `ProofGenerationScreen.tsx`: Skip domain required error, log auto-extraction
- `useOidcDomain.ts`: Auto-extract domain from JWT email if not provided
- `oidcDomain.ts`: Fallback to `email.substring(atIndex + 1)` when `params.domain` is empty
- Domain mismatch check only when domain explicitly provided

**Human verified**: proofport-ai backend already had domain auto-extraction (`oidcProver.ts:200`).

### Session 14: Verification Badge System

**Human**: "각 유저별로 증명의 마지막 검증 시간을 기록하고 주기적으로 재검증. KYC 뱃지, 나라 뱃지, 도메인 뱃지. 일회용 invite 링크."

**Implemented** (parallel agents):

**Backend (verification-backend agent)**:
- DB: `user_verifications` table (proofType, domain, country, 30-day expiry)
- DB: `invite_tokens` table (single-use, 7-day expiry)
- `verification.ts`: saveVerification, getActiveVerifications, hasValidVerification helpers
- Auth routes: save verification on successful login (both AI + mobile)
- `GET /api/profile/badges` endpoint

**Frontend + API (invite-badges agent)**:
- `POST /api/topics/{topicId}/invite`: generate single-use invite token
- Join by invite: supports both fixed inviteCode + single-use tokens, auto-dispose after use
- Topic join: all proof types (kyc/country/workspace/ms365) with existing-verification bypass
- Posts/comments API: include author badges in responses
- `Badge.tsx` component: visual badges (KYC ✓, Country 🌍, Workspace/MS365 📧)
- `PostCard.tsx`: badges rendered next to author nickname

**Pre-commit hook**: Auto-generated migration `0001_salty_hedge_knight.sql` + skill.md/openapi-spec.json

### Session 15: Infrastructure Fixes

- **Logo image 307**: `/images/` path not in middleware PUBLIC_PREFIXES → redirected to login. Fixed.
- **Chat header duplication**: Mobile overlay had its own "LIVE CHAT" header + ChatPanel header. Removed duplicate.
- **Relay OIDC message**: Changed "Verify your Coinbase KYC" → "Login with Google" for OIDC circuit.
- **Relay domain passthrough**: Added domain parameter to proof-request for topic gating.
- **LLM API keys on staging**: Added `GEMINI_API_KEY` + `OPENAI_API_KEY` to deploy workflow with environment-prefixed secrets.
- **Category auto-seed**: 4 default categories seeded on boot via instrumentation.ts.
- **generate-skill.ts STATIC_HEADER**: Updated to OIDC-based description (was still Coinbase KYC).

---

## Key Learnings

1. **Circuit public input layout must match the actual Noir circuit** — SDK had 420-field layout but circuit produces 148 fields. Always check `main.nr` for ground truth.
2. **Deploy scripts inlined in workflow YAML** — changing shell scripts in `aws/` has no effect. Must update the YAML.
3. **Google Device Code Flow requires "TV and Limited Input" client type** — web client IDs don't work.
4. **Auto-generation patterns must be respected** — `generate-skill.ts` produces both `skill.md` and `openapi-spec.json`. Don't bypass by importing differently.
5. **SDK changes should be upstream** — don't hardcode extraction logic in applications. Fix the SDK, publish, install.
6. **Never hardcode circuit types in endpoints** — the poll endpoint hardcoded `coinbase_attestation` for scope extraction, causing OIDC login failure. Always use `detectCircuit()`.
7. **Domain auto-extraction from JWT** — already implemented in proofport-ai (`oidcProver.ts`). Mobile app needed the same pattern.
8. **Pre-commit hooks save time** — schema changes auto-generate migrations, API changes auto-generate skill.md + openapi-spec.json. No manual steps to forget.
