/**
 * OpenStoa mobile color palette — distinct from the Next.js web tones.
 * Light/dark variants are kept simple here; richer theme integration with
 * the host app can layer on top via a host-provided ThemeMode.
 */

export type ThemeMode = 'light' | 'dark';

export interface ThemeColors {
  background: { primary: string; secondary: string; tertiary: string };
  text: { primary: string; secondary: string; tertiary: string; inverted: string };
  brand: { primary: string; primaryMuted: string; accent: string };
  border: { default: string; strong: string };
  status: { success: string; warning: string; danger: string };
}

export const lightColors: ThemeColors = {
  background: { primary: '#FFFFFF', secondary: '#F5F5F7', tertiary: '#EEEEF2' },
  text: { primary: '#0E0E10', secondary: '#5C5C66', tertiary: '#9A9AA1', inverted: '#FFFFFF' },
  brand: { primary: '#5B49E8', primaryMuted: '#EAE6FB', accent: '#11C28A' },
  border: { default: '#E2E2E8', strong: '#C8C8D0' },
  status: { success: '#11C28A', warning: '#F0A619', danger: '#E5484D' },
};

export const darkColors: ThemeColors = {
  background: { primary: '#0E0E10', secondary: '#17171B', tertiary: '#1F1F25' },
  text: { primary: '#F5F5F7', secondary: '#A0A0AB', tertiary: '#6E6E78', inverted: '#0E0E10' },
  brand: { primary: '#7C6BFF', primaryMuted: '#28244C', accent: '#22D3A2' },
  border: { default: '#2A2A33', strong: '#3A3A45' },
  status: { success: '#22D3A2', warning: '#F0A619', danger: '#FF6369' },
};

export function getThemeColors(mode: ThemeMode): ThemeColors {
  return mode === 'dark' ? darkColors : lightColors;
}
