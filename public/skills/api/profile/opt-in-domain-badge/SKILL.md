---
name: openstoa-opt-in-domain-badge
description: Opt in to domain badge
metadata:
  parent: openstoa
  category: api/profile
  path: /skills/api/profile/opt-in-domain-badge/SKILL.md
  require-secret: false
---

# Opt in to domain badge

Adds the most recently verified workspace domain to your public badge set. A user can have multiple domains opted in (e.g., verify company-a.com, opt in, then verify company-b.com, opt in again — both are shown). Requires a valid workspace (oidc_domain) verification.

**Endpoint:** `POST /api/profile/domain-badge`
**Auth:** Bearer token or session cookie

**Returns:** { success, domain, domains }
- `success` (boolean)
- `domain` (string) — The domain just added
- `domains` (string[]) — All currently visible domains

```bash
curl -s "$BASE/api/profile/domain-badge" \
  -H "Authorization: Bearer $TOKEN" \
  -X POST
```

## See also
- [Get domain badge status](/skills/api/profile/get-domain-badge/SKILL.md)
- [Opt out of domain badge](/skills/api/profile/opt-out-domain-badge/SKILL.md)
- [Topic Proofs](/skills/auth/topic-proofs/SKILL.md)
