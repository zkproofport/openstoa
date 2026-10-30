# Changelog

## [0.3.0](https://github.com/zkproofport/openstoa/compare/openstoa-commands-v0.2.2...openstoa-commands-v0.3.0) (2026-10-30)


### ⚠ BREAKING CHANGES

* **proof:** verify Coinbase KYC v2 and Android signer proofs (core 0.4.0-beta.1)

### Features

* **commands:** expect Coinbase Country v2 (215 public inputs) ([c2282f4](https://github.com/zkproofport/openstoa/commit/c2282f43b88db36d7bc9cdca17b0dcfa214136d4))
* **proof:** verify Coinbase KYC v2 and Android signer proofs (core 0.4.0-beta.1) ([ce5df6e](https://github.com/zkproofport/openstoa/commit/ce5df6eedbf97ce81a07581acd39614713735472))
* **proof:** verify OIDC v2 proofs against their relay request (core 0.3.0) ([c97c792](https://github.com/zkproofport/openstoa/commit/c97c792ab4bab85d2f05b0edc7218bd6a5eb1051))


### Bug Fixes

* **commands:** carry signerVariant with every CLI/MCP topic proof ([2e38ac5](https://github.com/zkproofport/openstoa/commit/2e38ac5fc2c0a6490075e918f23bb6ef12f1c97d))
* **commands:** prove Coinbase KYC v2 with @zkproofport-ai/mcp 0.4.4 ([0902202](https://github.com/zkproofport/openstoa/commit/0902202f796f323276f10fd86da26c09f2d75c4c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @masselabs/openstoa bumped from ^0.2.2 to ^0.2.3

## [0.2.2](https://github.com/zkproofport/openstoa/compare/openstoa-commands-v0.2.1...openstoa-commands-v0.2.2) (2026-09-20)


### Bug Fixes

* complete proof login, permission key setup and human CLI output ([#9](https://github.com/zkproofport/openstoa/issues/9)) ([38fa43d](https://github.com/zkproofport/openstoa/commit/38fa43d2b8c521b925f72e5c2facc1920a6b05a2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @masselabs/openstoa bumped from ^0.2.1 to ^0.2.2

## [0.2.1](https://github.com/zkproofport/openstoa/compare/openstoa-commands-v0.2.0...openstoa-commands-v0.2.1) (2026-09-18)


### Bug Fixes

* synchronize all public guides and client help with current contracts ([a9f67e5](https://github.com/zkproofport/openstoa/commit/a9f67e5e8ffda4c641a9ae6bb1ba86d400096265))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @masselabs/openstoa bumped from ^0.2.0 to ^0.2.1

## [0.2.0](https://github.com/zkproofport/openstoa/compare/openstoa-commands-v0.1.2...openstoa-commands-v0.2.0) (2026-09-18)


### ⚠ BREAKING CHANGES

* unify proof login, scoped authorization, and canonical docs

### Features

* **chat:** reclaim delivered ciphertext, encrypt media, and close the key-management hole ([5f204f8](https://github.com/zkproofport/openstoa/commit/5f204f8e6ed15757f836f5d1ccfcef295ade2e21))
* unify proof login, scoped authorization, and canonical docs ([092aa20](https://github.com/zkproofport/openstoa/commit/092aa202b99e8c2ad87c6b962e290802f0791076))
* **web,cli:** chat rail fixes, web i18n, and API-key-scoped AI capability ([c8603db](https://github.com/zkproofport/openstoa/commit/c8603db0162edf000ebb4565dbc2ce552a473544))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @masselabs/openstoa bumped from ^0.1.2 to ^0.2.0

## [0.1.2](https://github.com/zkproofport/openstoa/compare/openstoa-commands-v0.1.1...openstoa-commands-v0.1.2) (2026-07-28)


### Bug Fixes

* **packages:** add missing READMEs so npm pages are not empty ([4af6e3f](https://github.com/zkproofport/openstoa/commit/4af6e3fc06b392cc2e58a4b8be679677c74cb402))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @masselabs/openstoa bumped from ^0.1.1 to ^0.1.2

## [0.1.1](https://github.com/zkproofport/openstoa/compare/openstoa-commands-v0.1.0...openstoa-commands-v0.1.1) (2026-07-28)


### Features

* **ai:** profile-level AI permissions + scoped API keys (replaces per-topic ai_grants); CLI/MCP key auth ([585df5b](https://github.com/zkproofport/openstoa/commit/585df5b6434409408fef4312913559aede6a370d))
* **auth:** restore Google device-flow login in CLI/MCP; hide dev-login ([e45289e](https://github.com/zkproofport/openstoa/commit/e45289eab84feee14d5217a6da7895a98787d7f3))
* **cli,mcp:** openstoa-cli + MCP on @masselabs/openstoa via shared packages/commands (E2EE chat parity) ([fa01fa6](https://github.com/zkproofport/openstoa/commit/fa01fa6aa2414a976a9f830332d9bcd9e3e7bbe4))
* **dm:** 1:1 direct chat as hidden 2-member MLS topic (kind=dm) ([94da25c](https://github.com/zkproofport/openstoa/commit/94da25ccb06eb6a03a05b5d63c73e37024c93ff5))


### Bug Fixes

* **packages:** declare noble crypto deps, fix bin entrypoint, make packages publishable ([7f003cd](https://github.com/zkproofport/openstoa/commit/7f003cd51606129cee386ca782c54ae8b4c734d1))


### Refactoring

* **auth:** make CLI/MCP API-key only; disable device-flow login (prover offline) ([17af44b](https://github.com/zkproofport/openstoa/commit/17af44b9d5c08a0b9de57bb62b9051ad388155c6))
* **mcp:** unify to local @masselabs/openstoa MCP+CLI; remove hosted /mcp (src/lib/mcp) ([bb56c3c](https://github.com/zkproofport/openstoa/commit/bb56c3c723c0b65caf2a68cba1bf4dd1b8c81f3a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @masselabs/openstoa bumped from ^0.1.0 to ^0.1.1
