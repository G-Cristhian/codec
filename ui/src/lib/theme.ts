import { useEffect, useState } from "react";
const THEME_KEY = "codec-theme";
export type Theme = "auto" | "light" | "dark";
function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "auto" || t === "dark") return t;
  } catch {
    /* Light is the default. */
  }
  return "light";
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
    const local = () => setTheme(readTheme());
    window.addEventListener("storage", sync);
    window.addEventListener(THEME_KEY, local);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(THEME_KEY, local);
    };
  }, []);
  return [
    theme,
    (value: Theme) => {
      try {
        if (value === "light") localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, value);
      } catch {
        /* Keep this page's choice. */
      }
      setTheme(value);
      window.dispatchEvent(new Event(THEME_KEY));
    },
  ] as const;
}
