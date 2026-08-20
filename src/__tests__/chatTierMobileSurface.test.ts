/**
 * The mini-app's half of the tier claim.
 *
 * The mobile chat room had NO statement about encryption at all — the property
 * the product is built on was invisible there, and so was its exception (a
 * public room the service can read). This file holds the mini-app to the same
 * three things the web surface is held to: it derives the claim rather than
 * writing one, it says the same sentence the web says, and it opens the
 * explanation in the in-app WebView rather than punting to the browser.
 *
 * Source-level assertions are used where a render test would need the whole
 * React Native runtime. They are narrow on purpose: each one names the exact
 * call that must be present, so it fails on removal rather than on refactor.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   contract          → 'the chat room derives its claim', 'both creation and
 *                       chat open the tiers page through the WebView',
 *                       'the mini-app says the same sentence as the web'
 *   hostile input     → buildTiersUrl: non-http scheme, control characters,
 *                       whitespace, embedded query/fragment
 *   empty/null/undef  → buildTiersUrl: '', '   ', null, undefined, non-string
 *   very large input  → buildTiersUrl: a 3 000-character base URL
 *   UTF-8             → 'the Korean claim is Korean in both catalogues'
 *   boundary          → trailing slashes, a base URL carrying a path prefix
 *   authorization / race → N/A: URL construction and copy selection have no
 *                       caller identity and no async state.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import enWeb from '@/lib/i18n/locales/en.json';
import koWeb from '@/lib/i18n/locales/ko.json';
import enMobile from '../../packages/mobile/src/i18n/locales/en.json';
import koMobile from '../../packages/mobile/src/i18n/locales/ko.json';
import { TIERS_PATH, buildTiersUrl } from '../../packages/mobile/src/lib/docsLink';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

const CHAT_ROOM = 'packages/mobile/src/screens/chat/ChatRoomScreen.tsx';
const TOPIC_CREATE = 'packages/mobile/src/screens/topics/TopicCreateScreen.tsx';

describe('buildTiersUrl', () => {
  it('builds the absolute page URL from a usable base', () => {
    expect(buildTiersUrl('https://openstoa.xyz')).toBe(`https://openstoa.xyz${TIERS_PATH}`);
  });

  it('BOUNDARY: trailing slashes are collapsed, not doubled into the path', () => {
    expect(buildTiersUrl('https://openstoa.xyz/')).toBe(`https://openstoa.xyz${TIERS_PATH}`);
    expect(buildTiersUrl('https://openstoa.xyz///')).toBe(`https://openstoa.xyz${TIERS_PATH}`);
  });

  it('BOUNDARY: a base URL carrying a path prefix keeps it', () => {
    // A reverse-proxied deployment serves the app under a sub-path.
    expect(buildTiersUrl('https://host/openstoa')).toBe(`https://host/openstoa${TIERS_PATH}`);
  });

  it('drops a query or fragment the host appended', () => {
    expect(buildTiersUrl('https://openstoa.xyz?x=1')).toBe(`https://openstoa.xyz${TIERS_PATH}`);
    expect(buildTiersUrl('https://openstoa.xyz#frag')).toBe(`https://openstoa.xyz${TIERS_PATH}`);
  });

  it('EMPTY: empty, whitespace, null, undefined and non-strings return null', () => {
    // Each asserted separately: the caller hides the affordance on null, and a
    // row that opens a broken WebView is worse than a row that is not there.
    expect(buildTiersUrl('')).toBeNull();
    expect(buildTiersUrl('   ')).toBeNull();
    expect(buildTiersUrl(null)).toBeNull();
    expect(buildTiersUrl(undefined)).toBeNull();
    expect(buildTiersUrl(42)).toBeNull();
    expect(buildTiersUrl({})).toBeNull();
  });

  it('HOSTILE: a non-http scheme is refused rather than handed to a WebView', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'wc:1234', 'mailto:a@b.c', '//openstoa.xyz']) {
      expect(buildTiersUrl(bad), bad).toBeNull();
    }
  });

  it('HOSTILE: control characters anywhere in the base are refused', () => {
    // Written as escapes on purpose: a raw \x07 in a source file is invisible
    // in review and easy for an editor to eat, which is exactly how this class
    // of input slips past a naive "no whitespace" check in the first place.
    expect(buildTiersUrl('https://openstoa\u0007.xyz')).toBeNull();
    expect(buildTiersUrl('https://openstoa.xyz\u0000')).toBeNull();
    expect(buildTiersUrl('https://openstoa.xyz\u009F')).toBeNull();
  });

  it('LARGE: a 3 000-character base URL is refused', () => {
    expect(buildTiersUrl(`https://${'a'.repeat(3000)}.xyz`)).toBeNull();
  });

  it('CONTRACT: the path is the page the web app actually serves', () => {
    // `src/app/docs/tiers/page.tsx` — a rename there must break this.
    expect(TIERS_PATH).toBe('/docs/tiers');
    expect(() => read('src/app/docs/tiers/page.tsx')).not.toThrow();
  });
});

describe('the mini-app says what the web says', () => {
  const CLAIMS = ['e2ee', 'serverReadable', 'learnMore'] as const;

  it('CONTRACT: identical English copy in both catalogues', () => {
    for (const key of CLAIMS) {
      expect(enMobile.openstoa.chat.tierClaim[key], key).toBe(enWeb.chat.tierClaim[key]);
    }
  });

  it('UTF-8: identical Korean copy in both catalogues', () => {
    for (const key of CLAIMS) {
      expect(koMobile.openstoa.chat.tierClaim[key], key).toBe(koWeb.chat.tierClaim[key]);
    }
  });

  it('CONTRACT: the two claims are different sentences, and only one promises encryption', () => {
    const { e2ee, serverReadable } = enWeb.chat.tierClaim;
    expect(e2ee).not.toBe(serverReadable);
    expect(e2ee.toLowerCase()).toContain('end-to-end encrypted');
    expect(serverReadable.toLowerCase()).not.toContain('end-to-end encrypted');
    // …and it says plainly who can read it, rather than hedging.
    expect(serverReadable.toLowerCase()).toContain('can read');
  });

  it('CONTRACT: the claim is present tense about NEW content, not about the room', () => {
    /*
     * Images sent before encrypted attachments landed are still plaintext
     * objects at public URLs, so "this room is end-to-end encrypted" would be
     * false about the room's own history. Both locales are pinned so a later
     * edit cannot quietly widen the promise.
     */
    for (const copy of [enWeb.chat.tierClaim.e2ee, enMobile.openstoa.chat.tierClaim.e2ee]) {
      expect(copy.toLowerCase()).toContain('new messages');
      expect(copy.toLowerCase()).not.toMatch(/this room is end-to-end/);
    }
    for (const copy of [koWeb.chat.tierClaim.e2ee, koMobile.openstoa.chat.tierClaim.e2ee]) {
      expect(copy).toContain('새 메시지');
    }
  });
});

describe('the mini-app derives, and routes through the WebView', () => {
  it('CONTRACT: the chat room selects its claim with chatClaimKey', () => {
    const src = read(CHAT_ROOM);
    // Matched as two facts rather than as one exact import line: the point is
    // that the claim comes from the twinned explainer, not that the explainer
    // is the only thing imported from it. Pinning the whole line made adding a
    // second import from the same module look like a removal of the first.
    expect(src).toMatch(/import \{[^}]*\bchatClaimKey\b[^}]*\} from '\.\.\/\.\.\/lib\/chatTierExplainer'/);
    expect(src).toContain('chatTierOf(visibility, kind === \'dm\')');
    expect(src).toContain('openstoa.chat.tierClaim.${claim}');
  });

  it('CONTRACT: the chat room writes no claim of its own', () => {
    // A literal here would be a second source of truth that no policy change
    // can reach.
    const src = read(CHAT_ROOM);
    expect(src.toLowerCase()).not.toContain('end-to-end encrypted.');
  });

  it('CONTRACT: both mobile surfaces open the tiers page in the in-app WebView', () => {
    // Project-wide rule: every http(s) link goes through InAppBrowser, never
    // Linking.openURL, or the back stack breaks.
    for (const file of [CHAT_ROOM, TOPIC_CREATE]) {
      const src = read(file);
      expect(src, file).toContain("navigation.navigate('InAppBrowser', { url: tiersUrl })");
      expect(src, file).toContain('buildTiersUrl');
      expect(src, file).not.toContain('Linking.openURL(tiersUrl)');
    }
  });

  it('CONTRACT: the affordance is hidden when the host base URL is unusable', () => {
    // `tiersUrl ? … : null` — the null contract from buildTiersUrl, honoured at
    // both call sites rather than rendering a link that opens nothing.
    for (const file of [CHAT_ROOM, TOPIC_CREATE]) {
      expect(read(file), file).toContain('tiersUrl ? (');
    }
  });
});
