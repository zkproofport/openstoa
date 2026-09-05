# Changelog

## [0.1.3](https://github.com/zkproofport/openstoa/compare/openstoa-sdk-v0.1.2...openstoa-sdk-v0.1.3) (2026-09-05)


### Features

* **chat:** pick several photos at once, and send them independently ([0baf51f](https://github.com/zkproofport/openstoa/commit/0baf51f2caf5b9162676d3386f77cbee2a48b7dd))
* **chat:** reclaim delivered ciphertext, encrypt media, and close the key-management hole ([5f204f8](https://github.com/zkproofport/openstoa/commit/5f204f8e6ed15757f836f5d1ccfcef295ade2e21))
* **chat:** send attachments as binary, and let people save them ([750d7cd](https://github.com/zkproofport/openstoa/commit/750d7cd0b2aa36c5e72aa9857c1ef6f98c10fdb9))
* **mobile:** recovery codes, device erase, and chat state fixes ([c054851](https://github.com/zkproofport/openstoa/commit/c054851559b9843391c95d28f51e8252af236613))
* **push:** TAK-based push preview, notification prefs, tap routing ([5419072](https://github.com/zkproofport/openstoa/commit/54190723219fa554f254988b30332a6cb80a2ae5))
* **web,cli:** chat rail fixes, web i18n, and API-key-scoped AI capability ([c8603db](https://github.com/zkproofport/openstoa/commit/c8603db0162edf000ebb4565dbc2ce552a473544))


### Bug Fixes

* **chat:** an attachment you are told you can send actually sends ([eab4a72](https://github.com/zkproofport/openstoa/commit/eab4a723f41dac5ddf30d4cb32d6aa29e0677dc4))
* **chat:** give a DM a key that can actually reach the other device ([08f2cf0](https://github.com/zkproofport/openstoa/commit/08f2cf027742be9ae7f192718a225fd07da24fb8))
* **ci:** install mls for the mcp smoke, and unstick two real test defects ([023f661](https://github.com/zkproofport/openstoa/commit/023f661a9de55715cea8b891ce2952afb5ac2003))
* **mls:** keep the device identity out of the key that can vanish ([380a3e5](https://github.com/zkproofport/openstoa/commit/380a3e54c3cfbca5be4677829af8619003192505))
* **mls:** serve HPKE AES-GCM from noble on mobile so web can open its commits ([4d32284](https://github.com/zkproofport/openstoa/commit/4d322846090231fbac4abc035e791017081cc7e9))


### Refactoring

* **mls:** collapse 27 hand-synced crypto copies into one package ([6eaa8a5](https://github.com/zkproofport/openstoa/commit/6eaa8a54b74464ded0c02461b8915f155d610877))

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
