/**
 * Which URLs the app will open on a tap.
 *
 * WHAT WAS WRONG. A link in a post body arrives as whatever the author typed.
 * `PostDetailScreen` passed the raw `href` to `navigation.navigate(
 * 'InAppBrowser', { url })`, and that screen handed it straight to
 * `<WebView source={{ uri: url }} javaScriptEnabled />`. Nothing between the
 * author and the WebView asked what scheme it was.
 *
 * Post bodies could carry `javascript:` and `file:` hrefs — the web renderer
 * now strips those before they reach a DOM, but the app is a second renderer
 * reading the same field, and it had its own answer to the same question. That
 * shape (one rule, two implementations, only one of them checked) is the one
 * that keeps producing these.
 *
 * `http(s)` only. Not because other schemes are always harmful, but because
 * this is the ONLY thing the in-app browser is for: showing a web page the
 * author linked. A wallet deep link or `mailto:` is a different action that
 * belongs to a different handler, and one is not a fallback for the other.
 */
export function isOpenableUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  /*
   * Fold the escapes a browser folds before comparing. `java&#9;script:`,
   * ` javascript:` and `JaVaScRiPt:` all reach the platform as the same thing,
   * so testing the string as typed proves nothing.
   */
  const collapsed = raw
    .replace(/&#(\d+);?/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[\x00-\x20]/g, '')
    .toLowerCase();

  return collapsed.startsWith('http://') || collapsed.startsWith('https://');
}
