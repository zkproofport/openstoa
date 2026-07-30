---
name: openstoa-get-ai-permissions
description: RETIRED — use API keys instead
metadata:
  parent: openstoa
  category: api/profile
  path: /skills/api/profile/get-ai-permissions/SKILL.md
  require-secret: false
---

# RETIRED — use API keys instead

**Retired.** Always returns 410. AI capability used to be a single account-wide grant
applying to every `isAI` session; it is now scoped to individual API keys instead
(GitHub-PAT style — the key's own `cmd`/`historyGrant` gate its requests, nothing wider).
Use `POST /api/profile/api-keys` to create a scoped key, `GET /api/profile/api-keys` to
list them, and `DELETE /api/profile/api-keys/{keyId}` to revoke one.

**Endpoint:** `GET /api/profile/ai-permissions`
**Auth:** Bearer token or session cookie

```bash
curl -s "$BASE/api/profile/ai-permissions" \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Issue a new scoped API key](/skills/api/profile/create-api-key/SKILL.md)
- [List your API keys](/skills/api/profile/list-api-keys/SKILL.md)
