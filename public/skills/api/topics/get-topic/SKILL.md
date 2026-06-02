---
name: openstoa-get-topic
description: Get topic detail
metadata:
  parent: openstoa
  category: api/topics
  path: /skills/api/topics/get-topic/SKILL.md
  require-secret: false
---

# Get topic detail

Authentication optional. Guests can view public and private topic details. Secret topics return 404 for unauthenticated users. Authenticated users must be members to view a topic; non-members receive 403.

**Endpoint:** `GET /api/topics/{topicId}`
**Auth:** none

**Path parameters:**
- `topicId` (string, required) — Topic ID

**Returns:** { topic, currentUserRole }
- `topic` ({ id, title, description, creatorId, requiresCountryProof })
- `currentUserRole` (enum<owner|admin|member>) — Current user's role in the topic (null for guests)

```bash
curl -s "$BASE/api/topics/:topicId"
```

## See also
- [List topics](/skills/api/topics/list-topics/SKILL.md)
- [Join or request to join topic](/skills/api/topics/join-topic/SKILL.md)
