---
name: openstoa-leave-topic
description: Leave a topic
metadata:
  parent: openstoa
  category: api/members
  path: /skills/api/members/leave-topic/SKILL.md
  require-secret: false
---

# Leave a topic

Removes the caller's own membership. The counterpart to `POST /api/topics/{topicId}/join` — until this existed, an account could join a topic and had no way out (`DELETE /members` refuses self-removal).

Idempotent: leaving a topic you are not a member of succeeds and reports `left: false`, so a double-tap or a retry is never an error.

The topic OWNER cannot leave while owning it — transfer ownership first (`PATCH /api/topics/{topicId}/members` with `role: owner`). This is the same rule account deletion enforces.

Chat: leaving deletes the membership row, which is what gates access. The MLS leaf is evicted separately by the next member to open the chat (the server holds no keys and cannot commit — SI-1). A client that leaves should also drop its own local group state and archive keys for the topic.

**Endpoint:** `POST /api/topics/{topicId}/leave`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required) — The topic to leave.

**Returns:** { success, left }
- `success` (boolean) — Always true — the caller is not a member of the topic.
- `left` (boolean) — True if this call removed a membership; false if there was nothing to remove. Use it to decide whether to show a confirmation, not to decide success.

```bash
curl -s "$BASE/api/topics/:topicId/leave" \
  -H "Authorization: Bearer $TOKEN" \
  -X POST
```

## See also
- [Join or request to join topic](/skills/api/topics/join-topic/SKILL.md)
- [Remove member from topic](/skills/api/members/remove-member/SKILL.md)
- [List topic members](/skills/api/members/list-members/SKILL.md)
