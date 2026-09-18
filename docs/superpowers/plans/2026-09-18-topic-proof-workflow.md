# Topic proof workflow implementation plan

**Goal:** A topic create/join/invite request that needs proof guides the caller through consent, app or AI proof generation, then resumes the original action.

**Architecture:** Shared commands-core workflow and owner-only local operation store; CLI and MCP are adapters. App mode uses the existing authenticated proof-request and verified proof-only poll routes backed by the published app SDK. AI mode spawns the installed published prove CLI with arguments, never a shell. No keys or login tokens in operation files or browser URLs.

**Global constraints:** No commits, npm publishing, remote deployment, automatic payment or credentials invented for E2E. Local Docker uses repository scripts/default Colima. The user explicitly requested implementation and E2E; proceed within that scope without another approval round.

- [x] Core: reproduce missing structured guidance; add strict supported requirement parsing, expiring operation records, credential/base URL binding, locks, cancellation and at-most-once continuation. Capture missing/invalid proof only, not permission or unrelated validation failures.
- [x] App: public `/proof#<base64url metadata>` page renders QR/deep link; no auth tokens, analytics fragments or login-mode polling. Test bad/oversized payload, circuit/scope/request mismatch, timeout/cancellation/status.
- [x] AI: explicit consent before subprocess; Google/Microsoft URL/code, KYC/country env-only signer input; bounded buffers/deadlines/cancel and fixed actionable errors; no raw secrets in outputs.
- [x] Adapters: ordinary create/join/invite interception; TTY consent; structured nonTTY/MCP states; explicit continue/status/resume/cancel. App operations survive process restart. AI waits in CLI process; interrupted AI processes require a new explicitly approved attempt.
- [x] Docs: full command inventory, human/agent workflows, EN/KO, live-vs-mocked E2E distinction.
- [ ] Validation: focused red/green boundaries, package types/builds, real local CLI/MCP absent-proof and real relay-request/pending/cancel; UI QR check. Successful cryptographic E2E requires a human/app or authorized real prover credentials; never count fake proofs as real success.

## Edge cases before implementation

Missing proof and invalid proof; stale cache; unknown circuit/provider; generic workspace provider choice; country inclusion list; declined consent; missing key env; unsupported remote payment; expired/cancelled/rejected request; different token or base URL; process restart; concurrent resume; transport ambiguity after mutation; original action input preservation; nonTTY JSON without hanging; stderr device prompts without secrets; malformed/oversized fragment; no invitation bypass; UTF-8 topic text; private keys absent from argv/disk/logs.

## Validation observations

- Full regression run (Node 22, 2026-09-18 16:14–16:15 KST): 6,323 passed, 84 skipped.
- Current package builds and web typecheck passed; default Colima aarch64 Docker rebuild completed, all six services healthy.
- Independent core and adapter review completed; discovered persistence/credential race, stale-lock race and JSON browser-launch behavior fixed and regression-tested.
- Live browser inspection: actual pending relay request rendered QR and app link, Korean/English and stopped-monitoring guidance; temporary data cleaned up.
- Final local agent workflows: CLI 18/18 (including 3 MLS round-trip cases) and MCP 17/17, including all 88 commands/tools and pending/resume/cancel.
- Cryptographic success remains an explicit external validation gap: no genuine user-approved app proof or real attested-wallet prover run was available. Do not mark the last validation checkbox complete on the basis of mocked proofs.
