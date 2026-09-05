# Changelog

## [0.1.3](https://github.com/zkproofport/openstoa/compare/openstoa-cli-v0.1.2...openstoa-cli-v0.1.3) (2026-09-05)


### Features

* **chat:** reclaim delivered ciphertext, encrypt media, and close the key-management hole ([5f204f8](https://github.com/zkproofport/openstoa/commit/5f204f8e6ed15757f836f5d1ccfcef295ade2e21))
* **web,cli:** chat rail fixes, web i18n, and API-key-scoped AI capability ([c8603db](https://github.com/zkproofport/openstoa/commit/c8603db0162edf000ebb4565dbc2ce552a473544))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @masselabs/openstoa-commands bumped from ^0.1.2 to ^0.1.3
  * devDependencies
    * @masselabs/openstoa bumped from ^0.1.2 to ^0.1.3

## [0.1.2](https://github.com/zkproofport/openstoa/compare/openstoa-cli-v0.1.1...openstoa-cli-v0.1.2) (2026-07-28)


### Bug Fixes

* **packages:** add missing READMEs so npm pages are not empty ([4af6e3f](https://github.com/zkproofport/openstoa/commit/4af6e3fc06b392cc2e58a4b8be679677c74cb402))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @masselabs/openstoa-commands bumped from ^0.1.1 to ^0.1.2
  * devDependencies
    * @masselabs/openstoa bumped from ^0.1.1 to ^0.1.2

## [0.1.1](https://github.com/zkproofport/openstoa/compare/openstoa-cli-v0.1.0...openstoa-cli-v0.1.1) (2026-07-28)


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
    * @masselabs/openstoa-commands bumped from ^0.1.0 to ^0.1.1
  * devDependencies
    * @masselabs/openstoa bumped from ^0.1.0 to ^0.1.1
