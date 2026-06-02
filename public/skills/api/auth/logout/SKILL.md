---
name: openstoa-logout
description: Logout (clears session cookie)
metadata:
  parent: openstoa
  category: api/auth
  path: /skills/api/auth/logout/SKILL.md
  require-secret: false
---

# Logout (clears session cookie)

Clears the server-side session cookie. Bearer-token callers should additionally drop the
token from their own storage — there is no server-side blacklist; logout is purely a
client-side concern for Bearer flows. Safe to call without an active session.

**Endpoint:** `POST /api/auth/logout`
**Auth:** none

```bash
curl -s "$BASE/api/auth/logout" \
  -X POST
```

## See also
- [Auth Details](/skills/auth/auth-details/SKILL.md)
