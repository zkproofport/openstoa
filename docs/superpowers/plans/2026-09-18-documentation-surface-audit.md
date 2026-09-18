# Documentation Surface Audit Implementation Plan

**Goal:** Every current OpenStoa documentation entry point accurately describes authentication, topic-proof continuation, privacy and available commands.

**Architecture:** `/docs` is the single customer usage source. FAQ answers reuse its translations. README usage, llms, public AGENTS and guide skills link to docs. Local AGENTS retains developer context and is not served or read by the generator. OpenAPI and endpoint references derive from route schemas. No separate detailed Markdown guide is maintained.

**Constraints:** Preserve working changes, no commit/publish/remote deployment. No fixed external service price or uptime claim without current evidence. Do not promise successful cryptographic E2E. Keep llms production-only behavior. Use Node22 and default-Colima Docker helpers.

- [x] Inventory all current docs routes, metadata FAQ, root/package READMEs, API guides, generated skills, parent OpenStoa references and historical reports.
- [x] QA reproduces cross-surface contradictions before edits: self-issued keys, active ASK, manual-only proof, privacy overclaim, stale links/availability.
- [x] Update current sources, FAQ EN/KO, guided proof metadata, README discovery links and historical pointers.
- [x] Regenerate skills/OpenAPI without reading or writing either AGENTS file; verify docs/navigation/translations/schema contracts and types.
- [x] Rebuild local Docker and read actual docs/guide/discovery endpoints; record production-only llms/FAQ behavior separately.

## Edge matrix

Production/staging/development/unset llms visibility; text encoding; EN/KO parity; owner vs API-key permissions; proof-none vs gated; app vs AI; consent and cancellation; no private key in examples; external cost/availability uncertainty; public vs private archive privacy; supported proof enums; valid documentation links, server-readable topic articles, FAQ/docs reuse, and static AGENTS preservation. No changes to proof authorization or endpoint authentication behavior.

User clarification: keep public/AGENTS.md as a static docs index. Remove all AGENTS read/write/copy logic from generation and allow the static file in Docker context.

Final clarification: local development AGENTS remains intact; only public/AGENTS is a static index. Docs is the customer authority; llms follows the published discovery format, and no second detailed text reference is retained.
