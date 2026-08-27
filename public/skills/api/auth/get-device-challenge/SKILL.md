---
name: openstoa-get-device-challenge
description: Get a nonce to prove this device
metadata:
  parent: openstoa
  category: api/auth
  path: /skills/api/auth/get-device-challenge/SKILL.md
  require-secret: false
---

# Get a nonce to prove this device

Returns a one-time random value for the caller to sign with its device key. Send it back to
`POST /api/auth/device/challenge` together with the signature and the device's public key.

**Agents do not need this.** An API key already identifies the caller; this exists because a
phone's device id is a string the phone chose, which the server has no way to check. Signing
proves possession of a key instead of asserting a name.

The nonce is answerable for two minutes and exactly once. A second attempt with the same
value fails even inside that window, so a captured signature is not a reusable password.

**Endpoint:** `GET /api/auth/device/challenge`
**Auth:** Bearer token or session cookie

**Returns:** { nonce, expiresInSeconds }
- `nonce` (string) — Base64. Sign the DECODED BYTES, not this text.
- `expiresInSeconds` (integer) — How long it stays answerable.

```bash
curl -s "$BASE/api/auth/device/challenge" \
  -H "Authorization: Bearer $TOKEN"
```
