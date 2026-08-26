---
name: openstoa-prove-device
description: Prove this device, registering its key on first use
metadata:
  parent: openstoa
  category: api/auth
  path: /skills/api/auth/prove-device/SKILL.md
  require-secret: false
---

# Prove this device, registering its key on first use

Answers the nonce from `GET /api/auth/device/challenge`. Send the signature over the DECODED
nonce bytes and the device's Ed25519 public key, both base64.

**First call for a device registers the key**, because there is no earlier moment at which the
server could have learned it — the key is generated on the phone and the private half never
leaves. Later calls check against what was registered.

A device that presents a DIFFERENT key for an id it has already registered is answered `409`,
not accepted. That is a genuinely new install which lost the private half, and quietly
accepting it is how one phone came to hold 48 separate identities — each one leaving the
messages before it unreadable to the next. Sign in again, or restore from a backup.

**Endpoint:** `POST /api/auth/device/challenge`
**Auth:** Bearer token or session cookie

**Body (application/json):**
- `nonce` (string, required) — Exactly the value from GET, base64.
- `signature` (string, required) — Ed25519 signature over the DECODED nonce bytes, base64.
- `publicKey` (string, required) — The device's Ed25519 public key, 32 raw bytes, base64.

```bash
curl -s "$BASE/api/auth/device/challenge" \
  -H "Authorization: Bearer $TOKEN" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"nonce": "...", "signature": "...", "publicKey": "..."}'
```
