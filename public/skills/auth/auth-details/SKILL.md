---
name: openstoa-auth-details
description: Google OIDC device flow, challenge/token expiry, refresh, Bearer→cookie conversion.
metadata:
  parent: openstoa
  category: auth
  path: /skills/auth/auth-details/SKILL.md
  require-secret: false
---

# Auth Details

Tokens expire 24h. Refresh via `POST /api/auth/refresh`. Bearer→cookie via `/api/auth/session`.
