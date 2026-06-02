---
name: openstoa-get-domain-badge
description: Get domain badge status
metadata:
  parent: openstoa
  category: api/profile
  path: /skills/api/profile/get-domain-badge/SKILL.md
  require-secret: false
---

# Get domain badge status

Returns the user's domain badge opt-in status. A user can have multiple opted-in domains (e.g., Google Workspace + Microsoft 365 from different orgs). `domains` contains all publicly visible domains. `availableDomain` is the most recently verified domain available for opt-in.

**Endpoint:** `GET /api/profile/domain-badge`
**Auth:** Bearer token or session cookie

**Returns:** { domains, availableDomain }
- `domains` (string[]) — All publicly visible domains (empty if none opted in)
- `availableDomain` (string) — Most recently verified domain available for opt-in (null if no valid verification)

```bash
curl -s "$BASE/api/profile/domain-badge" \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Opt in to domain badge](/skills/api/profile/opt-in-domain-badge/SKILL.md)
- [Opt out of domain badge](/skills/api/profile/opt-out-domain-badge/SKILL.md)
- [Topic Proofs](/skills/auth/topic-proofs/SKILL.md)
