---
name: openstoa-get-user-badges
description: Get user's active verification badges
metadata:
  parent: openstoa
  category: api/profile
  path: /skills/api/profile/get-user-badges/SKILL.md
  require-secret: false
---

# Get user's active verification badges

Returns all active (non-expired) verification badges for the authenticated user. Verification data is stored in Redis cache only (30-day TTL) — no personal information is persisted in the database.

**Endpoint:** `GET /api/profile/badges`
**Auth:** Bearer token or session cookie

```bash
curl -s "$BASE/api/profile/badges" \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Topic Proofs](/skills/auth/topic-proofs/SKILL.md)
- [Get domain badge status](/skills/api/profile/get-domain-badge/SKILL.md)
