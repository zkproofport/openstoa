/**
 * Stand-ins for the two video players.
 *
 * Both draw into a native view and have no JavaScript to run off a device, so
 * they belong here beside the SVG and icon stand-ins rather than being
 * installed. Without them `MediaGallery` could not be imported at all — which
 * is why every picture it drew went untested until 2026-08-28.
 *
 * Rendered as named host elements keeping their props, so a test can still ask
 * which video was requested.
 */
import React from 'react';

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

const WebView = (props: AnyProps) => React.createElement('WebView', props, props.children);
WebView.displayName = 'WebView';

export const YoutubePlayer = (props: AnyProps) =>
  React.createElement('YoutubePlayer', props, props.children);
YoutubePlayer.displayName = 'YoutubePlayer';

export { WebView };
export default WebView;
