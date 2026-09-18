# Topic-proof verification boundary: finding and remediation

Observed by source inspection on 2026-09-18, 14:39 KST. No forged request was sent, no external verifier was called, and no authentication or authorization policy was changed during this audit.

## Current status — source remediation implemented on 2026-09-18

The original finding below records the pre-fix state, not the current route behavior. The shared `src/lib/topic-proof.ts` guard now protects topic creation, direct joins, invite joins and legacy pending-request approvals before membership or verification-cache writes. It validates circuit layouts, authenticated account scope, domain/provider and country predicates, trusted verifier configuration, Coinbase signer roots and OIDC issuer keys. Verification/network failures fail closed. AI login separately requires the supported Google provider and stores a fixed login credential type.

Topic challenges now require authentication and return `zkproofport-community:topic:<userId>`; browser, native/mobile, CLI/MCP examples use this account-bound scope. Invite joins accept proof/publicInputs in the common REST command registry. Native proof generation uses the existing on-device proof flow through an authenticated proof-only relay request; it does not mint or replace the login session.

Old verification records are not trusted: the v2 cache requires the verified scope and predicates. Existing OFF preferences are preserved, but users must reverify old credentials. Existing topic memberships are not automatically removed or revalidated by this change.

### Deliberate limits and remaining validation

- An OIDC domain proof proves control of an email domain claim. It does not establish employment, directory membership or an active Google Workspace/Microsoft 365 subscription. The circuit does not prove JWT expiry or audience; documentation avoids those claims.
- Same-account reuse of a valid credential is supported. Account scope prevents rebinding another account's proof; this is not a one-use challenge protocol.
- Automated boundary tests mock external verifier/JWKS/database dependencies. Passing them is not a live valid-proof/on-chain/device end-to-end result. Actual wallet/OIDC proof generation and the complete native-device return path still need a live device check.
- `APP_ENV` must select trusted verifier configuration; local Compose now explicitly sets `development`. Staging/production deployment already supplies its environment.

See [the final implementation and validation report](landing-locale-proof-review-2026-09-18.md) for test results and evidence.

## Deferred follow-up — proof freshness and reuse (2026-09-18)

User decision: keep login proof generation and existing validity periods unchanged in the unified topic-method update. Do not add raw-proof login import in this step. Topic creation, direct join and invitation join gain consistent app/AI generation controls; existing topic proof submission and verified-cache reuse remain supported.

Next step must distinguish request expiry, login session expiry, verified-cache lifetime and cryptographically authenticated proof freshness. A caller-supplied `expiresAt`, a new challenge, or the 30-day cache TTL does not establish when a raw proof was made. Review proof-to-request binding, trusted timestamps/expiry, revocation and replay limits, and prevent old proof resubmission from indefinitely refreshing credential validity. Define migration before changing circuits/SDKs or refusing currently supported proofs. Required future tests: expired proof under a new challenge, altered expiry, duplicate/concurrent submission, account/predicate mismatch and cache renewal from an old proof.

## Original finding and prerequisites (before remediation)

`POST /api/topics/{topicId}/join` accepts supplied proof bytes without invoking a cryptographic verifier or requiring an authenticated relay result. An authenticated caller with the AI `topic/join` capability when applicable, an existing proof-gated topic, and no existing membership can reach this branch. The personal-topic restriction remains enforced. Client-controlled public inputs must have a parseable layout and the expected community scope plus any topic-specific domain/country fields; the proof string itself is only checked for non-emptiness.

This is a confirmed source-level missing verification boundary, not a live exploit result. The bytes of `proof` are never consumed by a verifier in this route. Correctly formatted claimed attributes can therefore reach cache creation without proving those attributes.

## Evidence and impact

- [join route](../src/app/api/topics/[topicId]/join/route.ts): session/capability checks at lines 182–200; topic and existing-membership checks at 204–237. Lines 260–279 read the request and only require a nonempty proof string.
- Lines 281–335 extract and compare public-input scope, inclusion/country-list and domain fields. These helpers parse data; none verifies proof bytes. No challenge ID, signed relay receipt, or request ID is required by this route.
- Line 342 calls `saveVerificationCache(session.userId, cacheType, {domain})` directly. Lines 372–385 only then reject invite-only topics. Consequently, a later 403 does not undo the verification-cache write. Lines 389–393 insert public-topic membership after the same unchecked branch.
- [verification-cache.ts](../src/lib/verification-cache.ts): lines 107–136 store a status record with a 30-day TTL. Lines 144–162 only check expiry and an optional domain hash when reusing it. These functions do not independently verify proofs or bind their subject to the authenticated user.
- A poisoned record can satisfy later joins without a proof and can feed verification badges. Country-cache reuse is additionally not bound to the topic's allowed-country list: the join cache lookup passes no country predicate and country writes contain no country/list binding. Even a valid proof for one country predicate must not authorize an unrelated predicate by mere cache-type equality.
- There is no proof-subject/nullifier-to-session binding in the direct branch. Adding only a verifier would still require review of replay/rebinding from a valid proof belonging to a different account.

The legitimate mobile flow has a separate boundary: [auth poll route](../src/app/api/auth/poll/[requestId]/route.ts) calls `verifyProofFromRelay` at line 133 before returning proof data. [proof.ts](../src/lib/proof.ts) lines 112–132 invoke on-chain verification. Direct topic join neither calls that function nor requires evidence that the poll route ran. The existence of this mobile check cannot make a separately supplied body authoritative.

## Remediation checklist recorded during the original audit

Before changing code, agree on the expected proof subject, user/session binding, replay rules and country-predicate cache semantics. Then:

1. Require successful cryptographic verification against the explicitly selected supported circuit and trusted verifier configuration before cache writes or membership mutation. Fail closed for malformed inputs, invalid proof bytes, unknown/mismatched circuit, verifier failure and unavailable verification service. Do not trust caller-supplied `verification.valid` or arbitrary verifier addresses.
2. Define and enforce proof-subject/session binding (or an authenticated, scoped, expiring proof receipt bound to the requesting user). Reject another user's otherwise-valid proof; retain the intended authorized delegation behavior only if explicitly defined by policy.
3. Bind cached country predicates to the actual verified allowed-country condition; do not reuse a boolean `country` record across incompatible topic requirements. Apply domain/circuit/scope requirements consistently on fresh and cached paths. Decide how to invalidate records written before the fix.
4. Test invalid nonempty proof plus otherwise matching public inputs: verifier rejects, response refuses, cache and membership receive no write. Also cover thrown verifier errors, wrong circuit/scope/domain/country list and malformed input layouts.
5. Test valid verified proof for the correct account and predicate: expected membership and one cache write. Test the same proof under a different session and mismatched predicate: refusal with no writes.
6. Test invite-only/personal/already-member refusals leave verification state unchanged, and test cache-only joins enforce the same scoped predicate policy. Test existing legitimate mobile and API-key proof submission paths so a fix does not silently change supported identity/delegation semantics.

At the original audit, proof-guide copy was corrected separately: Coinbase circuit CLI names, current `openstoa_topic_join`, actual input shape, hosted-prover availability and safe JSON submission examples. Guide correction alone did not repair the gap; the subsequent code remediation is documented above.
