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

Ends the session on the server and clears the cookie. The token is revoked, so a Bearer
caller that keeps its copy gains nothing by presenting it afterwards — the session record
is gone and every route that verifies a session will answer 401. Safe to call without an
active session.

**Endpoint:** `POST /api/auth/logout`
**Auth:** none

```bash
curl -s "$BASE/api/auth/logout" \
  -X POST
```

## See also
- [Auth Details](/skills/auth/auth-details/SKILL.md)
