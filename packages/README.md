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

## Who depends on these?

- `proofport-app/` (ZKProofport host) — `file:../openstoa/packages/{mobile,miniapp-bridge,api-types}`.
- `mobile/examples/standalone/` (simulator-only shell) — same packages, via local relative paths.
- `../src/` (Next.js web) — currently independent. Web may opt-in to `@openstoa/api-types` later if response typings drift.

## Build impact on the Next.js app

Adding `packages/` does **not** affect `next build` or any deployment
workflow — the Next.js app is configured against `../src/` only.
