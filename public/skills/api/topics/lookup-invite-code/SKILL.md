---
name: openstoa-lookup-invite-code
description: Lookup topic by invite code
metadata:
  parent: openstoa
  category: api/topics
  path: /skills/api/topics/lookup-invite-code/SKILL.md
  require-secret: false
---

# Lookup topic by invite code

Looks up a topic by its invite code. Returns topic info and whether the current user is already a member. Used to show a preview before joining.

**Endpoint:** `GET /api/topics/join/{inviteCode}`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `inviteCode` (string, required) — 8-character invite code

**Returns:** { topic, isMember }
- `topic` ({ id, title, description, requiresCountryProof, allowedCountries }) — Topic preview information
- `isMember` (boolean) — Whether the current user is already a member

```bash
curl -s "$BASE/api/topics/join/:inviteCode" \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Join topic via invite code](/skills/api/topics/join-by-invite-code/SKILL.md)
- [Generate a single-use invite token](/skills/api/topics/generate-invite-token/SKILL.md)
