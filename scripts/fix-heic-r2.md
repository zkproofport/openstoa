# Fix-HEIC-R2 Migration Plan (NOT YET EXECUTED)

One-off script to repair existing R2 objects that were uploaded as raw HEIC
bytes under `.jpg` filenames + `Content-Type: image/heic`. Web browsers can't
decode those, so previously-uploaded post images appear broken.

## Status

**PLAN ONLY — DO NOT RUN until the live upload path (PATH A + PATH B in this
PR) has been deployed and verified.** Running before the live fix is in place
just creates more orphans.

## Scope

- All R2 objects under `${R2_PUBLIC_URL}/posts/`, `/topics/`, `/avatars/`.
- Filter by `Content-Type` header OR by sniffing first 12 bytes for ISO BMFF
  `ftyp` + an HEIC brand (`heic`, `heix`, `heim`, `heis`, `hevc`, `hevx`,
  `hevm`, `hevs`, `mif1`, `msf1`).

## Steps

1. **List**: `ListObjectsV2` paginated across the bucket.
   ```
   for await page of paginateListObjectsV2({ Bucket, Prefix: 'posts/' }):
     for obj in page.Contents:
       yield obj.Key
   ```
2. **HEAD-check**: For each key, `HeadObject` to read `ContentType`. If
   `image/heic` or `image/heif`, queue for conversion. If `image/jpeg` but
   the magic bytes suggest HEIC (rare — only when uploader explicitly
   misreported), fetch the first 12 bytes via `GetObject` Range header
   `bytes=0-11` and sniff.
3. **Convert + reupload**:
   - `GetObject` full body.
   - `sharp(buf).jpeg({ quality: 85 }).toBuffer()`.
   - `PutObject` to the **same key** with `ContentType: image/jpeg` and the
     same `CacheControl`. Public URL stays stable so no DB rewrite is needed.
4. **DB columns referencing the URL stay valid** — keys are unchanged. The
   only thing that changes is bytes + Content-Type header.

## Safety

- Dry-run mode: print key + detected brand + would-be new size, no writes.
- Concurrency cap: 4 in flight. R2 API limits + sharp memory.
- Skip keys whose `LastModified` is after the fix deploy timestamp — those
  were uploaded by the corrected path and shouldn't be touched.
- On per-key failure: log and continue. Do not abort the batch.

## Dependencies

- `@aws-sdk/client-s3` (already in package.json).
- `sharp` (already in package.json).

## Approximate runtime

- ~1000 objects, ~3 MB avg → 3 GB transfer. R2 egress is free to Cloudflare
  Workers but billable to non-CF clients; running this from a CF Worker is
  cheapest. From local dev, expect ~30 min over a typical home connection.

## Out of scope

- Rewriting any database-stored URLs (none change).
- Re-issuing R2 cache purges — the keys are immutable + the URL is unchanged,
  but browsers and CDN edges may have cached the broken HEIC bytes with the
  `Cache-Control: public, max-age=31536000, immutable` header. Plan to issue
  a Cloudflare cache purge **for the affected keys only** as a follow-up.
