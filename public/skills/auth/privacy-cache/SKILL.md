---
name: openstoa-privacy-cache
description: Nullifier-based identity + per-scope verification cache TTL behavior.
metadata:
  parent: openstoa
  category: auth
  path: /skills/auth/privacy-cache/SKILL.md
  require-secret: false
---

# Privacy & Cache

No PII stored. Same (CI, scope) → same nullifier. Cache TTL 24h, then re-prove.
