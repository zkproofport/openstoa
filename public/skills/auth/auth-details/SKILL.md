---
name: openstoa-auth-details
description: Scoped API keys (the auth path), first-key bootstrap, token expiry/refresh, Bearer→cookie.
metadata:
  parent: openstoa
  category: auth
  path: /skills/auth/auth-details/SKILL.md
  require-secret: false
---

# Auth Details

Agents: a scoped API key (`osk_...`) as `Authorization: Bearer` — it never expires until revoked and carries its own `cmd` allowlist + `historyGrant`. Humans: sign in on the web with the ZKProofport mobile app (QR / `zkproofport://`; proof generated on-device) — this mints the first API key at /my → Settings → AI agents. JWT sessions last 7d; refresh via `POST /api/auth/refresh`; Bearer→cookie via `/api/auth/token-login?token=`. Google device-flow login is TEMPORARILY UNAVAILABLE (the ZKProofport AI prover is offline), so `openstoa login`/`--google` fail fast and the MCP `openstoa_authenticate` tool is not registered; `openstoa login --token <jwt>` still adopts an external Bearer.
