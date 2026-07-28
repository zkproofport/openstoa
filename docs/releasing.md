# Releasing OpenStoa

This repo versions **six independent components** out of one git history, using
[release-please] in *manifest mode*.

| config path | component | npm package | published? |
|---|---|---|---|
| `.` | `openstoa-server` | — (`"private": true`) | **no** — deployed by the parent `proofport-app-dev` repo's `deploy.yml` (`service=community`) |
| `packages/sdk` | `openstoa-sdk` | `@masselabs/openstoa` | yes |
| `packages/commands` | `openstoa-commands` | `@masselabs/openstoa-commands` | yes |
| `packages/cli` | `openstoa-cli` | `@masselabs/openstoa-cli` | yes |
| `packages/mcp` | `openstoa-mcp` | `@masselabs/openstoa-mcp` | yes |
| `packages/channel` | `openstoa-channel` | `@masselabs/openstoa-channel` | yes |

Config lives in [`release-please-config.json`](../release-please-config.json) and
[`.release-please-manifest.json`](../.release-please-manifest.json).

## The happy path

1. **Commit with [conventional commits]** on a branch, e.g.
   `feat(cli): add openstoa chat tail`, `fix(sdk): ...`, `feat!: ...`.
   Release-please attributes each commit to a component by the *paths it
   touches*, so a commit that only edits `packages/cli/**` only bumps the CLI.
   The `.` (server) entry sets `"exclude-paths": ["packages"]`, so
   packages-only commits never bump the server.
2. **Merge to `main`.** `.github/workflows/release-please.yml` opens (or updates)
   a single **release PR** — "chore(main): release ..." — containing the version
   bumps and CHANGELOG entries for every changed component.
3. **Merge the release PR.** Release-please tags and creates one **GitHub
   Release** per changed component, named `<component>-v<version>`:

   ```
   openstoa-sdk-v0.1.1
   openstoa-cli-v0.2.0
   openstoa-server-v0.1.1
   ```

4. **`.github/workflows/npm-publish.yml`** fires on each `release: published`
   event, maps the tag's component back to a package directory, and publishes.
   `openstoa-server-v*` is routed to a no-op with an explanation in the job
   summary — the server is private and is never published.

Because `0.x` versions are configured with `bump-minor-pre-major` +
`bump-patch-for-minor-pre-major`, a `feat:` produces a **patch** bump and a
breaking change produces a **minor** bump until a package reaches 1.0.0.

## Dependency / publish order

```
sdk  ->  commands  ->  cli
                   ->  mcp
                   ->  channel
```

`commands` depends on `@masselabs/openstoa`; `cli`, `mcp` and `channel` depend on
`@masselabs/openstoa-commands` (and `channel` on the SDK too). These are **plain
registry semver** (`^0.1.0`), not `file:` paths, so a consumer installing
`@masselabs/openstoa-cli` needs the matching `@masselabs/openstoa-commands`
version to already exist on npm.

`npm-publish.yml` enforces this. Before a real (non-dry-run) publish it resolves
every `@masselabs/*` entry in the target's `dependencies` against the registry
and waits up to 5 minutes for it to appear, then fails with an explicit message
naming the missing spec. Merging one release PR fires several Release events in
parallel, so a short wait while a sibling run finishes is normal.

## Cross-package version bumps (the `node-workspace` plugin)

`release-please-config.json` enables the `node-workspace` plugin. When `sdk` is
released, the plugin rewrites `@masselabs/openstoa` in every sibling's
`package.json`, patch-bumps those siblings, and adds them to the same release PR
— so the ranges can never point at a version that was never published.

**This works even though the repo is not an npm workspace.** The plugin builds
its graph from the paths listed in `release-please-config.json` and each
package's own `package.json` — it never reads a `workspaces` field
(`src/plugins/node-workspace.ts`, `for (const path in this.repositoryConfig)`).
The per-package `package-lock.json` files are also handled: release-please's
`PackageLockJson` updater explicitly follows lockfile v2/v3 **link nodes**
(`if (pkg.link && pkg.resolved) pkg = parsed.packages[pkg.resolved]`), which is
exactly the `"resolved": "../sdk", "link": true` shape this repo commits.

Caveat, verified rather than assumed: for a *transitively* bumped package (one
that had no commits of its own and is only being patch-bumped because a
dependency moved) the plugin writes the lockfile with the plain `PackageJson`
updater, which only touches the lockfile's top-level `version` field. The
lockfile's dependency **ranges** can therefore lag behind `package.json`. That is
harmless here: `npm ci` resolves a link node to the sibling folder on disk, and
release-please bumps the sibling in the same PR, so the on-disk version always
satisfies the new range. If a lockfile ever does drift far enough to matter, run
`./packages/link-local.sh` and commit the regenerated locks.

## Manual publish / dry run

`npm-publish.yml` also has a `workflow_dispatch` trigger:

| input | values | default |
|---|---|---|
| `package` | `sdk`, `commands`, `cli`, `mcp`, `channel`, `all` | `sdk` |
| `dry_run` | boolean | **`true`** |

`dry_run: true` runs `npm publish --dry-run --access public` — it prints the
exact tarball contents and never publishes. This is the right way to sanity-check
a brand-new package name, since the registry preflight is intentionally skipped
on dry runs.

`package: all` publishes in dependency order (`sdk commands cli mcp channel`)
inside one job, which is why the workflow uses an ordered loop rather than a
matrix (a matrix gives no ordering guarantee).

A release tag containing `beta` publishes under the `beta` dist-tag instead of
`latest`.

## Required secrets and one-time setup

| secret | used by | notes |
|---|---|---|
| `RELEASE_PLEASE_TOKEN` | `release-please.yml` | PAT with `repo` scope. The default `GITHUB_TOKEN` is not enough: PRs it opens do not trigger other workflows, so CI would never run on the release PR. |
| `NPM_TOKEN` | `npm-publish.yml` (optional) | Automation token. Only needed for the **bootstrap publish** and as a fallback — see below. |

### npm auth: OIDC trusted publishing, with a token bootstrap

`npm-publish.yml` prefers [npm trusted publishing][trusted-publishers] (OIDC —
no long-lived secret). Per npm's docs that requires **npm CLI >= 11.5.1 and Node
>= 22.14.0**, so the publish job runs on Node 22 and installs `npm@^11.5.1`, with
workflow permissions `id-token: write` and `contents: read`.

To enable it, configure a trusted publisher **per package** in that package's
settings on npmjs.com, with:

- **GitHub organization / repository:** `zkproofport` / `openstoa`
  — note this is **not** `masselabs`. `@masselabs` is only the *npm scope*; the
  git remote is `https://github.com/zkproofport/openstoa.git`.
- **Workflow filename:** `npm-publish.yml`

**Bootstrap caveat:** a trusted publisher is configured on an *existing* package,
and npm's docs do not describe pre-configuring a name that has never been
published. All five `@masselabs/*` names are currently unpublished (`npm view`
returns `E404`), so the **first publish of each name has to go through the token
path**: set the `NPM_TOKEN` secret, run the workflow once per package, then add
the trusted publisher on npmjs and delete the secret. The workflow supports both
without any edit — when `NPM_TOKEN` is unset it strips the token line from the
generated `.npmrc` so npm falls through to OIDC.

**Provenance** (the "Built and signed on GitHub Actions" badge) is generated
automatically by trusted publishing, but only for a **public repository and a
public package**.

## What CI checks (`.github/workflows/ci.yml`)

| job | what it does |
|---|---|
| `packages` | matrix over `sdk`/`commands`/`cli`/`mcp`/`channel`: builds the local dependency chain first (their dist/ is gitignored but resolved through lockfile link nodes), then `npm ci` -> `tsc --noEmit` -> `npm test` -> `npm run build`. |
| `server` | root `npm ci` -> vitest unit suite against a `redis:7` service container -> `npm run build` (which also re-runs `scripts/generate-skill.ts` via `prebuild`). |
| `mcp-smoke` | builds `sdk` -> `commands` -> `mcp`, then runs `scripts/mcp-smoke.mjs`, which spawns the real `openstoa-mcp` stdio binary, completes an MCP `initialize` + `tools/list` handshake over stdin/stdout, and fails on any hang or crash. This is the guard for the entrypoint-guard class of bug that once shipped a CLI bin that exited 0 without doing anything. |

The e2e suites (`src/__tests__/e2e/**`, `packages/*/src/__tests__/e2e/**`) are
**not** run in CI — they need a live container plus R2/OAuth/wallet secrets. Run
them locally or against staging with `npm run test:e2e:*`.

[release-please]: https://github.com/googleapis/release-please
[conventional commits]: https://www.conventionalcommits.org/
[trusted-publishers]: https://docs.npmjs.com/trusted-publishers
