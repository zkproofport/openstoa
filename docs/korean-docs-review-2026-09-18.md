# Korean agent guide review — 2026-09-18

Scope: all 63 existing Korean strings in `src/lib/i18n/locales/docs.ko.json`, their rendered composition in `/docs`, and descriptive text inside code examples. Command names, environment variables, JSON properties, API paths, and product names remain technical identifiers. Existing working-tree edits are preserved.

## Checks planned before editing

| Case | Verification |
| --- | --- |
| Both locales, full page | Render with the existing React DOM test; switch locale and inspect headings, reference links, sample text, and unresolved template slots. |
| Inline rich-text slots, Korean particles, missing/empty copy | Existing dictionary parity and slot parity test; manually read composed sentences. |
| Shell syntax, quotes, backslashes, UTF-8, embedded JSON | Compare executable samples between locales after removing localized comments and normalizing the explicitly localized sample values. |
| Account login vs KYC, owner vs agent credentials | Verify against auth and API-key management source; clearly distinguish account access from identity verification. |
| Badge visibility and expiry | Verify against `src/lib/verification-cache.ts`; describe active badges, default visibility, separate toggles, and durable explicit preferences. |
| Invalid input limits, races, external services, contract calls | N/A: this change edits explanatory copy and static samples, not runtime input or service behavior. Existing API tests cover those implementations. |
| Browser/server integration | Parent task handles live browser review. This scoped verification is a full React DOM render, not a live-service E2E test. |

## Source facts

- `src/app/api/profile/api-keys/route.ts` calls `requireNonApiKeySession` before key creation or listing. The same restriction applies to key updates and revocation. An agent's API key cannot manage itself or another key; owners use a signed-in session.
- `src/lib/verification-cache.ts` keeps verification expiry separate from badge visibility preferences. Active enabled badges are public regardless of a topic's proof requirement.
- `packages/mls/src/chatTierPolicy.ts` permits the server to retain public-topic archive keys; private, secret, and DM archive keys are not held by the server.
- `src/app/api/posts/[postId]/route.ts` locks edits after on-chain recording and rejects removing a poll after votes exist.

## Factual corrections in human documentation

- `README.md:5–7`: “Prove your identity” overstates Google account verification. Distinguish control of an account from Coinbase KYC.
- `README.md:37–40` and `README.md:302`: “never holds a message key” / “server sees ciphertext only” needs the public-topic archive exception.
- `README.md:85–89`: says an authenticated agent can create additional keys. API-key-authenticated callers receive 403; the owner must manage keys from a session.
- `docs/openstoa-dev.md:38–39`, `:327`, `:354`: Coinbase KYC login, one-person-one-account, and impossible re-registration claims describe a design that does not match Google-account login. Mark this document as historical or rewrite those claims before treating it as current product documentation.

The parent task expanded ownership to `README.md` and `docs/openstoa-dev.md`; those corrections are now applied. The historical document also no longer labels its obsolete login recipe or proposed MCP tool names as current behavior. Canonical `AGENTS.md` was subsequently added to the authorized scope; its current corrections are listed below.

## Korean review results

The initial pass read all **63 existing entries**: **44 rewritten, 19 retained**. It added **24 localized code comments and sample values**, for **87 entries** in each docs dictionary at that checkpoint. The expanded CLI pass also renamed the former Step 4 reference heading: the final original-entry count is **45 rewritten, 18 retained**. Identifiers such as `proofType`, `OPENSTOA_API_KEY`, JSON keys, package names, endpoint paths, and proof-system names intentionally remain unchanged.

The rewrite removes sentence fragments caused by interpolating a complete sentence into another sentence, uses 게시물 consistently, and distinguishes account access from KYC. It also explains owner-issued credentials, each badge’s visibility setting, visibility preferences surviving expiry, approval/invitation conditions independent of proof requirements, and poll-edit restrictions after votes exist.

The guide now defines `BASE`, `OPENSTOA_API_KEY`, and `AUTH` before its raw REST examples. CLI examples use the implemented `topics list`, `post create`, and `chat join` subcommands. Production URLs use `www` as instructed by the canonical guide.

## Verification

Node **v22.23.2**, Vitest **3.2.4**: `src/__tests__/docsI18n.test.tsx` — **2 tests passed**, observed **2026-09-18 13:54:39 KST**. No failed or skipped tests.

- Dictionary test covers nonempty values, identical keys, and rich-text slot parity across all 87 entries.
- Full-page locale-switch test covers Korean headings and prose, all 24 localized sample strings, unchanged executable sample structure after normalizing those strings, preserved links, resolved template slots, and explicit REST auth setup.
- Scoped `git diff --check` passed. No build, live service E2E, deployment, Docker operation, or commit was performed by this scoped task.

The parent task performs browser layout review. These focused tests verify the full React DOM content and locale switching, not live API availability.

## Package-guide corrections

A targeted review of human-facing package guides found the same factual drift:

- `packages/cli/README.md`: “CLI can mint more itself” and the API-key command table need the owner-session requirement.
- `packages/mcp/README.md`: “agent can mint more keys itself” is incorrect for API-key authentication; the privacy section omits server-held public-topic archive keys.
- `packages/sdk/README.md`: key-management example follows an API-key-authenticated client without explaining that a session JWT is required; introductory and privacy-model text claim the server never holds keys.
- `packages/channel/README.md`: server-blind claims omit public-topic archives; key creation points to an outdated “Profile → AI permissions” label and needs the owner-session requirement.

All four package guides above are now corrected under expanded ownership. CLI and MCP key-management tables explicitly require an owner session; the SDK example constructs a separate client with a checked owner-session JWT. The MCP table now includes the implemented `openstoa_apikey_update` tool and its required replacement-scope fields. Channel transport checks are no longer presented as proof that public archives are unreadable by the service.

Command names and required arguments were checked against `packages/cli/src/cli.ts`, `packages/mcp/src/tools.ts`, and `packages/sdk/src/rest/openStoaClient.ts`. No credential or API operation was executed. The four package changes are documentation-only; no additional runtime test was introduced.

The root README and historical Korean design note were also corrected here. `packages/README.md`, `packages/commands/README.md`, `contracts/README.md`, `packages/mobile/examples/standalone/README.md`, and `docs/releasing.md` were scanned for the same identity/authentication/privacy claims; no matching additional contradiction was identified in that scan. This is a targeted product-fact audit, not a line-by-line validation of build, release, or contract instructions.

## Expanded CLI reference — verification matrix

The expanded task makes API-key CLI reading, posting, and encrypted chat the primary guide. Every registered CLI leaf must be classified; a new leaf or option without matching documentation must fail the inventory check. API-key operations, local state commands, owner-session key management, unavailable Google login, and non-production-only test login are distinguished.

| Case | Planned verification |
| --- | --- |
| New/removed CLI leaf, nested group, fluent registration | TypeScript AST inventory compared with reference entries; generated registry leaves included separately. |
| New public flag or required argument | Reference usage checked against actual registered arguments and options. |
| Locale coverage, UTF-8, literal command tokens | Both dictionaries contain every reference key; full-page rendering verifies resolved content and identical command syntax. |
| Scoped key vs owner session | Each command has access classification and actual guarded cmd requirements; owner commands are separated from normal workflows. |
| Chat restart, new device, missing key, history denied | Explain persistent vault, archive access grant, key delivery and unreadable rows; avoid claiming a key grants unavailable history. |
| Pending membership, proof conditions, owner-only data actions | Reference distinguishes membership approval, proof conditions, topic ownership and account credential ownership. |
| Network/API execution | Delegated to CLI/API and local CLI verification agents; this docs task does not execute writes or live credentials. |


## Expanded reference result

The `/docs` primary path now starts with API-key CLI workflows: account checks,
topic discovery, cross-topic feed search, per-topic posts/comments, bookmarks and
activity, joining/publishing, chat read/reply/media, DM, explicit archive reads,
and sharing locally held archive keys. The previous proof-login recipe is a
collapsed, clearly unavailable reference section; REST examples remain secondary.

The complete reference covers **84 CLI leaves**: **37 explicit declarations** plus
**47 entries in the shared browser-safe REST operation registry**. Of these,
**77 are API-key operations**, **1 manages local state**, and **5 require an owner
session** (session-token adoption plus four API-key management commands), and **1 is unavailable** (`ask`, always503). Disabled
bare/Google login and hidden development-only flags are described separately.
Each entry has Korean and English prose, exact arguments/options, and actual cmd
guards; route-level membership/authorship/role checks still apply. The docs locale
dictionaries now contain **212 entries each**, compared with the original 63.

`src/lib/docs/cliReference.ts` consumes the same REST registry as CLI/MCP/SDK.
`src/__tests__/docsCliReference.test.ts` parses actual Commander declarations with
the TypeScript AST, including fluent public `Option` registrations, and checks
exact leaves, positional arguments, public flags, global options, generated
operation translations, access classification, and the CLI README inventory.
The page render test confirms every command row renders and verifies localized
examples without changing command syntax. The new tests are contract checks,
not tests that simply assert a rewritten sentence equals itself.

The privacy section describes mobile/CLI/MCP client-side MLS encryption,
ciphertext versus routing metadata, API credentials versus decryption keys,
persistent local state, and the public-topic archive exception. `historyGrant`
is explicitly an access limit, not key recovery or extended retention. The schema
has no API-key expiry column; the guide now correctly says keys remain valid until
revoked. `recorded` is distinguished from `activity recorded`: the former includes
posts recorded by anyone in joined topics.

### Failures encountered and resolved

- `docsCliReference.test.ts:53` (A): the runtime agent added chat history,
  DM history, and share-keys after the initial inventory. The completeness test
  caught all three; entries and bilingual descriptions were added.
- `docsI18n.test.tsx:84` (B): normalizing the short Korean greeting before the
  longer DM example left a partially translated string. Normalize longest values
  first; executable-example parity now passes.
- CLI README inventory check (A): adding feed sort `active` changed the shared
  registry usage. Regenerated the README inventory and updated both descriptions.

Latest focused verification at **2026-09-18 14:15:05 KST**: **5/5 tests passed**
across docsI18n and docsCliReference. Scoped whitespace checks passed. API/CLI
runtime behavior and Docker/browser validation belong to the coordinating agents;
this report does not count a documentation render as a live E2E chat test.


Final scope notes: `chat share-keys` has no standalone command capability, but
private/secret history sharing reads archive rows and therefore requires
`/openstoa/chat/read` plus an applicable historyGrant. Explicitly sharing locally
held keys can give current members additional history; the docs do not promise
that it preserves an original invite's history boundary. Account recovery,
WebAuthn, backup/device challenges and internal crypto transports are identified
as separate security flows rather than invented agent CLI commands.

Final source files added by this docs expansion:
`src/components/docs/CliGuide.tsx`, `src/lib/docs/cliReference.ts`, and
`src/__tests__/docsCliReference.test.ts`. The runtime operation registry is owned
by the CLI/API implementation agent; the docs consume it directly.


## Canonical and generated machine documentation

The final authorized pass corrected `AGENTS.md` and the generator’s hand-written
summaries: owner-only API-key management, account-control versus KYC, durable
badge visibility, public archives versus private/secret/DM encryption, routing
metadata, mobile human chat versus local CLI/MCP, 30-day verification caching,
optional nickname changes and invite expiry, legacy approval queues, and disabled ASK/Google login.
The complete 84-command table is also present in the canonical guide and its
CLI-reference sub-skill. Published npm versions are explicitly distinguished
from the current repository build; no package release is claimed.

Both ASK route OpenAPI comments now describe their actual unconditional JSON
503 response, rather than a working LLM answer/SSE stream. Runtime code was not
changed. The generator refreshed `public/AGENTS.md`, `public/SKILL.md`, 118
sub-skills, and the OpenAPI snapshot. The contract test checks exact canonical
copy parity, every command in the generated CLI skill, full workflow propagation,
registry availability classification, and disabled ASK OpenAPI response schemas.

An independent registry-to-route review found and coordinated four corrections:
join-request status is `pending|all`; ASK is unavailable rather than conditionally
available; topic deletion requires owner/site admin; public-topic invites allow
any member while private/secret invites require owner/admin. The final upload
cleanup operation (`upload-delete --urls`) is included, as is `--poll null`.
