/*
 * WHAT WAS WRONG. A link in a post body is whatever its author typed.
 * `PostDetailScreen` handed the raw `href` to
 * `navigation.navigate('InAppBrowser', { url })`, and that screen passed it
 * to `<WebView source={{ uri: url }} javaScriptEnabled domStorageEnabled />`.
 * Nothing on the way asked what scheme it was.
 *
 * The web renderer strips `javascript:` before it can become a DOM, but the
 * app is a SECOND renderer of the same `post.content` field and had its own
 * answer to the same question. That shape — one rule, two implementations,
 * only one of them checked — is the one that keeps producing these.
 *
 * `isOpenableUrl` is the check both exits now share: the in-app browser and
 * the `Linking.openURL` fallback in `PostContent`.
 */
import { describe, it, expect } from 'vitest';
import { isOpenableUrl } from '../utils/safeExternalUrl';

describe('only a web address opens', () => {
  it.each([
    'https://example.com',
    'http://example.com',
    'https://example.com/path?q=1#frag',
    'HTTPS://EXAMPLE.COM',
    'https://openstoa.xyz/topics/abc/posts/def',
  ])('opens %s', (url) => {
    expect(isOpenableUrl(url)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java&#9;script:alert(1)',
    'java&#x09;script:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'content://com.android.providers/x',
    'intent://scan/#Intent;scheme=zxing;end',
    'zkproofport://x',
    'wc:abc@1',
    'mailto:someone@example.com',
    'tel:+15551234',
    'about:blank',
    'blob:https://example.com/uuid',
  ])('refuses %s', (url) => {
    expect(isOpenableUrl(url)).toBe(false);
  });

  it.each(['', '   ', 'not a url', '//example.com', '/relative/path', 'example.com'])(
    'refuses %s, which names no scheme',
    (url) => {
      expect(isOpenableUrl(url)).toBe(false);
    },
  );

  it('refuses null and undefined rather than throwing', () => {
    expect(isOpenableUrl(null)).toBe(false);
    expect(isOpenableUrl(undefined)).toBe(false);
  });

  it('a scheme hidden behind an http-looking prefix is still refused', () => {
    // The check is a prefix test, so these must not be mistaken for http.
    expect(isOpenableUrl('xhttp://example.com')).toBe(false);
    expect(isOpenableUrl('javascript:void(location="http://x")')).toBe(false);
  });
});
