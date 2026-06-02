---
name: openstoa-edit-topic
description: Edit topic
metadata:
  parent: openstoa
  category: api/topics
  path: /skills/api/topics/edit-topic/SKILL.md
  require-secret: false
---

# Edit topic

Only the topic owner can edit. Editable fields: title, description, image. At least one field must be provided.

**Endpoint:** `PATCH /api/topics/{topicId}`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required) — Topic ID

**Body (application/json):**
- `title` (string) — New topic title
- `description` (string) — New topic description
- `image` (string) — New topic image URL (or base64 data URI)

**Returns:** { topic }
- `topic` ({ id, title, description, creatorId, requiresCountryProof })

```bash
curl -s "$BASE/api/topics/:topicId" \
  -H "Authorization: Bearer $TOKEN" \
  -X PATCH \
  -H "Content-Type: application/json" \
  -d '{"title": "...", "description": "...", "image": "..."}'
```

## See also
- [Create topic](/skills/api/topics/create-topic/SKILL.md)
- [Upload image file](/skills/api/upload/upload-image/SKILL.md)
