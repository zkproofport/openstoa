---
name: openstoa-set-ai-permissions
description: RETIRED — use API keys instead
metadata:
  parent: openstoa
  category: api/profile
  path: /skills/api/profile/set-ai-permissions/SKILL.md
  require-secret: false
---

# RETIRED — use API keys instead

**Retired.** Always returns 410 — writes are rejected outright rather than silently
accepted, because an account-wide grant no longer has any effect (see GET for the
replacement). Accepting writes to an inert setting would be misleading: a caller could
believe they narrowed their AI's access when nothing enforces it any more.

**Endpoint:** `PUT /api/profile/ai-permissions`
**Auth:** Bearer token or session cookie

```bash
curl -s "$BASE/api/profile/ai-permissions" \
  -H "Authorization: Bearer $TOKEN" \
  -X PUT
```

## See also
- [Issue a new scoped API key](/skills/api/profile/create-api-key/SKILL.md)
- [List your API keys](/skills/api/profile/list-api-keys/SKILL.md)
