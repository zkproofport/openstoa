# CLI/MCP proof login implementation plan

Goal: fulfill the requested proof-to-login workflow; current topic-only continuation
and disabled bare login do not meet that requirement.

Architecture: app-based login gets a short-lived server record with a SHA256
client verifier binding. Browser approval is a separate secret in the fragment.
The server verifies Google OIDC/community scope before issuing a session to the
requesting CLI/MCP; browser completion sets its own cookie and follows only an
approved same-origin redirect_url. Tokens never travel in URLs or MCP output.
AI Google device proving uses the existing local prover adapter and auth verifier;
external failure is reported per attempt, not a blanket disabled feature.
API401 carries login guidance; topic402 remains separate proof-required guidance.

- [x] QA captures disabled login and missing continuation contracts (red).
- [x] Add bound app-login service/routes, validation, cancellation and expiry.
- [x] Add shared login state persistence, app/AI methods, CLI and MCP controls.
- [x] Add browser approval/QR/completion and same-origin redirect behavior.
- [x] Replace docs login warning with executable app/AI/API-key paths in EN/KO;
      update CLI inventory/OpenAPI and context, retain docs as the only usage source.
- [x] Run adversarial/positive state tests, package parity/types/full regressions;
      rebuild Docker and run HTTP/CLI/MCP E2E. Report real external proof limits.

No commits or remote deployment. Preserve all earlier uncommitted changes.


Authorization extension: login identifies the account; a selected owner-bound API
key authorizes agent business operations. Multiple keys retain independent scopes
and history grants. All 135 route handlers enforce the shared policy before work.
The SDK, OpenAPI and docs permission table derive from the same policy catalogue.
Real external cryptographic proof completion was not performed: unit tests cover
verified completion; live tests cover pending relay, refusals, cancellation, scoped
business operations and CLI/MCP parity. This limitation is reported explicitly.
