# Landing language and proof integration review — 2026-09-18

## User-visible changes

- Korean headline: “개인정보는 지키면서 자유롭게 이야기하세요.” Shared sans font remains in use.
- Reused the language selector at the landing page’s upper right for desktop and mobile. Korean/English changes update the page, persist across reloads, and reset the terminal typing animation so old-language text does not remain.
- Existing documentation entry points remain desktop-only, opening a separate tab; direct mobile document links remain readable.

## Proof and client corrections

The [verification audit and remediation record](proof-verification-gap-2026-09-18.md) describes the original missing boundary and its correction. Topic creation, joins, invites and legacy request approvals now enforce verified account-bound predicates before writes. Cache versioning prevents old unverified credentials being reused. API-key calls remain bound to their authenticated owner.

Browser/mobile request account-bound proof mode. Native host proof generation now calls the existing on-device flow through the relay; proof-only polling returns verified scope metadata and preserves the login session. Mobile and browser invite flows obtain required proofs before retrying membership creation and importing locally shared history. CLI/MCP invite operations accept the same proof/publicInputs fields, with reference documentation synchronized to the command registry.

Verification badges backed only by old cache records require a fresh verification. Individual OFF preferences survive migration. Existing memberships are not automatically deleted or revalidated. Email domain proofs do not establish employment, directory membership or a Workspace/M365 subscription. Same-account proof reuse is supported; JWT expiry/audience are not circuit claims.

## Validation

- Final aggregate suite (Node 22.23.2, four workers), started 15:16:06 KST: **6,171 passed, 84 skipped**, 356 passing files / 5 skipped. Package/mobile logic appears in this aggregate, so do not sum it with the separate package runs.
- Docker production build and startup succeeded. Health observation at **15:17:12 KST**: 6/6 services healthy; `/api/health` returned `status: ok`, artifact built at 15:14:28 KST. The script selected default Colima (aarch64) without changing the saved global context.
- Final browser reload at 15:17 KST confirmed the new headline, language selector and `/docs#login` article on the rebuilt Docker service.

- Mobile suite at 15:12 KST: 124 files, 1,572 tests passed.
- Native host suite: 71 suites, 799 tests passed (including the final handoff-race regression); native/mobile TypeScript passed.
- Shared SDK/command/CLI/MCP checks: 276 tests passed, including invite proof argument transport.
- Web TypeScript passed after verified poll metadata was added.
- New tests cover landing locale changes/persistence/typing reset, fresh and cached topic-proof boundaries, cross-account scope rejection, country/domain/provider/issuer checks, invite proof retry, login credential type and proof-only poll metadata.
- Docker browser at 15:13 KST: headline exact, Korean/English switching and reload persistence work. Upper-right selector is 95 × 44 px. At 390 px viewport it remains visible, docs entry points are hidden, and no page-wide horizontal overflow occurs. Headline computed font is the shared Inter/Noto Sans KR stack.

## Test failures investigated

- Independent native review caught an active-proof race during the asynchronous request. A deferred-response regression reproduced it; the adapter now rechecks active proof immediately before native handoff, without interrupting another flow. Focused 30/30 and native full 799/799 passed after the fix.

- New invite proof options were missing from two maintained command tables. Contract tests caught this; README, canonical guide and generated references were synchronized.
- Native SDK-root import violated the host’s dependency boundary. Adapter now uses existing circuit IDs and verified scope metadata from the poll endpoint.
- Unconfigured Node 26 exposes a localStorage incompatible with these jsdom tests. An experimental-webstorage-disabled run removed those failures but one unrelated SDK keystore test timed out while Docker compiled. Final full-suite verification uses the project’s Node 22 runtime and four workers; no test timeout was weakened.

## Limits

Automated proof tests use mocked external verifier/JWKS/database dependencies. Actual valid wallet/OIDC proofs, on-chain verification and the entire physical-device native return path were not exercised end to end. Existing conditional/skipped tests are not counted as coverage. No npm publish, remote deployment, commit or release feature-flag change was performed.

Logs are saved under `../_workspace/landing-locale-proof-20260918/` in the parent workspace.
