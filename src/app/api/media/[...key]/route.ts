/**
 * M-5 — the gated read path for plaintext post/topic/profile images, and the
 * reason the R2 bucket can eventually stop being public.
 *
 * `POST /api/upload` still writes plaintext bytes to a REAL, PUBLIC URL —
 * unlike chat attachments (R-3), these were never meant to be secret from the
 * server, only from people who have no business seeing the containing post.
 * Today that second half doesn't exist: `${R2_PUBLIC_URL}/${key}` is an
 * unauthenticated bearer URL, so a private or secret topic's pictures are
 * exactly as public as a public topic's the moment anyone has the link.
 *
 * This route is the fix, and it is deliberately shaped so that `uploadToR2`
 * needs ZERO changes: it already mints URLs as `${R2_PUBLIC_URL}/${key}`, and
 * this route's own path IS `/api/media/{key}` — so pointing `R2_PUBLIC_URL` at
 * this route's base (e.g. `https://openstoa.xyz/api/media`) makes every NEW
 * upload's URL resolve here automatically, no other code change required.
 *
 * WHAT THIS DOES NOT DO YET: rewrite URLs already stored in `posts.content`
 * (inline `<img src>`), `posts.media.images[]`, `topics.image`, and
 * `users.profile_image` from the OLD raw R2 domain to the new one. Those rows
 * keep pointing at R2 directly, so they go dark the moment the bucket's public
 * access is removed. `scripts/rewrite-media-urls.ts` does that rewrite (one
 * pass, idempotent) and must run — staging first, then production — BEFORE
 * the bucket flip lands. See that script's header for the exact steps.
 *
 * GATING RULES (mirrors `GET /api/posts/{postId}` — see that route's comments
 * for why private is signed-in-only rather than guest-visible even though
 * `GET /api/topics/{topicId}` shows private topic METADATA to guests):
 *   - `topics/{topicId}/posts/…` and `topics/{topicId}/image/…` (post images,
 *     topic cover): public topic → anyone, including guests. Private topic →
 *     any signed-in user, membership not required. Secret topic → members
 *     only (403 for a signed-in non-member, 401 for a guest — a guest can
 *     never prove membership, so asking "are you a member" is moot for them).
 *   - `users/{userId}/profile/…` (avatar): WORLD-READABLE, no gate at all.
 *     Deliberate, not an oversight — see the comment above `AVATAR_IS_UNGATED`
 *     below for why gating it would cost real function and buy no real
 *     confidentiality.
 *   - `users/{userId}/uploads/…` (an image uploaded with no topic yet — a
 *     topic's cover before that topic existed, or a bare agent upload): the
 *     uploader may always read their own. Anyone else may read it ONLY if it
 *     is currently a topic's cover picture (`topics.image` equals this
 *     object's URL) — gated by THAT topic's visibility. Otherwise 403: an
 *     unpublished draft is nobody else's business.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { getR2ObjectWithMeta, parseMediaObjectKey, tryGetR2PublicUrl } from '@/lib/r2';

const ROUTE = '/api/media/[...key]';

type Gate = { deny: NextResponse; cachePublic?: never } | { deny: null; cachePublic: boolean };

/**
 * Shared by `topic-post` / `topic-image` directly, and by `user-upload`
 * once it has resolved to a topic cover. One function so the three call
 * sites cannot drift on what "readable" means for a given visibility —
 * exactly the drift class `CLAUDE.md` calls out for this codebase.
 */
async function gateByTopicVisibility(
  topic: { id: string; visibility: string },
  session: SessionPayload | null,
): Promise<Gate> {
  if (!session) {
    if (topic.visibility === 'public') return { deny: null, cachePublic: true };
    return { deny: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }
  if (topic.visibility === 'public' || topic.visibility === 'private') {
    return { deny: null, cachePublic: topic.visibility === 'public' };
  }
  // secret
  const membership = await db.query.topicMembers.findFirst({
    where: and(eq(topicMembers.topicId, topic.id), eq(topicMembers.userId, session.userId)),
  });
  if (!membership) {
    return { deny: NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 }) };
  }
  return { deny: null, cachePublic: false };
}

async function gateTopicScoped(topicId: string, session: SessionPayload | null): Promise<Gate> {
  const topic = await db.query.topics.findFirst({
    where: eq(topics.id, topicId),
    columns: { id: true, visibility: true },
  });
  if (!topic) {
    return { deny: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  }
  return gateByTopicVisibility(topic, session);
}

async function gateUserUpload(
  userId: string,
  objectKey: string,
  session: SessionPayload | null,
): Promise<Gate> {
  if (session && session.userId === userId) {
    return { deny: null, cachePublic: false };
  }

  // Not the uploader — the only other legitimate reader is someone allowed to
  // see the topic THIS object is currently the cover picture of, if any.
  const publicUrl = tryGetR2PublicUrl();
  if (publicUrl) {
    const candidateUrl = `${publicUrl}/${objectKey}`;
    const topic = await db.query.topics.findFirst({
      where: eq(topics.image, candidateUrl),
      columns: { id: true, visibility: true },
    });
    if (topic) {
      return gateByTopicVisibility(topic, session);
    }
  }

  // Neither the uploader nor a published topic cover: an in-progress draft
  // (mid topic-creation, or a bare agent upload never attached to anything).
  if (!session) return { deny: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  return { deny: NextResponse.json({ error: 'Not allowed to read this file' }, { status: 403 }) };
}

/**
 * @openapi
 * /api/media/{key}:
 *   get:
 *     tags: [Media]
 *     summary: Fetch a plaintext post, topic-cover, or profile image by its storage key
 *     description: |
 *       Serves the raw bytes of an image previously uploaded via `POST /api/upload`. This is
 *       the URL embedded everywhere those images are referenced — an `<img src="...">` inside a
 *       post's HTML `content`, `topic.image`, and `user.profileImage` — so an agent normally
 *       arrives here by following a URL it already has, not by constructing one. It streams
 *       bytes with a real `Content-Type`, not JSON, so a plain HTTP client (`<img>` tag,
 *       `fetch` + save-to-file, `curl -o`) just works.
 *
 *       **Auth is conditional on what `{key}` names** — the same route is world-readable for
 *       one object and member-only for another, decided per request:
 *       - `topics/{topicId}/posts/{uuid}/{filename}` (a post's image) and
 *         `topics/{topicId}/image/{uuid}/{filename}` (a topic's cover picture): gated by that
 *         topic's `visibility`, mirroring `GET /api/topics/{topicId}`. `public` → anyone,
 *         including guests. `private` → any signed-in user, membership NOT required. `secret` →
 *         topic members only — 401 for a guest (a guest can never prove membership, so there is
 *         nothing to check), 403 for a signed-in non-member.
 *       - `users/{userId}/profile/{uuid}/{filename}` (an avatar): always world-readable, no gate
 *         at all. Deliberate, not an oversight — one avatar is attached to every post, comment,
 *         and chat message a user has ever sent, so refusing it here buys no real
 *         confidentiality (it is already visible to any guest the moment that user has posted
 *         once in any public topic) and would only break contexts — like a private topic's
 *         member list — that happen to render it first.
 *       - `users/{userId}/uploads/{uuid}/{filename}` (an image with no topic yet — a topic cover
 *         uploaded before its topic existed, or a bare agent upload): the uploader can always
 *         read their own. Anyone else may read it ONLY while it is currently some topic's cover
 *         picture (`topic.image` equals this object's URL), gated by THAT topic's visibility
 *         exactly as above. Otherwise it is an unpublished draft and nobody else's business —
 *         403 for a signed-in caller, 401 for a guest.
 *
 *       A `{key}` that doesn't match one of the four shapes above (wrong segment count, a
 *       non-UUID id, an unrecognized root segment) is rejected with 400 before any storage or
 *       database lookup runs.
 *     operationId: getMedia
 *     security: []
 *     x-related-skills: [upload-image, create-post, edit-post, set-profile-image, create-topic, get-topic]
 *     parameters:
 *       - name: key
 *         in: path
 *         required: true
 *         description: |
 *           The object's storage key, taken verbatim from wherever the URL appeared — never
 *           hand-construct this. Always exactly 5 `/`-separated segments, one of:
 *           `topics/{topicId}/posts/{uuid}/{filename}`, `topics/{topicId}/image/{uuid}/{filename}`,
 *           `users/{userId}/profile/{uuid}/{filename}`, or `users/{userId}/uploads/{uuid}/{filename}`
 *           (`{topicId}` / the id inside `{uuid}` are real UUIDs; `{userId}` is a nullifier).
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: |
 *           The raw image bytes. `Content-Type` matches what was uploaded (`image/png`,
 *           `image/jpeg`, `image/webp`, `image/gif`, …), falling back to
 *           `application/octet-stream` only if none was recorded. `Cache-Control` is
 *           `public, max-age=31536000, immutable` for genuinely public objects (public-topic
 *           images, avatars) and `private, max-age=31536000, immutable` for private/secret-topic
 *           images and ungated user uploads — the `private` responses must never be cached by a
 *           shared proxy/CDN in front of the app, only by the requesting client itself.
 *         content:
 *           image/*:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string[] }> }) {
  try {
    const { key: segments } = await params;
    const parsed = parseMediaObjectKey(segments ?? []);
    if (!parsed) {
      logger.warn(ROUTE, 'Rejected media key', { segments });
      return NextResponse.json({ error: 'Invalid media key' }, { status: 400 });
    }
    const objectKey = segments.join('/');
    const session = await getSession(request);

    let cachePublic = true;
    if (parsed.kind === 'topic-post' || parsed.kind === 'topic-image') {
      const gate = await gateTopicScoped(parsed.topicId, session);
      if (gate.deny) return gate.deny;
      cachePublic = gate.cachePublic;
    } else if (parsed.kind === 'user-upload') {
      const gate = await gateUserUpload(parsed.userId, objectKey, session);
      if (gate.deny) return gate.deny;
      cachePublic = gate.cachePublic;
    }
    /*
     * AVATAR_IS_UNGATED: `parsed.kind === 'avatar'` falls through with no
     * check at all, on purpose.
     *
     * A profile picture is ONE image shared across every post, comment, and
     * chat message a user has ever sent — it isn't scoped to any single
     * topic's visibility. The instant that user posts ONCE in any public
     * topic (the overwhelmingly common case — most topics are public), their
     * avatar is already visible to every guest who loads that topic, gate or
     * no gate. Refusing it here would not protect the picture; it would only
     * 404 it for the one context (a private-topic member list, say) where a
     * viewer who will see it in public anyway happens to ask first. That is
     * pure breakage with no confidentiality purchased, so it stays what every
     * other CDN avatar URL on the internet already is: world-readable.
     */

    const object = await getR2ObjectWithMeta(objectKey);
    if (!object) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // `Buffer.from` copies into a definite `ArrayBuffer`-backed view: the AWS
    // SDK's `transformToByteArray()` returns `Uint8Array<ArrayBufferLike>`
    // (SharedArrayBuffer-compatible), which `BodyInit` does not accept as-is.
    return new NextResponse(Buffer.from(object.bytes), {
      status: 200,
      headers: {
        'Content-Type': object.contentType ?? 'application/octet-stream',
        // Private/secret-topic images must never sit in a SHARED cache (a CDN
        // or proxy in front of Cloud Run) keyed only by URL — two different
        // callers with two different authorization outcomes must never be
        // served the same cached response. Public-topic and avatar bytes are
        // genuinely public, so they get the long, shared-cacheable header
        // `uploadToR2`'s objects have always implied.
        'Cache-Control': cachePublic
          ? 'public, max-age=31536000, immutable'
          : 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
