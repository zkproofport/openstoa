import { describe, it, expect } from 'vitest';
import {
  authGet,
  authPost,
  authPut,
  authPatch,
  publicGet,
  getSecondUserToken,
  secondUserPost,
  secondUserGet,
  secondUserDelete,
  authDelete,
  getBaseUrl,
} from './helpers';

/**
 * Phase 3 E2E (Stage A — server DS): TAK back-fill over a real HTTP server.
 *
 * Exercises the live edge-matrix rows: the envelope/CVE gate (recipient must be
 * a member with a published device), scope allowlist (hostile reject), size cap,
 * authz (guest 401 / non-member 403), archive idempotency + keyset since=
 * round-trip, and the public-only single-winner holder lease + coverage fence.
 * The server only ever sees opaque ciphertext (C1/SI-1).
 */

const B64 = (s: string) => Buffer.from(s).toString('base64');

/**
 * The archive-root identity this suite's public topic gets. The server compares
 * it as an opaque string (C1) — deriving it from a real root is the client's job
 * — so a fixed literal exercises the endpoint exactly as a real holder does.
 */
const HOLDER_ROOT_FP = 'e2e-holder-root-fingerprint';

/** Mint a fresh, never-joined user for non-member authz checks. */
async function freshUser(): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${getBaseUrl()}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: `e2e_tak_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status}`);
  return res.json();
}

let categoryId: string;
let publicTopicId: string;
let recipient: { token: string; userId: string };
const RECIPIENT_DEVICE = 'tak-b-device-1';

describe.sequential('TAK back-fill — server Delivery Service', () => {
  // ── Setup ──────────────────────────────────────────────────────────────
  it('setup: categories + public topic by A', async () => {
    const cats = await authGet('/api/categories');
    categoryId = (await cats.json()).categories[0].id;
    const res = await authPost('/api/topics', {
      title: `E2E TAK ${Date.now()}`,
      description: 'TAK back-fill tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    publicTopicId = (await res.json()).topic.id;
  });

  it('setup: recipient B joins the public topic + publishes a device KeyPackage', async () => {
    recipient = await getSecondUserToken();
    const join = await secondUserPost(`/api/topics/${publicTopicId}/join`);
    expect([201, 200]).toContain(join.status);
    const kp = await secondUserPost(`/api/topics/${publicTopicId}/mls/key-packages`, {
      keyPackage: B64('fake-public-keypackage-bytes-for-envelope-check'),
      deviceId: RECIPIENT_DEVICE,
    });
    expect(kp.status).toBe(201);
  });

  // ── TAK bundle: envelope gate + happy path ───────────────────────────────
  it('1. A delivers a TAK bundle to B device -> 201', async () => {
    const res = await authPost(`/api/topics/${publicTopicId}/tak/bundles`, {
      recipientUserId: recipient.userId,
      recipientDeviceId: RECIPIENT_DEVICE,
      bundle: B64('hpke-wrapped-tak-bundle'),
      scope: 'full',
    });
    expect(res.status).toBe(201);
    expect((await res.json()).id).toBeTruthy();
  });

  it('2. B fetches its pending bundle, acks it, then sees none', async () => {
    const res = await secondUserGet(`/api/topics/${publicTopicId}/tak/bundles?deviceId=${RECIPIENT_DEVICE}`);
    expect(res.status).toBe(200);
    const { bundles } = await res.json();
    expect(bundles.length).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(bundles[0].bundle, 'base64').toString()).toBe('hpke-wrapped-tak-bundle');
    expect(bundles[0].scope).toBe('full');

    const ack = await fetch(`${getBaseUrl()}/api/topics/${publicTopicId}/tak/bundles`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${recipient.token}` },
      body: JSON.stringify({ deviceId: RECIPIENT_DEVICE, ids: bundles.map((b: { id: string }) => b.id) }),
    });
    expect(ack.status).toBe(200);
    expect((await ack.json()).acked).toBeGreaterThanOrEqual(1);

    const after = await secondUserGet(`/api/topics/${publicTopicId}/tak/bundles?deviceId=${RECIPIENT_DEVICE}`);
    expect((await after.json()).bundles.length).toBe(0);
  });

  it('3. recipientUserId is informational (addressing is by device) — member caller -> 201', async () => {
    // The MLS leaf credential is a device id, not the user nullifier, so the
    // server cannot map recipientUserId to a member and does not gate on it.
    // A member caller may post with any recipientUserId; the bundle is addressed
    // and HPKE-sealed by device. (Caller-must-be-member is covered by test 7.)
    const stranger = await freshUser();
    const res = await authPost(`/api/topics/${publicTopicId}/tak/bundles`, {
      recipientUserId: stranger.userId,
      recipientDeviceId: 'some-leaf-device',
      bundle: B64('b'),
      scope: 'full',
    });
    expect(res.status).toBe(201);
  });

  it('4. envelope gate: a member recipient is accepted with any leaf-derived device id -> 201', async () => {
    // The server addresses bundles by an opaque leaf-derived device id (clients
    // publish no KeyPackage for genesis/External-Commit), so it does NOT gate on
    // a device directory — only on membership. The CVE device-identity check is
    // client-side (wrap only to a validated ratchet-tree leaf key).
    const res = await authPost(`/api/topics/${publicTopicId}/tak/bundles`, {
      recipientUserId: recipient.userId,
      recipientDeviceId: 'leaf-derived-device-id',
      bundle: B64('b'),
      scope: 'full',
    });
    expect(res.status).toBe(201);
  });

  it('5. hostile scope -> 400', async () => {
    const res = await authPost(`/api/topics/${publicTopicId}/tak/bundles`, {
      recipientUserId: recipient.userId,
      recipientDeviceId: RECIPIENT_DEVICE,
      bundle: B64('b'),
      scope: 'full; DROP TABLE chat_archive',
    });
    expect(res.status).toBe(400);
  });

  it('6. oversized bundle (>64 KiB) -> 400', async () => {
    const res = await authPost(`/api/topics/${publicTopicId}/tak/bundles`, {
      recipientUserId: recipient.userId,
      recipientDeviceId: RECIPIENT_DEVICE,
      bundle: Buffer.alloc(64 * 1024 + 1, 1).toString('base64'),
      scope: 'full',
    });
    expect(res.status).toBe(400);
  });

  it('7. guest fetch -> 401, non-member fetch -> 403', async () => {
    const guest = await publicGet(`/api/topics/${publicTopicId}/tak/bundles?deviceId=${RECIPIENT_DEVICE}`);
    expect(guest.status).toBe(401);

    const stranger = await freshUser();
    const res = await fetch(`${getBaseUrl()}/api/topics/${publicTopicId}/tak/bundles?deviceId=x`, {
      headers: { Authorization: `Bearer ${stranger.token}` },
    });
    expect(res.status).toBe(403);
  });

  // ── Archive: idempotency + keyset since= round-trip ──────────────────────
  it('8. A stores archive rows; second store of same message is an idempotent no-op', async () => {
    const msgId = crypto.randomUUID();
    const first = await authPost(`/api/topics/${publicTopicId}/archive`, {
      messageId: msgId,
      takVersion: 1,
      archive: B64('archived-body-1'),
    });
    expect(first.status).toBe(201);
    const dup = await authPost(`/api/topics/${publicTopicId}/archive`, {
      messageId: msgId,
      takVersion: 1,
      archive: B64('archived-body-1-changed'),
    });
    expect(dup.status).toBe(200);
    expect((await dup.json()).stored).toBe(false);
  });

  it('9. since= keyset pagination returns every archived row once, in order', async () => {
    // Seed a few more rows so pagination has something to walk.
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) {
      const r = await authPost(`/api/topics/${publicTopicId}/archive`, {
        messageId: id,
        takVersion: 1,
        archive: B64(`body-${id}`),
      });
      expect([200, 201]).toContain(r.status);
    }
    // Walk pages of 2 via the compound cursor.
    const seen: string[] = [];
    let url = `/api/topics/${publicTopicId}/archive?limit=2`;
    for (let guard = 0; guard < 20; guard++) {
      const res = await secondUserGet(url);
      expect(res.status).toBe(200);
      const { archive } = await res.json();
      if (archive.length === 0) break;
      for (const a of archive) seen.push(a.messageId);
      const last = archive[archive.length - 1];
      url = `/api/topics/${publicTopicId}/archive?limit=2&since=${encodeURIComponent(last.createdAt)}&sinceMsg=${last.messageId}`;
      if (archive.length < 2) break;
    }
    // Every seeded id appears exactly once.
    for (const id of ids) expect(seen.filter((s) => s === id).length).toBe(1);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('10. archive: guest -> 401, non-member -> 403', async () => {
    expect((await publicGet(`/api/topics/${publicTopicId}/archive`)).status).toBe(401);
    const stranger = await freshUser();
    const res = await fetch(`${getBaseUrl()}/api/topics/${publicTopicId}/archive`, {
      headers: { Authorization: `Bearer ${stranger.token}` },
    });
    expect(res.status).toBe(403);
  });

  // ── Holder: public-only, single-winner, coverage fence ───────────────────
  it('11. owner A claims the holder lease -> 200; B claim while valid -> 409', async () => {
    // A names the root it holds. This topic has no published root yet, so A's
    // fingerprint becomes the topic's — and B must then present the SAME one.
    const claim = await authPost(`/api/topics/${publicTopicId}/tak/holder`, {
      deviceId: 'a-device-1',
      rootFingerprint: HOLDER_ROOT_FP,
    });
    expect(claim.status).toBe(200);
    expect((await claim.json()).holder.holderUserId).toBeTruthy();

    const contest = await secondUserPost(`/api/topics/${publicTopicId}/tak/holder`, {
      deviceId: 'b-device-1',
      rootFingerprint: HOLDER_ROOT_FP,
    });
    expect(contest.status).toBe(409);
  });

  it('11a. a claim with no rootFingerprint -> 400 (a device with no root cannot hold)', async () => {
    const res = await authPost(`/api/topics/${publicTopicId}/tak/holder`, { deviceId: 'a-device-1' });
    expect(res.status).toBe(400);
  });

  it('11b. a claim naming a DIFFERENT root -> 403 (would serve a key opening nothing)', async () => {
    const res = await secondUserPost(`/api/topics/${publicTopicId}/tak/holder`, {
      deviceId: 'b-device-1',
      rootFingerprint: 'a-root-this-topic-never-had',
    });
    expect(res.status).toBe(403);
    // The topic's published identity is unchanged by a rejected claim.
    expect((await res.json()).fingerprint).toBe(HOLDER_ROOT_FP);
  });

  it('11c. DELETE releases only the caller OWN lease, and frees succession', async () => {
    // B does not hold the lease, so its release is a no-op on A's.
    const notMine = await secondUserDelete(
      `/api/topics/${publicTopicId}/tak/holder?deviceId=${encodeURIComponent('a-device-1')}`,
    );
    expect(notMine.status).toBe(200);
    expect((await notMine.json()).released).toBe(false);
    expect((await (await authGet(`/api/topics/${publicTopicId}/tak/holder`)).json()).holder.holderDeviceId).toBe(
      'a-device-1',
    );

    const mine = await authDelete(
      `/api/topics/${publicTopicId}/tak/holder?deviceId=${encodeURIComponent('a-device-1')}`,
    );
    expect(mine.status).toBe(200);
    expect((await mine.json()).released).toBe(true);

    // Lease expired, so B can now take over — this is the unblocking that a
    // stuck rootless holder previously made impossible.
    const takeover = await secondUserPost(`/api/topics/${publicTopicId}/tak/holder`, {
      deviceId: 'b-device-1',
      rootFingerprint: HOLDER_ROOT_FP,
    });
    expect(takeover.status).toBe(200);

    // Restore A as holder so the later coverage/GET cases see the same state.
    await secondUserDelete(`/api/topics/${publicTopicId}/tak/holder?deviceId=${encodeURIComponent('b-device-1')}`);
    await authPost(`/api/topics/${publicTopicId}/tak/holder`, {
      deviceId: 'a-device-1',
      rootFingerprint: HOLDER_ROOT_FP,
    });
  });

  it('11d. DELETE without deviceId -> 400', async () => {
    expect((await authDelete(`/api/topics/${publicTopicId}/tak/holder`)).status).toBe(400);
  });

  it('12. GET holder reflects A as holder', async () => {
    const res = await authGet(`/api/topics/${publicTopicId}/tak/holder`);
    expect(res.status).toBe(200);
    const { holder } = await res.json();
    expect(holder.holderDeviceId).toBe('a-device-1');
  });

  it('13. coverage PATCH before MLS genesis -> 404 (no group); fence + not-holder are unit-covered', async () => {
    // No genesis Commit happened in this HTTP-only test, so there is no
    // mls_groups row. The epoch-fence (SI-7) locks that row first, so coverage
    // reporting returns no-group here. The future-epoch fence and not-holder
    // rejection are exercised against a real group in mls-archive.test.ts.
    const cov = await authPatch(`/api/topics/${publicTopicId}/tak/holder`, {
      deviceId: 'a-device-1',
      epochCovered: 0,
    });
    expect(cov.status).toBe(404);
  });

  it('14. SI-6b: holder ops on a private topic -> 400 (custodian-free)', async () => {
    // Real fixture over HTTP: POST /api/topics accepts visibility: 'private'
    // (VALID_VISIBILITIES in src/app/api/topics/route.ts) and auto-adds the
    // creator as owner, so no direct DB seeding is needed here.
    const createRes = await authPost('/api/topics', {
      title: `E2E TAK private ${Date.now()}`,
      description: 'SI-6b custodian-free check',
      visibility: 'private',
      categoryId,
    });
    expect(createRes.status).toBe(201);
    const privId = (await createRes.json()).topic.id as string;

    try {
      const res = await authPost(`/api/topics/${privId}/tak/holder`, {
        deviceId: 'a-device-1',
        rootFingerprint: HOLDER_ROOT_FP,
      });
      expect(res.status).toBe(400);
      const get = await authGet(`/api/topics/${privId}/tak/holder`);
      expect(get.status).toBe(400);
      const del = await authDelete(`/api/topics/${privId}/tak/holder?deviceId=a-device-1`);
      expect(del.status).toBe(400);
    } finally {
      await authDelete(`/api/topics/${privId}`);
    }
  });

  it.each(['private', 'secret'] as const)(
    '15. CONTAINMENT: the server refuses to hold a %s topic archive key, whatever the client believes',
    async (visibility) => {
      /*
       * The guard that GENERALISES, and the reason it lives here rather than in
       * a client test.
       *
       * `chatTierOf` maps an unrecognised visibility to `public` — deliberately,
       * because it also drives the E2EE BANNER and a wrong value there must
       * under-promise rather than claim encryption we are not providing. But the
       * same function now also selects the KEY MODEL, and for that consumer
       * `public` is the permissive answer: it means "the server may hold this
       * key". The two consumers fail in opposite directions from one default.
       *
       * A client-side test can only pin the call sites that exist today. This
       * pins the BOUNDARY: whatever a present or future client believes about a
       * scoped topic, the deposit route refuses, so a tier mistake can cost
       * history but can never cost the key. Verified by sending the literal
       * request a mis-tiered client would send.
       */
      const createRes = await authPost('/api/topics', {
        title: `E2E TAK ${visibility} containment ${Date.now()}`,
        description: 'a mis-tiered client must not be able to deposit',
        visibility,
        categoryId,
      });
      expect(createRes.status).toBe(201);
      const id = (await createRes.json()).topic.id as string;

      try {
        // Exactly what a client that resolved the tier as `public` would send.
        const put = await authPut(`/api/topics/${id}/archive/root`, {
          rootKey: Buffer.alloc(32, 9).toString('base64'),
        });
        expect(put.status, 'the server accepted a scoped topic archive key').toBe(403);

        // And nothing is readable back, so a refusal cannot be mistaken for a
        // silent success by a client that only checks the GET.
        const get = await authGet(`/api/topics/${id}/archive/root`);
        expect(get.status).toBe(403);

        // The fingerprint surface belongs to the topic-root tiers only.
        const fp = await authGet(`/api/topics/${id}/tak/root-fingerprint`);
        expect(fp.status).toBe(400);
      } finally {
        await authDelete(`/api/topics/${id}`);
      }
    },
  );
});
