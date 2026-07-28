# Changelog

## [0.1.2](https://github.com/zkproofport/openstoa/compare/openstoa-sdk-v0.1.1...openstoa-sdk-v0.1.2) (2026-07-28)


### Bug Fixes

* **packages:** add missing READMEs so npm pages are not empty ([4af6e3f](https://github.com/zkproofport/openstoa/commit/4af6e3fc06b392cc2e58a4b8be679677c74cb402))

## [0.1.1](https://github.com/zkproofport/openstoa/compare/openstoa-sdk-v0.1.0...openstoa-sdk-v0.1.1) (2026-07-28)


### Features

* **ai:** profile-level AI permissions + scoped API keys (replaces per-topic ai_grants); CLI/MCP key auth ([585df5b](https://github.com/zkproofport/openstoa/commit/585df5b6434409408fef4312913559aede6a370d))
* **dm:** 1:1 direct chat as hidden 2-member MLS topic (kind=dm) ([94da25c](https://github.com/zkproofport/openstoa/commit/94da25ccb06eb6a03a05b5d63c73e37024c93ff5))
* **sdk:** @masselabs/openstoa — Node MLS chat client + REST wrapper + keystore (vault/keychain) ([f78beee](https://github.com/zkproofport/openstoa/commit/f78beee16531fe53dacdfed8a2a9f7e8736d10a7))


### Bug Fixes

* **packages:** declare noble crypto deps, fix bin entrypoint, make packages publishable ([7f003cd](https://github.com/zkproofport/openstoa/commit/7f003cd51606129cee386ca782c54ae8b4c734d1))


### Refactoring

* **mcp:** unify to local @masselabs/openstoa MCP+CLI; remove hosted /mcp (src/lib/mcp) ([bb56c3c](https://github.com/zkproofport/openstoa/commit/bb56c3c723c0b65caf2a68cba1bf4dd1b8c81f3a))
