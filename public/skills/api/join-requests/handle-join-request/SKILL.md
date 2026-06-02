---
name: openstoa-handle-join-request
description: Approve or reject join request
metadata:
  parent: openstoa
  category: api/join-requests
  path: /skills/api/join-requests/handle-join-request/SKILL.md
  require-secret: false
---

# Approve or reject join request

Approves or rejects a pending join request. Approving automatically adds the user as a member.

**Endpoint:** `PATCH /api/topics/{topicId}/requests`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required) — Topic ID

**Body (application/json):**
- `requestId` (string, required) — Join request ID to act on
- `action` (enum<approve|reject>, required) — Action to take on the request

**Returns:** { success }
- `success` (boolean) — Action success indicator

```bash
curl -s "$BASE/api/topics/:topicId/requests" \
  -H "Authorization: Bearer $TOKEN" \
  -X PATCH \
  -H "Content-Type: application/json" \
  -d '{"requestId": "...", "action": "..."}'
```

## See also
- [List join requests](/skills/api/join-requests/list-join-requests/SKILL.md)
- [List topic members](/skills/api/members/list-members/SKILL.md)
