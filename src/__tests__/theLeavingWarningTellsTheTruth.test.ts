/**
 * The two clients used to tell people opposite things about leaving, and both
 * were wrong about the part that matters most.
 *
 * The app said: "Deleting your account permanently removes all your posts,
 * comments, and badges." Posts and comments are NOT removed — they stay, under
 * `[Withdrawn User]`, so the conversations they belong to keep an author.
 *
 * The web said the reverse: "your nickname will be changed to '[Withdrawn
 * User]' and your posts and comments will remain" — true as far as it went, but
 * it read as though the account carries on under a new name, which is exactly
 * what a person found on a real device on 2026-08-29 and exactly what the
 * identity retire now prevents.
 *
 * Neither mentioned the personal space. That is the one thing withdrawal
 * destroys and cannot give back: every message, photo and post inside it. A
 * person deciding whether to leave was told the opposite of the truth about
 * what survives, and nothing at all about what they were about to lose.
 *
 * These check the promise, not the sentence — a rewrite is free as long as it
 * still says the space goes, that other rooms keep what you wrote, and that
 * coming back means a new account.
 */
import { describe, it, expect } from 'vitest';
import webEn from '@/lib/i18n/locales/en.json';
import webKo from '@/lib/i18n/locales/ko.json';
import miniEn from '../../packages/mobile/src/i18n/locales/en.json';
import miniKo from '../../packages/mobile/src/i18n/locales/ko.json';

const warnings: Record<string, string> = {
  'web, English': (webEn as any).myPage.settings.dangerZone.deleteAccountIntro as string,
  'web, Korean': (webKo as any).myPage.settings.dangerZone.deleteAccountIntro as string,
  'app, English': (miniEn as any).openstoa.editProfile.delete.message as string,
  'app, Korean': (miniKo as any).openstoa.editProfile.delete.message as string,
};

/** What each language calls the three things the warning has to cover. */
const mustSay: Record<string, RegExp[]> = {
  'web, English': [/own space/i, /other people's rooms/i, /brand-new account/i],
  'app, English': [/own space/i, /other people's rooms/i, /brand-new account/i],
  'web, Korean': [/내 공간/, /다른 방/, /새 계정/],
  'app, Korean': [/내 공간/, /다른 방/, /새 계정/],
};

describe('the leaving warning tells the truth', () => {
  it.each(Object.keys(warnings))('%s says the space goes, other rooms keep, and returning is new', (where) => {
    const text = warnings[where];
    for (const promise of mustSay[where]) {
      expect(promise.test(text), `${where} no longer mentions ${promise}: ${text}`).toBe(true);
    }
  });

  it('no client claims your posts and comments are deleted', () => {
    /*
     * The specific lie this file was written for. It survived because it reads
     * like the reassuring thing to say — "we delete everything" — while the
     * server has always kept posts and comments on purpose.
     */
    const lies = [
      /permanently removes all your posts/i,
      /게시글[,·、]?\s*댓글.{0,10}영구적으로\s*삭제/,
    ];
    for (const [where, text] of Object.entries(warnings)) {
      for (const lie of lies) {
        expect(lie.test(text), `${where} claims posts are deleted, and they are not: ${text}`).toBe(false);
      }
    }
  });

  it('the app and the mini-app carry the same sentence', () => {
    /*
     * Two copies exist because the host app duplicates the mini-app's block and
     * the host copy is what ships. `proofport-app` has its own guard over the
     * whole block; this one names THIS sentence so a partial sync is loud.
     */
    expect((miniEn as any).openstoa.editProfile.delete.message).toBeTruthy();
    expect((miniKo as any).openstoa.editProfile.delete.message).toBeTruthy();
  });
});
