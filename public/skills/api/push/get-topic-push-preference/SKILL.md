---
name: openstoa-get-topic-push-preference
description: Read your notification setting for one topic
metadata:
  parent: openstoa
  category: api/push
  path: /skills/api/push/get-topic-push-preference/SKILL.md
  require-secret: false
---

# Read your notification setting for one topic

Returns whether the caller muted THIS topic, alongside the account-wide switch and the
resolved answer (`willNotify`) so a client can render the correct state without doing the
precedence arithmetic itself.

**Membership required** — a non-member gets 403, because a non-member is never a push
recipient for the topic in the first place.

**Endpoint:** `GET /api/topics/{topicId}/push`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required) — The topic (chat room) whose notification setting you want. Must be a UUID; anything else is 400.

**Returns:** { topicId, muted, globalEnabled, willNotify }
- `topicId` (string) — Echo of the topic this state belongs to.
- `muted` (boolean) — `true` when the caller muted this topic individually. `false` (the default for every topic you join) means it follows the account-wide switch.
- `globalEnabled` (boolean) — The account-wide switch from `/api/push/preferences`, repeated here so a client can explain WHY a topic is silent.
- `willNotify` (boolean) — The resolved outcome — `globalEnabled && !muted`. When `false`, no device push is sent for this topic (the message itself is still delivered in-app).

```bash
curl -s "$BASE/api/topics/:topicId/push" \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Mute or unmute one topic](/skills/api/push/update-topic-push-preference/SKILL.md)
- [Read your push notification preferences](/skills/api/push/get-push-preferences/SKILL.md)
