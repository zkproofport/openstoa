import React, { useCallback } from 'react';
import {
  Image,
  type ImageErrorEventData,
  type ImageProps,
  type NativeSyntheticEvent,
} from 'react-native';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { useMediaAuthToken } from '../hooks/useMediaAuthToken';
import { absolutizeMediaUrl } from '../utils/absolutizeMediaUrl';
import { gatedMediaHeaders } from '../utils/gatedMedia';

/**
 * `<Image>` for a URL that might be one of ours.
 *
 * Two things every remote picture in this app needs, in the order they have to
 * happen: resolve a stored root-relative `/api/media/...` path against the
 * app's origin (`absolutizeMediaUrl`, M-6 — React Native has no page origin to
 * resolve a relative `uri` against), then attach the session Bearer if — and
 * only if — the result addresses our own gated route (`gatedMediaHeaders`).
 * Both were previously spelled out at each render site, and the second one at
 * none of them, which is why every gated post image went blank in the app
 * while the same picture rendered fine on the web (the browser attaches the
 * session cookie by itself; `<Image>` sends nothing).
 *
 * Anything that is NOT ours passes through untouched, with the exact `{ uri }`
 * source shape it had before: a `file://` pick from the photo library, a
 * decrypted chat attachment on disk, a `data:` URI, a third-party image in a
 * post body. That is the whole point of routing them through here anyway —
 * one component that knows the difference beats eighteen call sites each
 * deciding for themselves.
 *
 * Takes `uri` rather than `source` deliberately. A caller cannot pass a source
 * ARRAY (multi-resolution), which React Native treats as one header set for
 * the whole array rather than per entry (`facebook/react-native#13697`, closed
 * as working-as-designed) — a shape that would silently mean something
 * different from what a reader expects here.
 */
export interface GatedImageProps extends Omit<ImageProps, 'source'> {
  /**
   * Absolute URL, root-relative `/api/media/...` path, `file://`, `data:` —
   * or null/undefined, which renders exactly what `source={{ uri: undefined }}`
   * always did at these call sites rather than collapsing to nothing.
   */
  uri: string | null | undefined;
}

export function GatedImage({ uri, onError, ...rest }: GatedImageProps) {
  const client = useOpenStoaClient();
  const baseUrl = client.getBaseUrl();
  const { token, reresolve } = useMediaAuthToken();

  const resolved = absolutizeMediaUrl(uri, baseUrl) ?? undefined;
  const headers = gatedMediaHeaders(resolved, baseUrl, token);

  const handleError = useCallback(
    (event: NativeSyntheticEvent<ImageErrorEventData>) => {
      // A gated image can fail for the ordinary reasons (offline, 404, a
      // secret topic this user really may not read) and for one narrow racy
      // one: it mounted holding a token the server had just stopped
      // accepting. `reresolve` costs a cached read in every case except that
      // one, and in that one it swaps the token, changes the source, and the
      // picture appears — where otherwise it would stay blank for the life of
      // the screen. It does not loop: the state only changes when the token
      // actually differs.
      reresolve();
      onError?.(event);
    },
    [onError, reresolve],
  );

  return (
    <Image
      {...rest}
      // `{ uri }` verbatim when there are no headers, NOT `{ uri, headers:
      // undefined }`: React Native's image cache keys on the source, and the
      // pass-through case must stay byte-for-byte the source it was before.
      source={headers ? { uri: resolved, headers } : { uri: resolved }}
      onError={handleError}
    />
  );
}
