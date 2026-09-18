# Documentation navigation and landing typography review

Verified on 2026-09-18 at 14:50 KST against the local Docker stack. This is a historical checkpoint; subsequent headline/language changes and proof-boundary remediation are recorded in [the follow-up report](landing-locale-proof-review-2026-09-18.md).

## Delivered

- The main human headline now uses the shared sans font stack (Korean: Noto Sans KR), replacing the isolated Noto Serif KR style. Copy: “부담 없이 이야기하세요. 개인정보는 지키면서.”
- Documentation has 11 stable subject URLs with a desktop sidebar and one selected article: introduction, authentication/CLI/MCP, topics, posts/comments, chat/DM, Google login proof, workspace proof, Coinbase KYC proof, country proof, all 84 CLI commands, and REST examples.
- Existing section fragments resolve to their matching subject. Direct links, browser history and locale changes are covered.
- Landing, header and sidebar docs entry points open separately. MCP/CLI setup opens `/docs#login`. Korean entry label: “문서 보기”.
- Documentation entry points are hidden below 768px. Direct/shared docs URLs remain readable at phone widths. No native mobile-app documentation feature was added.
- Existing `/docs/tiers` remains available; its content is reused inside the topics article. The old landing agent setup modal was replaced by the shared documentation.
- Proof-generation examples and MCP topic-join descriptions were corrected to match current names and route behavior. This does not fix the separate verification boundary described below.

## Verification

- Full existing Vitest run: 6,068 passed, 84 skipped (351 passing files, 5 skipped). The pre-existing skips were not treated as exercised coverage.
- Final affected navigation/header/sidebar/chat-link checks: 93 passed.
- Additional subject routing, all-subject EN/KO rendering and proof-guide checks: 37 passed, including 2 new all-subject cases added after the full run.
- TypeScript: passed. MCP package build: passed. Docker production build: passed. `git diff --check`: passed.
- Browser: computed headline uses the shared sans stack; desktop sidebar shows selected content. At 390px, landing docs links compute to `display: none` and directly opened chat docs have no horizontal page overflow.
- Docker browser: clicked the MCP/CLI CTA, confirmed a separate `/docs#login` tab with actual CLI and MCP setup instructions; the landing page stayed open.
- Docker helper selected default Colima, aarch64. Health check: 6/6 healthy.
- Logs: `../_workspace/docs-navigation-20260918/` in the parent workspace.

## Failures diagnosed and resolved

- A: removing the obsolete `agent` modal stage also narrowed two particle-animation unions; restored the independent `human | agent` animation types. TypeScript and the production build passed afterward.
- B: the Korean source scan flagged literal filename/API identifiers after moving the docs body into a shared component; added only the three exact non-translatable identifiers to the allowlist. Full suite passed afterward.
- B: the new missing-key regex confused adjacent English sentences (`proofs.A topic`) with a translation key; restricted it to the actual lowercase key convention. Both languages and all subjects passed afterward.

## Security finding at the 14:50 checkpoint

[Direct topic-join verification gap](proof-verification-gap-2026-09-18.md) was unfixed at this checkpoint; it has since been addressed in source (see the linked remediation status). Source inspection confirms the direct proof submission route does not cryptographically verify the supplied proof before writing verification state. The mobile relay flow has a separate verifier, which does not protect this direct route. Documentation now states this limitation. No forged requests were sent; no authentication or authorization runtime behavior was changed as part of this documentation/UI task.
