/**
 * Stand-in for `react-native-render-html`, which — like
 * `react-native-safe-area-context` next door — is installed only in the HOST
 * app and is unreachable from this workspace's module resolution.
 *
 * WHAT IT DOES NOT CLAIM TO TEST. This renders a host element that keeps its
 * props; it does not parse HTML, and it does not thread
 * `provideEmbeddedHeaders` down to an `<Image>` the way the real library does.
 * So a test using it can ask "does `PostContent` hand the renderer a header
 * provider, and does that provider answer correctly for a given uri" — which
 * is OUR half of the contract, and the half a future edit can silently delete
 * — but it cannot prove the library then uses the answer.
 *
 * That second half was settled by reading the installed v6.3.4 source rather
 * than by mocking it: `useIMGNormalizedSource.ts:15-30` calls
 * `provideEmbeddedHeaders(source.uri, 'img', …)` and merges the result into
 * `source.headers`, and `useIMGElementState.ts` then dispatches to
 * `Image.getSizeWithHeaders` instead of `Image.getSize` when headers are
 * present — so both the display fetch and the intrinsic-dimension probe carry
 * them. A stub that pretended to do that would be asserting a fiction.
 */
import React from 'react';

type AnyProps = Record<string, unknown>;

const RenderHtml = (props: AnyProps) => React.createElement('RenderHtml', props);
RenderHtml.displayName = 'RenderHtml';

export default RenderHtml;

export const defaultSystemFonts: string[] = ['System'];
