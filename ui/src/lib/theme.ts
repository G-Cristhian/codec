import { useEffect, useState } from "react";
export const THEME_KEY = "codec-theme";
export type Theme = "auto" | "light" | "dark";
export function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "light" || t === "dark") return t;
  } catch {
    /* Auto follows CSS. */
  }
  return "auto";
}
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    if (theme === "auto")
      document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  useEffect(() => {
    const sync = (e: StorageEvent) => {
      if (e.key === THEME_KEY || e.key === null) setTheme(readTheme());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return [
    theme,
    (value: Theme) => {
      try {
        if (value === "auto") localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, value);
      } catch {
        /* Keep this page's choice. */
      }
      setTheme(value);
    },
  ] as const;
}
