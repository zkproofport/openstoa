/**
 * The mini-app's half of the invite flow.
 *
 * Mobile could already mint a token — it was the surface that got this right —
 * but it shared a bare CODE, and a code cannot carry history: the epoch keys
 * ride in a URL fragment, and there is no fragment without a URL. The receiving
 * half had the mirror problem: the join prompt took a code, so a pasted link
 * had its fragment thrown away on the way in, silently.
 *
 * Source-level assertions are used where a render test would need the whole
 * React Native runtime (the established pattern here — see
 * `chatTierMobileSurface.test.ts`). Each names the exact call that must be
 * present, so it fails on removal rather than on refactor.
 *
 * EDGE-CASE MATRIX → coverage in this file
 *   contract          → shares a LINK built by the shared builder; imports only
 *                       after the join returns; both catalogues carry the copy
 *   contract-invoc.   → the share path calls the invite API and `buildInviteUrl`;
 *                       the join path calls `parseInviteLink` + `readInviteHistory`
 *   integrity         → the fragment is never put in a request path or body
 *   UTF-8             → the Korean copy is Korean in both catalogues
 *   boundary/hostile/empty → covered against the shared module in
 *                       `inviteLink.test.ts`, which both clients import
 *                       byte-identically; not re-asserted per platform
 *   authorization     → server-side (`/api/topics/{id}/invite` is owner/admin
 *                       for the invite-only tiers) — N/A to this surface
 *   race              → N/A: the share sheet and the join prompt are each
 *                       guarded by their own in-flight state, asserted for the
 *                       web equivalents in `inviteFlow.test.tsx`
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import enWeb from '@/lib/i18n/locales/en.json';
import koWeb from '@/lib/i18n/locales/ko.json';
import enMobile from '../../packages/mobile/src/i18n/locales/en.json';
import koMobile from '../../packages/mobile/src/i18n/locales/ko.json';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

const SHARE_MODAL = 'packages/mobile/src/components/InviteShareModal.tsx';
const TOPICS_HOME = 'packages/mobile/src/screens/topics/TopicsHomeScreen.tsx';
const TOPIC_DETAIL = 'packages/mobile/src/screens/topics/TopicDetailScreen.tsx';

describe('sharing an invite from the mini-app', () => {
  it('CONTRACT-INVOCATION: mints a token and builds the link with the SHARED builder', () => {
    const src = read(SHARE_MODAL);
    expect(src).toContain('/api/topics/${topicId}/invite');
    expect(src).toContain('buildInviteUrl(');
    // Not hand-assembled: the fragment format and its ceiling live in one place.
    expect(src).not.toMatch(/#h1=/);
  });

  it('CONTRACT: shares a LINK, not a bare code', () => {
    // A code cannot carry a fragment, and the fragment is the only channel the
    // history keys travel by.
    expect(enMobile.openstoa.topics.invite.shareBody).toContain('{{link}}');
    expect(enMobile.openstoa.topics.invite.shareBody).not.toContain('{{code}}');
    expect(koMobile.openstoa.topics.invite.shareBody).toContain('{{link}}');
  });

  it('CONTRACT: the choice is bounded by the SHARED policy, not a local number', () => {
    const src = read(SHARE_MODAL);
    expect(src).toContain('INVITE_HISTORY_EPOCHS_MAX');
    expect(src).toContain('INVITE_HISTORY_EPOCHS_DEFAULT');
    // public / dm get no control at all — the policy already answers 0 for them.
    expect(src).toContain('inviteHistoryEpochs(tier, undefined) > 0');
  });

  it('the topic screen opens the dialog rather than sharing immediately', () => {
    // The choice of how much history rides along is made before the link exists.
    const src = read(TOPIC_DETAIL);
    expect(src).toContain('<InviteShareModal');
    expect(src).toContain('setInviteOpen(true)');
    expect(src).not.toContain('inviteMutation');
  });
});

describe('opening an invite in the mini-app', () => {
  it('CONTRACT-INVOCATION: parses the paste, then imports AFTER the join', () => {
    const src = read(TOPICS_HOME);
    expect(src).toContain('parseInviteLink(pasted)');
    expect(src).toContain('readInviteHistory(invite.fragment, res.topicId)');
    expect(src).toContain('importInviteHistory(res.topicId, read.taks)');
    // Order matters: a link whose token expired can still carry a good
    // fragment, and importing from it would key a topic this device is not in.
    expect(src.indexOf('client.post<InviteJoinResponse>')).toBeLessThan(
      src.indexOf('importInviteHistory('),
    );
  });

  it('INTEGRITY: only the CODE is put in the request path — never the fragment', () => {
    const src = read(TOPICS_HOME);
    expect(src).toContain('encodeURIComponent(invite.code)');
    expect(src).not.toContain('invite.fragment}`');
    // The mutation posts no body at all, so no key can ride in one.
    expect(src).not.toMatch(/client\.post<InviteJoinResponse>\([^)]*,\s*\{/);
  });

  it('CONTRACT: re-opening the same link is reported as "already have it", not as more', () => {
    const src = read(TOPICS_HOME);
    expect(src).toContain("added > 0 ? added : 'already'");
  });

  it('the prompt asks for a link OR a code, so a pasted link is not user error', () => {
    expect(enMobile.openstoa.topics.invite.hint.toLowerCase()).toContain('link');
    expect(koMobile.openstoa.topics.invite.hint).toContain('링크');
  });
});

describe('the two clients say the same thing', () => {
  it('CONTRACT: the history warning is one sentence, shared word for word', () => {
    expect(enMobile.openstoa.topics.invite.keysWarning).toBe(enWeb.invite.keysWarning);
    expect(enMobile.openstoa.topics.invite.historyNoneSummary).toBe(enWeb.invite.historyNoneSummary);
    expect(enMobile.openstoa.topics.invite.historySummary).toBe(enWeb.invite.historySummary);
  });

  it('UTF-8: the Korean copy is Korean in both catalogues, and identical', () => {
    expect(koMobile.openstoa.topics.invite.keysWarning).toBe(koWeb.invite.keysWarning);
    expect(koMobile.openstoa.topics.invite.keysWarning).toMatch(/[가-힣]/);
  });

  it('both catalogues carry every string the share dialog asks for', () => {
    const src = read(SHARE_MODAL);
    const keys = [...src.matchAll(/t\('openstoa\.topics\.invite\.(\w+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(5);
    for (const key of new Set(keys)) {
      expect(
        (enMobile.openstoa.topics.invite as Record<string, string>)[key],
        `en.${key}`,
      ).toBeTruthy();
      expect(
        (koMobile.openstoa.topics.invite as Record<string, string>)[key],
        `ko.${key}`,
      ).toBeTruthy();
    }
  });
});

/**
 * The mini-app's half of the delivery cursor (R-1).
 *
 * Source-level for the same reason as the tier surface above: mounting the RN
 * chat room needs the whole React Native runtime (task T-1). Each assertion
 * names the exact call that must be present, so it fails on removal.
 */
describe('the mini-app acknowledges delivery', () => {
  const TRANSPORT = 'packages/mobile/src/crypto/mobileTransport.ts';
  const CHAT_ROOM = 'packages/mobile/src/screens/chat/ChatRoomScreen.tsx';

  it('CONTRACT: both arrival paths ack — the history page and the catch-up', () => {
    // Only one of the two would leave a device that reconnects pinning
    // ciphertext it has in fact received.
    const src = read(CHAT_ROOM);
    const calls = src.match(/ackDeliveryMls\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('CONTRACT: the rule is the twinned one, and only the POST is local', () => {
    const src = read(TRANSPORT);
    expect(src).toContain("import { ackDelivery } from '../lib/chatDeliveryAck'");
    expect(src).toContain('/chat/delivered');
  });

  it('EMPTY: a purged row asks this device’s cache before rendering as unreadable', () => {
    /*
     * A row whose live copy the server reclaimed arrives with no sealed body.
     * Without the cache lookup a purge turns a user's own readable history into
     * placeholders after one restart.
     */
    const src = read(TRANSPORT);
    expect(src).toMatch(/else if \(raw\.id\)/);
    expect(src).toContain("openCached(topicId, raw.id, { ciphertext: '', epoch: 0 })");
  });

  it('the stale "identity is in-memory" note is gone — it described a bug that does not exist', () => {
    // `mlsSession` persists `mls.identity` and reuses it; the old comment read
    // as leaf churn on every restart, which is the kind of thing that gets
    // "fixed" into a real regression.
    const src = read(TRANSPORT);
    expect(src).not.toContain('Stable cross-restart identity is a follow-up');
  });
});
