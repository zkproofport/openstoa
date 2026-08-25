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

**A personal space answers 404 here, not 403.** It stores an invite code because the
column requires one, never because it admits anyone — and a refusal would confirm the
code names a real topic. Treat it as an invalid code, because that is what it is.

Looks up a topic by its invite code, before joining it.

**Read the gate before you try the door.** The response carries
`requiresCountryProof` and, when that is true, the `allowedCountries` the topic
accepts (ISO 3166-1 alpha-2). A caller that posts to the join endpoint without the
matching proof is refused, and the refusal does not say which countries would have
worked — this lookup is where that is knowable. Generate the proof first: see
`topic-proofs`.

`isMember` says whether the caller is already in, so a preview can offer "open"
rather than "join" and a repeat join can be skipped entirely.

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
- [Topic Proofs](/skills/auth/topic-proofs/SKILL.md)
