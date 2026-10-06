import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'jobagent.theme';

type ThemeState = {
  theme: Theme;
  toggle: () => void;
  set: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeState | null>(null);

/**
 * Reads the choice the inline script in index.html already applied.
 *
 * `data-theme` is written there too, so this never disagrees with the DOM and
 * never has to guess: if the script failed (storage blocked, JS-order surprise)
 * the attribute is absent and we fall back to light, which is also the default.
 */
function initialTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
  // Keeps the browser UI (address bar on mobile, form controls, scrollbars)
  // in step with the page.
  root.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Nothing to persist to; the in-memory choice still works this session.
    }
  }, [theme]);

  // Follow the OS only while the user has not made an explicit choice, so
  // toggling to light and then changing the system setting cannot undo it.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    if (stored === 'light' || stored === 'dark') return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setTheme(e.matches ? 'dark' : 'light');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const set = useCallback((next: Theme) => setTheme(next), []);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);

  const value = useMemo(() => ({ theme, toggle, set }), [theme, toggle, set]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
