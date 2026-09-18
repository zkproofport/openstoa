# OpenStoa documentation and client synchronization

This is the maintenance checklist for API, CLI, MCP and user-flow changes.
The parent `.claude/agents/openstoa-dev.md` links here and requires this checklist.
**Single source of customer guidance: `/docs`.** Maintain usage prose only in the
page components and their EN/KO translations. Other entry points link to that page;
FAQ answers reuse its translations. Do not create a second detailed Markdown manual,
copy the CLI inventory into READMEs, or require rewriting all indexes for a behavior change.
OpenAPI remains the derived machine-readable API schema, not a separately authored guide.

## Entry points and their sources

| Served / reader-facing surface | Maintained source | Build behavior |
| --- | --- | --- |
| `/docs` with subject fragments | `src/app/docs/page.tsx`, `src/components/docs/*`, `src/lib/docs/navigation.ts`, `src/lib/docs/cliReference.ts` | Next.js page |
| Docs Korean / English | `src/lib/i18n/locales/docs.{ko,en}.json`, `proofs.{ko,en}.json` | Bundled translations |
| FAQ structured data and SEO | `src/app/layout.tsx`, `src/lib/docs/faq.ts` maps docs paragraphs; questions/SEO in `src/lib/i18n/locales/{ko,en}.json` | Production JSON-LD; no separate FAQ page currently |
| `/llms.txt` | `src/app/llms.txt/route.ts` | Concise H1/summary/H2 Markdown link lists, following llmstxt.org; production-only (404 locally) |
| CLI help and MCP tool descriptions | `packages/cli/src/cli.ts`, `packages/mcp/src/tools.ts`, shared `packages/sdk/src/rest/operations.ts` | Built into npm packages; verify every command/tool, defaults, limits, access and result meanings |
| Repository/package READMEs | Root, `packages/`, `packages/{sdk,commands,cli,mcp,channel}/README.md` | Installation/development information and links to `/docs`; no second usage manual |
| `/AGENTS.md` | `public/AGENTS.md` only; local `AGENTS.md` is a separate preserved development reference | Hand-maintained static navigation; generator never reads, creates, overwrites or copies it |
| `/SKILL.md` | `public/SKILL.md` | Static direct links to docs subjects; lowercase `/skill.md` is a rewrite; retired `/skills/*` URLs redirect directly to docs |
| `/api/docs/openapi.json` | Route `@openapi` comments and `src/lib/swagger.ts` | Generated `src/generated/openapi-spec.json` served by route |
| `/api/docs/proof-guide/{proofType}` and proof-required error guidance | `src/lib/proof-guides.ts` and proof-guide route JSDoc | Live JSON guide and shared requirement metadata |
| Developer context | Parent `.claude/agents/openstoa-dev.md` and this file | Hand-maintained checklist |
| Historical design, audit and changelog files | `docs/design/*`, dated reports/plans, CHANGELOG files | Preserve dated observations; add a current-doc pointer when easily mistaken for live instructions |

`contracts/README.md` is a contract-development guide; the standalone mobile README
is a simulator guide. Review them when that behavior changes, but do not imply the
simulator can generate a real mobile proof. Parent `docs/openstoa/README.md` is a
strategy entry point, not API authority. New documentation routes or FAQ pages must
be added to this inventory and the cross-surface regression test.

## API added or changed

1. Verify the actual handler, request/response fields, validation, error/status codes,
   authentication, capabilities, membership/role rules, side effects and privacy.
2. Update route `@openapi` JSDoc and `src/lib/swagger.ts` schemas. Explain units,
   limits, enums, examples and prerequisites. Keep schema documentation linked to `/docs`; do not add sub-skill references.
3. Review `packages/sdk/src/rest/{openStoaClient,types,operations}.ts` and shared
   `packages/api-types/src/index.ts`. Every agent-facing operation must have a typed
   SDK path. Registry-backed operations drive both generic CLI and MCP adapters.
4. Update `packages/commands/src/commands.ts` and domain workflows when needed.
   Update explicit `packages/cli/src/cli.ts` and `packages/mcp/src/tools.ts` together;
   compare parameter names, required/optional flags, enum values, output and errors.
   Internal device/crypto/owner-only endpoints need an explicit availability decision;
   do not expose them indiscriminately or imply an API key can manage keys.
5. Update affected `/docs` subjects and both translations, the CLI reference, and
   machine-facing proof-guide metadata. FAQ answers derive from docs paragraphs.
   Only update llms, served AGENTS, README and static SKILL links when navigation
   changes; do not duplicate the new usage instructions in those entry points.
6. Add meaningful tests: server validation/authorization; SDK request shape;
   commands behavior; CLI/MCP schema and operation parity; documentation inventory;
   real local HTTP/CLI/stdio E2E for changed workflows. For proofs, distinguish a
   real cryptographic result from a mocked verifier or pending relay result.

## API removed, renamed or disabled

- Remove/update route specs, schema references, SDK registry/methods/types, command
  core, CLI leaves/flags and MCP tools in the same change. If compatibility keeps
  an operation, mark it unavailable and document its actual response.
- Remove stale examples, README promises, FAQ/llms links, docs entries and skills.
  Search old endpoint, tool name, CLI spelling and obsolete fields across sources.
- Run the OpenAPI generator. Verify removed operations are absent from the schema,
  unless deliberately retained and marked deprecated/unavailable. Never recreate
  the retired public skills tree or generate a separate endpoint Markdown manual.
- Preserve historical release notes as history, with dates and current-doc pointers.

## Proof/auth/privacy changes

Review both authentication and topic-proof flows. Owner-issued API keys, app QR,
AI device authorization, KYC enrollment prerequisites, account scope, consent,
status/resume/cancel, expiry, local keys and public/private archive differences must
agree everywhere. Never claim employment from an email-domain proof, total absence
of metadata, a fixed external price/uptime, or completed cryptographic E2E without evidence.

## Generation and verification

Documentation review is part of development, before the deployment request.
A full synchronization audit covers existing functionality as well as changed
features: docs EN/KO, SDK/package READMEs, every CLI help page, MCP tool descriptions,
OpenAPI, public SKILL/AGENTS/llms and FAQ. Record the inventoried surfaces and
compare descriptions with implementation; rendering or link checks alone are
not evidence of factual agreement. Keep local developer AGENTS separate.
For each behavior fix, compare the affected `/docs` prose/examples with the
handler and CLI/MCP output. Update both languages if the contract changes. A
fix that restores the already documented behavior needs regression coverage,
not a second usage manual. Internal image/build/proxy fixes belong in
[the release verification guide](releasing.md#server-and-client-release-verification).
Check the actual public login origin and guest/private visibility in live
verification; successful page rendering alone does not prove factual accuracy.

Run from the OpenStoa repository with Node 22:

```bash
npm run generate:openapi
npx vitest run src/__tests__/documentationSurfaces.test.ts src/__tests__/docsCliReference.test.ts src/__tests__/docsNavigation.test.tsx src/__tests__/docsServerRendering.test.tsx src/__tests__/docsI18n.test.tsx src/__tests__/proofGuide.test.tsx src/__tests__/proof-guides.test.ts src/__tests__/agentsCanLearnAboutTheSpace.test.ts src/__tests__/anonNicknameIsNotAGate.test.ts --maxWorkers=4
npx tsc --noEmit
```

Run affected package typechecks/tests and build in dependency order:
SDK → commands → CLI/MCP. Do not rebuild dist while subprocess E2E is running.
For API/client behavior changes, rebuild the local stack from the parent with
`./scripts/dev.sh`, then run the CLI/MCP local E2E using `E2E_BASE_URL=http://localhost:3200`.
Use `./scripts/dev-health.sh` to verify the default Colima VM when applicable.

`npm run build` runs the generator via `prebuild`; both Dockerfiles invoke that
build and copy `public` into the runtime image. `.dockerignore` must include
`!public/AGENTS.md` and `!public/SKILL.md` despite the general Markdown exclusion. Local `AGENTS.md` is
preserved developer context: never truncate it, mirror it to the public index, or
use it as a customer-doc generator input. Neither AGENTS file is generated or copied.
Only `src/generated/openapi-spec.json` is generated, by `scripts/generate-openapi.ts`.
The old `generate:skill` command is a compatibility alias for that generator; it
never rewrites public indexes or creates sub-skills. API endpoint schemas remain
in OpenAPI, not separate SKILL files.

Inspect actual served `/docs?topic=login`, `/docs?topic=commands`, `/AGENTS.md`,
`/SKILL.md`, OpenAPI and proof-guide output. Query topic links render the selected
article on the server, so an agent does not need browser JavaScript to read it;
existing hash links continue to work in browsers. Test llms/FAQ production conditions
without changing the local stack to production. Do not publish a separately maintained
Markdown guide merely to satisfy llms.txt: Markdown targets are recommended, not
required. Any future text export must derive from the same docs content.
Generating docs/building packages does not publish npm or deploy production.


## Per-key authorization changes

Login sessions establish identity; `X-OpenStoa-API-Key` selects authorization.
Agent business requests require both, with matching ownership and a live key.
The runtime route/method policy is `packages/sdk/src/rest/authorizationPolicies.ts`.
Every handler calls `src/lib/apiAuthorization.ts` before executing. SDK operation
metadata, OpenAPI and the `/docs?topic=rest#rest` permission table derive from it.

When permissions change, update EN/KO web/mobile capability labels and explicit
CLI multi-request dependencies; test valid/empty/unrelated/changed/revoked keys,
key-only and session-only requests, owner mismatch, selected human keys and
historyGrant limits. `apiAuthorization.test.ts` inventories all route methods
and fails for missing registrations or missing first-statement guards. New scopes
are never automatically granted to existing keys; the owner must opt in.
