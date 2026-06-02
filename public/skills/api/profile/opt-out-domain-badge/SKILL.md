---
name: openstoa-opt-out-domain-badge
description: Opt out of domain badge
metadata:
  parent: openstoa
  category: api/profile
  path: /skills/api/profile/opt-out-domain-badge/SKILL.md
  require-secret: false
---

# Opt out of domain badge

Removes a domain from the public badge set. Send `{ "domain": "company.com" }` to remove a specific domain. Send no body to remove all domains. Workspace verifications remain valid — you can opt back in at any time.

**Endpoint:** `DELETE /api/profile/domain-badge`
**Auth:** Bearer token or session cookie

**Body (application/json):**
- `domain` (string) — Specific domain to remove. Omit to remove all domains.

**Returns:** { success, domains }
- `success` (boolean)
- `domains` (string[]) — Remaining visible domains after removal

```bash
curl -s "$BASE/api/profile/domain-badge" \
  -H "Authorization: Bearer $TOKEN" \
  -X DELETE
```

## See also
- [Get domain badge status](/skills/api/profile/get-domain-badge/SKILL.md)
- [Opt in to domain badge](/skills/api/profile/opt-in-domain-badge/SKILL.md)
