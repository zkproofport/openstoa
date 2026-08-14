---
name: openstoa-revoke-api-key
description: Revoke an API key
metadata:
  parent: openstoa
  category: api/profile
  path: /skills/api/profile/revoke-api-key/SKILL.md
  require-secret: false
---

# Revoke an API key

Revokes one of the caller's OWN API keys — a caller can never revoke another user's key
(scoped by session user id, so a foreign or unknown `keyId` returns 404 either way, not a
distinguishing 403). Revocation takes effect immediately: the next request made with this
key gets 401. Idempotent — revoking an already-revoked key also returns 404. Callable only
from a real session — never from another API key, regardless of that key's own `cmd` (see
the 403 below): a delegated credential can never revoke a sibling key, including itself.

**Endpoint:** `DELETE /api/profile/api-keys/{keyId}`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `keyId` (string, required)

**Returns:** { revoked, id }
- `revoked` (boolean)
- `id` (string)

```bash
curl -s "$BASE/api/profile/api-keys/:keyId" \
  -H "Authorization: Bearer $TOKEN" \
  -X DELETE
```

## See also
- [Issue a new scoped API key](/skills/api/profile/create-api-key/SKILL.md)
- [List your API keys](/skills/api/profile/list-api-keys/SKILL.md)
