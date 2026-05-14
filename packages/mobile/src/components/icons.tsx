import React from 'react';
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

// OpenStoa brand mark — inline SVG, same path data as
// `openstoa/public/icon.svg`. We render via `react-native-svg` instead
// of a PNG so the mini-app stays self-contained: no asset bundling
// path to fight with (Metro dev server has a long-standing bug where
// PNG fetches resolved through file:-linked sibling packages hang RN's
// NSURLSession), and `color` overrides `fill` cleanly across themes.
// Mirrors the approach already used by `ZKProofportMarkIcon` below.
const OPENSTOA_MARK_PATH =
  'M 0.0,205.5 188.0,204.5 191.5,207.0 191.5,383.0 190.0,386.5 8.0,387.5 1.0,386.5 0.0,384.5 Z M 210.5,0.0 249.0,4.5 288.0,17.5 326.0,39.5 352.0,61.5 373.5,87.0 372.5,88.0 382.5,103.0 391.5,125.0 394.5,128.0 393.5,130.0 403.5,168.0 403.5,181.0 392.0,183.5 387.0,182.5 383.0,184.5 374.0,184.5 374.0,182.5 358.0,182.5 358.0,184.5 356.0,182.5 354.0,184.5 353.0,182.5 309.0,183.5 305.5,180.0 305.5,171.0 298.5,144.0 290.5,128.0 278.5,112.0 263.0,98.5 244.0,87.5 213.0,79.5 189.0,79.5 174.0,82.5 162.0,86.5 136.0,101.5 135.5,104.0 134.0,103.5 134.5,105.0 129.0,108.5 122.0,117.5 119.5,118.0 111.5,130.0 101.5,153.0 97.5,170.0 97.5,180.0 95.0,182.5 4.0,183.5 0.0,179.5 Z M 230.5,388.0 230.0,386.5 214.0,386.5 212.5,385.0 212.5,337.0 214.0,335.5 342.0,335.5 342.5,325.0 341.0,320.5 213.0,319.5 212.5,206.0 214.0,204.5 401.0,204.5 403.5,207.0 404.0,229.5 Z M 266.0,184.5 259.0,184.5 259.0,182.5 256.0,184.5 245.0,182.5 242.0,184.5 237.0,184.5 239.5,183.0 235.0,182.5 234.0,184.5 232.0,182.5 230.0,184.5 229.0,182.5 227.0,184.5 212.0,184.5 212.0,182.5 209.0,184.5 193.0,182.5 191.0,184.5 185.0,184.5 184.0,182.5 168.0,182.5 169.0,184.5 165.0,182.5 163.0,184.5 159.0,182.5 153.0,182.5 151.0,184.5 150.0,182.5 146.0,184.5 139.0,184.5 139.0,182.5 127.0,182.5 125.5,172.0 129.5,156.0 138.5,138.0 155.0,120.5 172.0,111.5 185.0,107.5 198.0,105.5 213.0,106.5 226.0,109.5 241.0,117.5 244.0,117.5 260.0,133.5 263.5,135.0 273.5,155.0 277.5,170.0 277.5,181.0 274.0,183.5 260.5,183.0 266.0,184.5 Z M 0.0,176.5 3.5,148.0 13.5,118.0 31.5,86.0 57.0,56.5 83.0,35.5 115.0,17.5 154.0,4.5 191.5,0.0 Z M 138.5,336.0 138.0,254.5 52.5,255.0 53.0,336.5 138.5,336.0 Z M 404.0,251.5 401.0,255.5 274.0,255.5 272.5,257.0 273.0,270.5 401.0,270.5 404.0,275.5 Z M 404.0,276.5 403.5,384.0 402.0,386.5 384.5,388.0 Z M 292.5,388.0 292.0,386.5 240.0,386.5 232.5,388.0 Z M 340.5,388.0 332.0,386.5 297.0,386.5 296.5,388.0 Z M 382.5,388.0 383.0,386.5 341.5,388.0 Z M 295.5,388.0 295.0,386.5 293.5,388.0 Z M 125.0,170.5 125.0,168.5 125.0,170.5 Z M 136.0,184.5 134.5,184.0 136.0,184.5 Z M 365.0,184.5 359.5,184.0 365.0,184.5 Z';

export function OpenStoaMarkIcon({ size = 22, color = '#8795F6' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 405 389" fill="none">
      <Path d={OPENSTOA_MARK_PATH} fill={color} fillRule="evenodd" />
    </Svg>
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
