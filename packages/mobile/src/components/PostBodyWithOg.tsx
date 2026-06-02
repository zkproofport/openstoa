import React from 'react';
import { PostContent } from './PostContent';
import { OGPreviewCard } from './OGPreviewCard';
import { useOgPreview } from '../hooks/useOgPreview';

interface PostBodyWithOgProps {
  /** Already-stripped content (call `stripVideoUrls` upstream). */
  content: string;
  /**
   * Where to send a link tap. Both inline `<a>` taps and the OG card
   * tap go through this so callers route them into the in-app WebView
   * instead of `Linking.openURL` (which kicks the user out to Safari
   * and breaks the back-stack).
   */
  onOpenUrl: (url: string) => void;
  /** Forwarded to PostContent — clip long bodies in feed cards. */
  maxLines?: number;
}

/**
 * Render a post body together with its OpenGraph preview card.
 *
 * Web's SNSContent renders an OG card under any post that contains a
 * URL. The mobile mini-app didn't, so post bodies that were just a
 * raw URL looked like plain text. This component matches the web
 * behaviour and is shared between PostDetailScreen and PostCard.
 *
 * The OG fetch lives in `useOgPreview` and is React Query cached, so
 * the same URL across multiple feed cards only resolves once.
 */
export function PostBodyWithOg({ content, onOpenUrl, maxLines }: PostBodyWithOgProps) {
  const { firstUrl, ogData, hasOG } = useOgPreview(content);
  return (
    <>
      <PostContent content={content} onPressLink={onOpenUrl} maxLines={maxLines} />
      {firstUrl && hasOG && ogData ? (
        <OGPreviewCard url={firstUrl} data={ogData} onPress={() => onOpenUrl(firstUrl)} />
      ) : null}
    </>
  );
}
