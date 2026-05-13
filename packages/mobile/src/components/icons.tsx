import React from 'react';
import { Image as RNImage } from 'react-native';
import Svg, { Circle, Line, Path, Polyline } from 'react-native-svg';

// Mirrors openstoa/src/components/icons.tsx — same viewBox + paths so the
// mobile feed/detail iconography stays visually identical to the web. All
// icons follow Feather/Lucide stroke conventions (1.5px stroke, round caps).

export interface IconProps {
  size?: number;
  color?: string;
  /** When the icon supports a filled variant (heart/bookmark/pin). */
  filled?: boolean;
  /** Fill color used when `filled` is true. */
  filledColor?: string;
}

export function ArrowUpIcon({ size = 16, color = '#9ca3af', filled, filledColor = '#22c55e' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? filledColor : 'none'} stroke={filled ? filledColor : color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 19V5" />
      <Path d="M5 12l7-7 7 7" />
    </Svg>
  );
}

export function ArrowDownIcon({ size = 16, color = '#9ca3af', filled, filledColor = '#3b82f6' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? filledColor : 'none'} stroke={filled ? filledColor : color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 5v14" />
      <Path d="M5 12l7 7 7-7" />
    </Svg>
  );
}

export function HeartIcon({ size = 18, color = '#9ca3af', filled, filledColor = '#ef4444' }: IconProps) {
  if (filled) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill={filledColor}>
        <Path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </Svg>
  );
}

export function CommentIcon({ size = 18, color = '#9ca3af' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </Svg>
  );
}

export function EyeIcon({ size = 14, color = '#9ca3af' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <Circle cx={12} cy={12} r={3} />
    </Svg>
  );
}

export function ShareIcon({ size = 14, color = '#9ca3af' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <Polyline points="16 6 12 2 8 6" />
      <Line x1={12} y1={2} x2={12} y2={15} />
    </Svg>
  );
}

export function BookmarkIcon({ size = 18, color = '#9ca3af', filled, filledColor = '#3b82f6' }: IconProps) {
  if (filled) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill={filledColor}>
        <Path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </Svg>
  );
}

export function TrashIcon({ size = 18, color = '#9ca3af' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <Polyline points="3 6 5 6 21 6" />
      <Path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Svg>
  );
}

export function PinIcon({ size = 14, color = '#9ca3af', filled }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : 'none'} stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 17v5" />
      <Path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </Svg>
  );
}

export function SettingsIcon({ size = 20, color = '#9ca3af' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <Circle cx={12} cy={12} r={3} />
    </Svg>
  );
}

export function RecordIcon({ size = 14, color = '#9ca3af' }: IconProps) {
  // Feather-style "anchor" — visually distinct from share/copy/link
  // icons, reads as "fixed in place" which matches on-chain record
  // semantics. The previous link/chain glyph was visually almost
  // identical to the share icon and read as a copy action.
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 22V8" />
      <Path d="M5 12H2a10 10 0 0 0 20 0h-3" />
      <Path d="M12 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
    </Svg>
  );
}

// OpenStoa brand mark — uses the original PNG asset directly so the
// glyph matches openstoa.xyz pixel-for-pixel. `tintColor` lets RN
// recolour the alpha channel for active/inactive tab states.
export function OpenStoaMarkIcon({ size = 22, color = '#9ca3af' }: IconProps) {
  return (
    <RNImage
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      source={require('../assets/openstoa-mark.png')}
      style={{ width: size, height: size, tintColor: color }}
      resizeMode="contain"
    />
  );
}

// ZKProofport host-app brand mark — a shield-with-tick silhouette
// that matches the host's launch icon family. Used inside the
// OpenStoa mini-app as the "exit back to host" tab so the icon
// reads as 'ZKProofport', not a generic external-link arrow.
export function ZKProofportMarkIcon({ size = 22, color = '#9ca3af' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 2 4 5v6.5c0 4.42 3.13 8.5 8 10.5 4.87-2 8-6.08 8-10.5V5l-8-3z" />
      <Path d="m8.5 12 2.5 2.5L15.5 10" />
    </Svg>
  );
}
