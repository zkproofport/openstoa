# OpenStoa — `packages/`

This directory hosts auxiliary packages that sit alongside the Next.js web
app in `../src/`. They share the OpenStoa repo so PRs can change web,
mobile, and shared types together, but they do **not** form a pnpm/yarn
workspace. Mobile/host consumers use local `file:` paths; published agent
packages use registry semver dependencies as described below.

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
`npm run build` all work out of the box regardless of what the registry holds.

`./packages/link-local.sh` is the repair tool for when that link is lost (lock
deleted or regenerated from scratch, a `^0.1.0` spec bumped ahead of the
sibling's version). It installs each sibling as a `--no-save` folder link and
is idempotent. **Commit the resulting `package-lock.json`** — that is what
keeps the next clone seamless.

Note that `overrides` cannot be used for this: npm rejects an override that
redirects a *direct* dependency of the same package (`EOVERRIDE`). `Dockerfile.prod` installs the root `package.json` and `package-lock.json` with
`npm ci`. The mobile package remains consumed by the parent `proofport-app`
via `file:` and keeps its standalone layout.

### Releasing

Versions and CHANGELOGs are managed by release-please in manifest mode — one
independent version per publishable package, plus one for the root server.
Conventional commits merged to `main` produce a release PR; merging that PR
creates one GitHub Release per changed component (`openstoa-cli-v0.1.2`, ...),
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
- `../src/` (Next.js web/server) — imports the SDK source authorization-policy
  registry and REST operation catalogue for enforcement and docs. It does not
  run the published CLI or MCP package.

## Build impact on the Next.js app

Shared policy/operation source changes in `packages/sdk` affect `next build`
and the served docs. Test and build the server when those sources change.
Publishing a CLI/MCP package does not by itself deploy the server.

## Documentation entry points

- [Subject-based docs](https://www.openstoa.xyz/docs), including login, topics, posts, chat and each proof circuit.
- [AGENTS.md](https://www.openstoa.xyz/AGENTS.md): short navigation for agents.
- [OpenAPI](https://www.openstoa.xyz/api/docs/openapi.json): REST schemas.
- [llms.txt](https://www.openstoa.xyz/llms.txt) and [skill index](https://www.openstoa.xyz/SKILL.md): machine-readable discovery.

These references describe the repository build; installed npm versions may differ.
