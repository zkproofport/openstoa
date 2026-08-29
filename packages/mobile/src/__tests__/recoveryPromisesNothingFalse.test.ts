/**
 * The recovery screens must not promise history they cannot deliver.
 *
 * THE DEFECT THIS CLOSES. After a successful recovery the screen said
 * "Recovered. Your chat history will reload." That is true of exactly one of
 * the four tiers.
 *
 * WHY. The backup blob holds the keys the OTHER device actually received —
 * `tak.manifest` tracks what was written, and an epoch that advanced while that
 * phone was off never reached it, so it was never in the manifest and is not in
 * the blob. This is not an upload failure; a hundred-percent-successful upload
 * still cannot carry a key that was never there.
 *
 *   public  → `keyDelivery: 'server'` — the server holds the archive root, so
 *             the whole room comes back.
 *   private → `invite-link`, and `grantPrivateHistory` can hand epochs over
 *             later, from a member who has them.
 *   secret  → `invite-link`, and the same source explicitly does NOT auto-grant.
 *   dm      → `peer-device` — the other person's device is the only source.
 *
 * And when nobody who holds that stretch is left, it is gone for good — the
 * intended consequence of an escrow-free design, stated in `grantPrivateHistory`
 * as "a full churn leaves the archive unrecoverable".
 *
 * Showing "history will reload" and then empty rooms is how a person concludes
 * the app lost their messages. That is worse than the truth and much harder to
 * walk back.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → the false promise string is gone from the source
 *   contract  → both recovery paths (code and passkey) show the gap notice
 *   integrity → the copy exists in BOTH locales, because a warning that only
 *               lands in English is not a warning for half the users
 *   integrity → the notice actually NAMES which rooms are affected, rather than
 *               being a vague apology
 *   boundary / hostile / UTF-8 / large / authz / race — N/A: this file is about
 *               what a screen claims, not about inputs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../i18n/locales/en.json';
import ko from '../i18n/locales/ko.json';

/*
 * Resolved from THIS FILE, not from `process.cwd()`.
 *
 * `.test.ts` files under `packages/mobile` run under two configs — the
 * mini-app's own, and the web root's, which excludes only `.test.tsx`. A
 * cwd-relative path is correct under one of them and reads a non-existent file
 * under the other, so the suite passed in one place and failed in the other for
 * a reason that had nothing to do with what is being tested.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCREEN = readFileSync(join(SRC, 'screens/profile/AccountRecoveryScreen.tsx'), 'utf8');

type Dict = Record<string, Record<string, Record<string, unknown>>>;

describe('the post-recovery message', () => {
  it('CONTRACT: the false promise is gone from the source', () => {
    // Named as a literal because that exact sentence is what shipped, and the
    // most likely way it comes back is someone pasting it in again.
    expect(SCREEN).not.toContain('Your chat history will reload');
  });

  it('CONTRACT: BOTH recovery paths show the gap notice', () => {
    // Code and passkey reach the same place by different routes; a fix applied
    // to one of them is how half of the users keep seeing the old promise.
    const notices = SCREEN.match(/openstoa\.recovery\.gapNotice/g) ?? [];
    expect(notices.length).toBeGreaterThanOrEqual(2);
  });

  it('INTEGRITY: the notice names which rooms, rather than apologising vaguely', () => {
    /*
     * "Some data may be unavailable" tells a person nothing they can act on.
     * The one useful fact is that OPEN rooms come back whole and the other
     * kinds wait on another member — so the notice has to say that.
     *
     * The words are the ones on screen: the room kinds were renamed to
     * Open / Invite-only / Secret on 2026-08-29 because "Private" promised
     * that the posts were hidden, and they are not.
     */
    const enNotice = ((en as unknown as Dict).openstoa.recovery.gapNotice as string).toLowerCase();
    expect(enNotice).toContain('open');
    expect(enNotice).toContain('invite-only');
    expect(enNotice).toContain('another member');
  });

  it('INTEGRITY: the warning exists in Korean too', () => {
    // A warning that only lands in English is not a warning for half the users.
    const koNotice = (ko as unknown as Dict).openstoa.recovery.gapNotice as string;
    expect(koNotice.length).toBeGreaterThan(40);
    expect(koNotice).toContain('공개');
    expect(koNotice).toContain('초대제');
  });

  it('CONTRACT: both locales carry every recovery key the screen asks for', () => {
    const used = [...SCREEN.matchAll(/openstoa\.recovery\.(\w+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const key of new Set(used)) {
      expect((en as unknown as Dict).openstoa.recovery[key], `en is missing ${key}`).toBeDefined();
      expect((ko as unknown as Dict).openstoa.recovery[key], `ko is missing ${key}`).toBeDefined();
    }
  });
});

describe('the second-device warning', () => {
  it('CONTRACT: the "ready" case still names the gap', () => {
    /*
     * A FRESH backup is not a complete one — it is complete as of its own
     * moment. Someone reading "you have a recent backup" and nothing else will
     * expect every room back.
     */
    for (const [name, dict] of [['en', en], ['ko', ko]] as const) {
      const body = (dict as unknown as Dict).openstoa.takeover.ready as unknown as {
        body: string;
      };
      expect(body.body.length, `${name} ready body is too short to say anything`).toBeGreaterThan(80);
    }
    const enReady = (
      (en as unknown as Dict).openstoa.takeover.ready as unknown as { body: string }
    ).body.toLowerCase();
    expect(enReady).toContain('another member');
  });

  it('INTEGRITY: the stale case says the only device that can fix it is the old one', () => {
    /*
     * The whole reason the question is asked BEFORE the takeover. Five seconds
     * later that phone is signed out and nothing can be done.
     */
    const enStale = (
      (en as unknown as Dict).openstoa.takeover.staleBackup as unknown as { body: string }
    ).body.toLowerCase();
    expect(enStale).toContain('only device');

    const koStale = (
      (ko as unknown as Dict).openstoa.takeover.staleBackup as unknown as { body: string }
    ).body;
    expect(koStale).toContain('그 폰뿐');
  });
});
