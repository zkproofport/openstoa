# OpenStoa — `packages/`

This directory hosts auxiliary packages that sit alongside the Next.js web
app in `../src/`. They share the OpenStoa repo so PRs can change web,
mobile, and shared types together, but they do **not** form a pnpm/yarn
workspace — consumers pull each package via plain `file:` paths from their
own `package.json`.

## Layout

| Package | Purpose |
|---------|---------|
| `mobile/` | `openstoa-mobile` — React Native mini-app (Feed / Topics / Chat / Profile) used by ZKProofport host **and** the standalone simulator shell. |
| `miniapp-bridge/` | `@openstoa/miniapp-bridge` — `HostApi` interface + React `HostProvider` so the mobile package stays host-agnostic. |
| `api-types/` | `@openstoa/api-types` — REST domain types shared between web and mobile. |

### Publishable `@masselabs/*` packages

| Package | npm name | Ships |
|---------|----------|-------|
| `sdk/` | `@masselabs/openstoa` | typed REST client + Node MLS E2EE chat crypto |
| `commands/` | `@masselabs/openstoa-commands` | shared command core (CLI + MCP) |
| `cli/` | `@masselabs/openstoa-cli` | `openstoa` bin |
| `mcp/` | `@masselabs/openstoa-mcp` | `openstoa-mcp` stdio server |
| `channel/` | `@masselabs/openstoa-channel` | agent-runtime channel adapter |

These five are published to npmjs, so their inter-package deps are declared as
plain semver (`^0.1.0`) — a `file:../sibling` spec would ship a tarball whose
dependency points at a path that does not exist on the consumer's disk.

Local resolution comes from each package's committed `package-lock.json`, which
records the sibling as a Link node (`"resolved": "../sdk", "link": true`). A
plain `npm install` in a fresh clone honours that entry and recreates the
symlink without ever asking the registry, so `npm install` / `npm test` /
`npm run build` all work out of the box — verified against the real npmjs
registry, where `@masselabs/*` does not exist yet.

`./packages/link-local.sh` is the repair tool for when that link is lost (lock
deleted or regenerated from scratch, a `^0.1.0` spec bumped ahead of the
sibling's version). It installs each sibling as a `--no-save` folder link and
is idempotent. **Commit the resulting `package-lock.json`** — that is what
keeps the next clone seamless.

Note that `overrides` cannot be used for this: npm rejects an override that
redirects a *direct* dependency of the same package (`EOVERRIDE`). npm
workspaces are also out — `Dockerfile.prod` copies only the root
`package.json` before `npm install`, and `packages/mobile` is consumed by the
parent `proofport-app` repo via `file:` and must keep its standalone layout.

### Releasing

Versions and CHANGELOGs are managed by release-please in manifest mode — one
independent version per publishable package, plus one for the root server.
Conventional commits merged to `main` produce a release PR; merging that PR
creates one GitHub Release per changed component (`openstoa-cli-v0.1.1`, ...),
and `.github/workflows/npm-publish.yml` routes on that tag and publishes.

Publish order is `sdk` -> `commands` -> `cli` / `mcp` / `channel`, and the
workflow enforces it by waiting for each `@masselabs/*` dependency to exist on
the registry first. Manual publishes and dry runs go through the
`workflow_dispatch` trigger on the same workflow (`dry_run` defaults to `true`).

Full details — required secrets, the npm trusted-publisher setup (GitHub repo
`zkproofport/openstoa`, not `masselabs`), the token-based bootstrap needed for
each name's first publish, and how the inter-package `^0.1.0` ranges get bumped —
are in [`../docs/releasing.md`](../docs/releasing.md).

## Who depends on these?

- `proofport-app/` (ZKProofport host) — `file:../openstoa/packages/{mobile,miniapp-bridge,api-types}`.
- `mobile/examples/standalone/` (simulator-only shell) — same packages, via local relative paths.
- `../src/` (Next.js web) — currently independent. Web may opt-in to `@openstoa/api-types` later if response typings drift.

## Build impact on the Next.js app

Adding `packages/` does **not** affect `next build` or any deployment
workflow — the Next.js app is configured against `../src/` only.
