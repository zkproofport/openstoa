/** Native paint surface; preserve children/props for rendered screen tests. */
import React from 'react';
export default function LinearGradient(props: Record<string, unknown> & { children?: React.ReactNode }) {
  return React.createElement('LinearGradient', props, props.children);
}
