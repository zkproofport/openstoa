#!/usr/bin/env bash
#
# Gate 2 of docs/design/media-bucket-flip-checklist.md, as EVIDENCE rather than
# a config read: does the storage layer itself refuse anonymous reads, and does
# the app's gated route still serve?
#
# Reading `mc anonymous get` proves nothing about what MinIO will actually
# answer, so this makes real requests instead — anonymous and authenticated,
# against an object it uploads through the real `POST /api/upload` during the
# run rather than a hand-picked fixture.
#
# Usage (local dev stack must be up — ./scripts/dev.sh from the parent repo):
#   openstoa/scripts/verify-media-bucket-flip.sh
#
# Expected AFTER the flip (mc anonymous set none):
#   anonymous DIRECT to MinIO   403   <- the bypass is closed; this is the point
#   anonymous GATE  private     401   <- guest, per the route's documented rules
#   authed    GATE  private     200   <- the app still reads with credentials
#   anonymous GATE  public      200   <- guests can still see public content
#
# Before the flip the first line is 200 — that is the live exposure, and running
# this with OPENSTOA_DEV_BUCKET_ANONYMOUS=download reproduces it on purpose.
set -u

APP=${APP:-http://localhost:3200}
MINIO=${MINIO:-http://localhost:9000}
BUCKET=${R2_BUCKET_NAME:-openstoa-dev}
PG=${PG:-proofport-postgres}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== provisioning a genuinely gated object through the real API =="
TOKEN=$(curl -s -X POST "$APP/api/auth/dev-login" -H 'content-type: application/json' \
  -d '{"nickname":"flipprobe_'"$RANDOM"'"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "FATAL: no dev-login token — is the stack up at $APP?"; exit 1; }

PNG="$(mktemp -d)/probe.png"
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' > "$PNG"
URL=$(curl -s -X POST "$APP/api/upload" -H "Authorization: Bearer $TOKEN" \
  -F "file=@$PNG;type=image/png" | sed -n 's/.*"publicUrl":"\([^"]*\)".*/\1/p')
[ -n "$URL" ] || { echo "FATAL: upload failed"; exit 1; }
KEY=${URL#/api/media/}
echo "  object key : $KEY"

# A public-topic post image, for the "guests can still browse" half. Taken from
# whatever the bucket actually holds, so this needs no fixture to stay in sync.
# The listing is filtered HOST-side: the minio image ships no grep.
PUBKEY=""
OBJS=$(docker exec proofport-minio sh -c \
  'mc alias set l http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; \
   mc ls --recursive "l/'"$BUCKET"'/topics/" 2>/dev/null' | awk '{print $NF}' | grep '/posts/')
PUBIDS=$(docker exec "$PG" psql -U proofport -d openstoa -t -A -c \
  "SELECT id FROM topics WHERE visibility='public'" 2>/dev/null)
for k in $PUBIDS; do
  hit=$(printf '%s\n' "$OBJS" | grep "^$k/" | head -1)
  [ -n "$hit" ] && { PUBKEY="topics/$hit"; break; }
done

echo
printf '  %-52s %s\n' "anonymous  DIRECT  $MINIO/$BUCKET/<key>" "$(code "$MINIO/$BUCKET/$KEY")"
printf '  %-52s %s\n' "anonymous  GATE    private object"      "$(code "$APP/api/media/$KEY")"
printf '  %-52s %s\n' "authed     GATE    private object"      "$(code -H "Authorization: Bearer $TOKEN" "$APP/api/media/$KEY")"
if [ -n "$PUBKEY" ]; then
  printf '  %-52s %s\n' "anonymous  GATE    public-topic image" "$(code "$APP/api/media/$PUBKEY")"
else
  echo "  (no public-topic post image in the bucket — skipped that probe)"
fi
