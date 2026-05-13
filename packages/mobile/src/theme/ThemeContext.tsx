import React, { createContext, useContext, useEffect, useState } from 'react';
import { useHost } from '@openstoa/miniapp-bridge';
import { getThemeColors, lightColors } from './colors';
import type { ThemeColors, ThemeMode } from './colors';

interface ThemeContextValue {
  mode: ThemeMode;
  colors: ThemeColors;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'light',
  colors: lightColors,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const host = useHost();
  const [mode, setMode] = useState<ThemeMode>(() => host.getTheme());

  useEffect(() => {
    // Sync immediately in case the mode changed between render and effect.
    setMode(host.getTheme());
    return host.onThemeChange(setMode);
  }, [host]);

  return (
    <ThemeContext.Provider value={{ mode, colors: getThemeColors(mode) }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useThemeColors(): ThemeContextValue {
  return useContext(ThemeContext);
}
