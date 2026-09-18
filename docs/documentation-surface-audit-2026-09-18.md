# OpenStoa documentation surface audit — 2026-09-18

## Final documentation ownership

The customer usage source is the `/docs` page. Its components, CLI inventory and
EN/KO docs/proof translations are the only maintained detailed usage guide.

- `/llms.txt` is a concise Markdown discovery index (project H1, blockquote, H2
  lists of descriptive links), following the proposal at https://llmstxt.org/.
- `public/AGENTS.md` is a static docs index. Local repository `AGENTS.md` retains
  its full development reference and is not a build input or published copy.
- The mistakenly introduced `docs/agent-reference.md` and public copy were removed.
- README installation/development material remains; detailed CLI/MCP instructions
  and duplicated command inventories point to docs instead.
- FAQ questions remain localized metadata; answers derive from existing docs
  paragraphs through `src/lib/docs/faq.ts` and link to their source article.
- Guide skills link to docs; endpoint schemas/skills remain generated from OpenAPI.
  Generation does not read, write or copy either AGENTS file.
- `/docs?topic=<id>` renders the requested article in the initial server HTML,
  allowing agents to read it without JavaScript. Existing hash links still work.
- The maintenance checklist and openstoa-dev context now require updating docs
  once, keeping API/SDK/commands/CLI/MCP synchronized, and updating discovery links
  only when navigation changes. No parallel detailed Markdown manual is maintained.

The earlier intermediate implementation below had moved the long reference and
truncated local AGENTS. That approach was superseded by the ownership above.
Earlier measurements are preserved as dated observations, not final-build evidence.

## Earlier verification (before the single-source correction)

- At 16:51 KST, full Node22 regression suite: 6,349 passed, 84 skipped.
- After the explicit static-AGENTS correction, focused docs/navigation/translation/proof/privacy/source-generation checks at 16:54 KST: 90 passed across 9 files; web typecheck passed.
- Red cases reproduced missing workflow metadata, README discovery, FAQ guidance and old full-manual AGENTS layout. Corrected sources and regenerated the appropriate artifacts.
- Generator tests capture filesystem mutations in an isolated child: no AGENTS input/read/copy/output, and only intended public/generated output locations. Docker inclusion rules and source/served reference equality are guarded.
- Existing skipped suites: removed browser chat surfaces, external-chain tests without RPC configuration, and disabled interactive-login test. These are not cryptographic proof-completion coverage.
- No npm publication, production deployment, payment or live external proof generation was performed in this documentation change.

At 16:55 KST, the rebuilt default-Colima aarch64 stack reported all 6 services
healthy. Actual HTTP checks passed for `/docs`, the 14-line static `/AGENTS.md`,
`/docs/agent-reference.md` (byte-equal to source), `/SKILL.md`, OpenAPI and all
5 proof-guide variants. OpenAPI and guide JSON expose the new continuation fields.
Local `/llms.txt` returned the intended 404; production200/text/ownership/privacy
content and non-production404 are tested directly against the actual route handler.
FAQ is production-only JSON-LD; bilingual keys and layout registration are tested.
HTTP observations: parent `_workspace/docs-live-http-final.json`.

## Final single-source verification — 17:12 KST

- Node22 full regression at 17:11 KST: **6,363 passed, 84 skipped** (368 passing
  test files, 5 skipped). Typecheck and final Docker production build passed.
- Dedicated initial-HTML tests cover all 11 subjects and invalid topic queries;
  browser tests preserve old hash deep links and navigation behavior.
- Actual HTTP at **17:12:44 KST**: all 11 subjects in both EN and KO returned200
  with the requested article in server HTML; command pages contained all88 entries.
  All docs navigation links preserve server-readable query selection.
- Served AGENTS bytes match the static source; local development AGENTS remains
  2,940 lines, public index13 lines. Actual generation preserves both file hashes.
- Served SKILL, topic-proof guide navigation and OpenAPI returned200. The removed
  duplicate detailed text reference returned404. Local llms returned its intended404;
  direct route tests separately verify production200 and the discovery-list format.
- Default Colima aarch64 stack:6/6 services healthy. No npm release or production
  deployment was performed. This docs verification does not establish live
  cryptographic proof completion.
- Evidence: parent `_workspace/docs-canonical-full-tests-final.log`,
  `_workspace/docs-canonical-docker-final.log`, `_workspace/docs-canonical-live-http.json`.
