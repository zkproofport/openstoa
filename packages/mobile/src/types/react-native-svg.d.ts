// Ambient declaration so the mini-app's standalone tsc can resolve
// `react-native-svg`, which is physically installed in the host
// (`proofport-app/node_modules/`) and surfaced via Metro at bundle time.
declare module 'react-native-svg' {
  import type { ComponentType } from 'react';
  import type { StyleProp, ViewStyle } from 'react-native';

  interface CommonProps {
    width?: number | string;
    height?: number | string;
    viewBox?: string;
    fill?: string;
    stroke?: string;
    strokeWidth?: number | string;
    strokeLinecap?: 'butt' | 'round' | 'square';
    strokeLinejoin?: 'miter' | 'round' | 'bevel';
    style?: StyleProp<ViewStyle>;
    children?: React.ReactNode;
  }

  interface PathProps extends CommonProps { d?: string; }
  interface CircleProps extends CommonProps { cx?: number | string; cy?: number | string; r?: number | string; }
  interface LineProps extends CommonProps { x1?: number | string; y1?: number | string; x2?: number | string; y2?: number | string; }
  interface PolylineProps extends CommonProps { points?: string; }
  interface RectProps extends CommonProps { x?: number | string; y?: number | string; rx?: number | string; ry?: number | string; }

  export const Path: ComponentType<PathProps>;
  export const Circle: ComponentType<CircleProps>;
  export const Line: ComponentType<LineProps>;
  export const Polyline: ComponentType<PolylineProps>;
  export const Rect: ComponentType<RectProps>;
  export const G: ComponentType<CommonProps>;

  const Svg: ComponentType<CommonProps>;
  export default Svg;
}
