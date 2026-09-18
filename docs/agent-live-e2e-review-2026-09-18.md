# CLI/MCP live verification follow-up — 2026-09-18

## Matrix recorded before extending tests

Target is the local Docker API at port 3200, real built CLI processes and real MCP stdio. No remote deployments or production data. New fixture accounts are provisioned via the local development login; this does not test real Google login.

| Behavior / edge | Verification plan |
| --- | --- |
| Feed, topic list/detail, public topic without proof | Actual CLI/MCP calls and persisted results; join as another scoped agent |
| Invite-only topic | Non-member direct join must fail; create/inspect invitation, token join succeeds; verify membership |
| Post images | Upload PNG through each adapter, attach returned URL with Korean alt text, read post/feed, fetch real stored bytes; clean only fixture uploads |
| Invalid upload boundary | Empty image and oversized image rejected without publishing; malformed content refused |
| Proof-required creation | Missing proof fails for all supported proof types; no created topic or credential state |
| Proof-required join/create success | Requires genuine proof for authenticated account scope, trusted issuer and verifier; investigate available prover/credentials rather than seed trusted cache |
| Authorization | Owner/member/non-member, narrow API key, owner-only API-key management and foreign upload deletion covered |
| UTF-8 / hostile query | Korean, emoji, newlines and literal percent/underscore markers; persisted exact content |
| Async/concurrency | Existing MLS retries and encryption workflows run live; no deliberate Docker/RPC outage in this run |
| Contract helper invocation | Unit/integration layer owns helper spies; live E2E asserts externally visible results |
| Empty/null/pagination limits | Existing contract tests cover parser validation; new live cases focus on upload and required-proof boundaries |

Final outcomes and explicit gaps will be appended after the run. All-command invocation is not equivalent to every command succeeding: unavailable services and forbidden calls must be identified separately.

## Failures diagnosed during this run

- Product defect: SDK multipart upload omitted topicId; commands, CLI and MCP could not accept it. Uploaded post images became owner-only drafts under users/{userId}/uploads. MCP post media readback succeeded but another reader's image request returned 403; the CLI public-reader check returned 401. Add topicId throughout the upload adapters and validate actual downloaded bytes as another reader (and a guest for public topics). The server's existing media visibility policy is unchanged.
- Test fixture bug: the new CLI image test initially sent imageAlts as an array. The server correctly refused with 400; changed fixture to the documented URL-to-description object. This was not an image storage defect.
- Adapter omission: generic workspace proofType existed server-side but was missing from CLI choices and MCP schema. Add it alongside Google/Microsoft-specific types and invalid-type checks.

Proof guide generator arguments were rechecked against the installed generator: current examples already use coinbase_kyc, coinbase_country and provider-specific login flags. Canonical circuit IDs in server metadata are different identifiers and remain correct.

## Live results observed 15:28 KST

| Check | Outcome |
| --- | --- |
| Built CLI process → Docker API | 14/14 scenarios passed; all 84 registered command leaves invoked |
| Real MCP stdio client/server → Docker API | 16/16 scenarios passed; all 84 registered tools invoked |
| Feed / topic list / detail / create without proof | Passed, including persisted Korean and emoji content |
| Public topic without a proof gate | Another API-key agent joined without invitation or proof |
| Private invite | Direct join refused, invitation issued and inspected, token join succeeded; used token refused after leaving |
| Post image | Upload with topicId, post media and URL-keyed alt text, feed/readback, exact PNG bytes as another reader and public guest |
| Image access policy | Private: guest401, signed-in200; secret: nonmember403, member200; nonmember scoped uploads403 |
| Image input boundary | Empty, malformed and oversized payloads refused; published bytes compared exactly |
| Chat / DM | Actual CLI↔MCP text and image encryption/decryption, persisted vaults and history |
| Proof gate | CLI creation without verification refused for kyc/country/google_workspace/microsoft_365/workspace; no topic created |
| Proof happy path | NOT VERIFIED: no genuine proof bound to current fixture accounts and trusted issuer/verifier available |
| Cleanup | Fixture uploads/accounts/topics and temporary vaults cleaned up by both suites |

SDK/commands/CLI/MCP package checks passed (419 tests; one disabled device-login test skipped because it requires the unavailable prover flow). Package builds and typechecks passed. Documentation command inventory and EN/KO/proof guide checks: 38 passed.

All-command invocation includes intended refusal paths: agent API-key management, disabled interactive login/ask, own-post recording and nonexistent approval requests. It does not prove those operations successfully execute. No on-chain write or successful external LLM request was made.

The current adapters submit proof/publicInputs generated elsewhere. They do not contain an integrated prover or expose challenge/proof-request/poll commands. Topic proof scope must be requested through the authenticated REST/SDK flow documented in the proof guides. Public visibility does not cancel a configured proof gate; invite tokens do not bypass one either.

Invite creation returns a token. The shareable web URL is `<OPENSTOA_BASE_URL>/topics/join/<token>`; CLI `topics join-invite` and MCP `openstoa_topic_join_invite` take that token/code, not the entire URL. Earlier encrypted history is a separate key-sharing concern; an invite token alone does not provide historical decryption keys.

These fixes are verified from the repository's local built packages. No npm release was published, so an already-installed registry version may not yet contain them.

Logs: parent `_workspace/agent-cli-live-final-20260918.log`, `.mcp-live-e2e-20260918-fixed.log`, `.upload-*-unit-20260918.log`, and `_workspace/agent-docs-tests-20260918.log`. Failed reproduction logs are preserved alongside them.

## Final source and Docker checks

At 15:30:44 KST the rebuilt local service returned status=ok, with artifact built at 15:28:59 KST; all six service health checks passed. Docker used default Colima, aarch64. Web TypeScript and diff checks passed.

The skipped external proof suite was corrected to request anonymous scope only for login (5 calls) and authenticated account scope for topic proofs (12 calls). Source expectations were aligned with current status codes. It remains unexecuted: prover/OAuth/attestation credentials, appropriate domain accounts and an authorized cache-reset fixture must be prepared before claiming a valid-proof lifecycle result. These source corrections are not included in passing E2E counts.

## Guided proof workflow update (2026-09-18, supersedes manual-only adapter limitation above)

CLI and MCP now share a consent-based topic-proof workflow. Missing or invalid proofs on create, direct join and invite join produce an operation ID and requirement. Interactive CLI can continue the original command; JSON/MCP callers explicitly continue, inspect status, resume or cancel. App mode uses the published app SDK relay through OpenStoa and a QR/deep-link browser page. AI mode invokes the installed proofport-ai prove command with provider device authentication or a locally configured Coinbase signer.

The workflow binds saved actions to the same credential and server, expires them after 15 minutes, stores no proof bytes or credentials, and persists a submission marker before mutation. Concurrent continuations and ambiguous mutation responses never trigger automatic duplicate submission. Crashed file locks deliberately fail closed. Provider keys are never requested in MCP arguments or the browser fragment.

Validation observed at 16:15 KST: full Node 22 regression suite 6,323 passed, 84 skipped; package suites SDK 140, commands 164 (with 1 skip), CLI 112, MCP 89. The root suite includes these package tests, so totals must not be added together. Four proof tools bring MCP inventory to 88. The AI adapter 44 tests and workflow 19 tests use controlled subprocess/proof results, not a genuine external prover. Browser review exercised a real pending relay request and its QR, Korean/English switching and stop-monitoring UI. No phone proof was generated.

Initial broad regression failures were resolved: new browser polling now uses the common 15-second deadline; new TSX surfaces were enrolled in the theme contract with QR-renderer-only black/white exceptions. The standalone SDK run under Node 26 timed out in an existing test that conditionally accesses the host keychain; the supported local Node 22 run passed. No keychain implementation change was made.

**Still unverified:** real successful Google/Microsoft/Coinbase proof generation and subsequent cryptographic topic create/join/invite success. These require the user's device/app approval or a real attested wallet and available external prover. Mocked verification is not counted as successful cryptographic E2E. No npm release or remote deployment has been performed.

Final live run observed at 16:18 KST: **CLI 18/18** (15 complete agent workflows plus 3 MLS round-trip scenarios), **MCP 17/17**, all 88 registered surfaces invoked. The legacy 3-case CLI chat suite initially failed because it used human dev-login sessions, which correctly hit the mobile-only policy. It now uses owner-issued agent API keys through the shared disposable-fixture harness, checks independent MLS vaults and decrypted text, and asserts raw server data contains no plaintext. No production access policy was changed. Old failed-run fixtures were removed by exact topic/account identity, and new fixtures were cleaned up. Added the missing MCP test:e2e npm script. Docker remains healthy on the default Colima aarch64 VM; no global Docker context switch.

Reproduction (Node 22, built packages, local stack running):

```bash
E2E_BASE_URL=http://localhost:3200 npm --prefix packages/cli run test:e2e
E2E_BASE_URL=http://localhost:3200 npm --prefix packages/mcp run test:e2e
```

Logs are in the parent workspace: `.cli-all-e2e-final-20260918.log`, `_workspace/topic-proof-mcp-live-final.log`, `_workspace/topic-proof-web-final.log`, and `_workspace/topic-proof-docker-final.log`.
