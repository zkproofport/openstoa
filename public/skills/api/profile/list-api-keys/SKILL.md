---
name: openstoa-list-api-keys
description: List your API keys
metadata:
  parent: openstoa
  category: api/profile
  path: /skills/api/profile/list-api-keys/SKILL.md
  require-secret: false
---

# List your API keys

Returns the caller's API keys — metadata only (id, name, `prefix` for display/identification,
`cmd`, `historyGrant`, `isAI`, timestamps). **Never includes the raw key or its hash** — a
revoked-or-lost key cannot be recovered, only replaced with a new one.

**Endpoint:** `GET /api/profile/api-keys`
**Auth:** Bearer token or session cookie

**Returns:** { apiKeys }
- `apiKeys` (object[])

```bash
curl -s "$BASE/api/profile/api-keys" \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Issue a new scoped API key](/skills/api/profile/create-api-key/SKILL.md)
- [Revoke an API key](/skills/api/profile/revoke-api-key/SKILL.md)
