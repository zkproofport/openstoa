---
name: openstoa-remove-member
description: Remove member from topic
metadata:
  parent: openstoa
  category: api/members
  path: /skills/api/members/remove-member/SKILL.md
  require-secret: false
---

# Remove member from topic

Removes a member from the topic. Admins can only remove regular members. Owners can remove anyone except themselves.

**Endpoint:** `DELETE /api/topics/{topicId}/members`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required) — Topic ID

**Body (application/json):**
- `userId` (string, required) — User ID of the member to remove

**Returns:** { success }
- `success` (boolean) — Removal success indicator

```bash
curl -s "$BASE/api/topics/:topicId/members" \
  -H "Authorization: Bearer $TOKEN" \
  -X DELETE
```

## See also
- [List topic members](/skills/api/members/list-members/SKILL.md)
- [Change member role](/skills/api/members/change-member-role/SKILL.md)
