import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type Theme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

const STORAGE_KEY = 'dagnet-theme';
const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Read the OS colour-scheme preference. */
function getOSPreference(): Theme {
  try {
    if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch {
    // Non-browser or matchMedia unsupported — default to light.
  }
  return 'light';
}

/** Read the stored preference, falling back to OS preference. */
function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage unavailable — fall back to OS.
  }
  return getOSPreference();
}

/** Apply the data-theme attribute on <html> so CSS selectors can match. */
function applyThemeAttribute(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);

  // Apply attribute on mount and whenever theme changes.
  useEffect(() => {
    applyThemeAttribute(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Best-effort persistence.
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'light' ? 'dark' : 'light');
  }, [theme, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, toggleTheme, setTheme }),
    [theme, toggleTheme, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

/** Safe default when no ThemeProvider is present (e.g. in tests). */
const DEFAULT_THEME_VALUE: ThemeContextValue = {
  theme: 'light',
  toggleTheme: () => {},
  setTheme: () => {},
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  // Return safe default instead of throwing — allows components to render
  // in test harnesses that don't wrap with ThemeProvider.
  return ctx ?? DEFAULT_THEME_VALUE;
}
