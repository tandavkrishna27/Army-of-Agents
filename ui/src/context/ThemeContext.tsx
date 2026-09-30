import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type ResolvedTheme = "light" | "dark";
export type ThemePreference = "light" | "dark" | "system";

interface ThemeContextValue {
  /** Resolved theme actually applied to the DOM (always concrete light or dark). */
  theme: ResolvedTheme;
  /** User's preference. May be "system" — in which case resolved follows prefers-color-scheme. */
  preference: ThemePreference;
  setPreference: (pref: ThemePreference) => void;
  /** Legacy binary toggle. Kept for backward compat. Flips between explicit light/dark, skipping system. */
  toggleTheme: () => void;
}

const THEME_STORAGE_KEY = "aoa.theme";
const DARK_THEME_COLOR = "#18181b";
const LIGHT_THEME_COLOR = "#ffffff";
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function readPreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "dark";
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // Ignore local storage read failures in restricted environments.
  }
  // Default fallback — use the document's current theme class if any (matches old behavior).
  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "dark";
  }
  return "dark";
}

function resolveSystem(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const isDark = resolved === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta instanceof HTMLMetaElement) {
    themeColorMeta.setAttribute("content", isDark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readPreference());
  const [systemResolved, setSystemResolved] = useState<ResolvedTheme>(() => resolveSystem());

  const resolved: ResolvedTheme = preference === "system" ? systemResolved : preference;

  // Watch the OS preference. Listener stays mounted regardless of current preference —
  // cheap, and means switching to "system" picks up the live value immediately.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    if (!mql || typeof mql.addEventListener !== "function") return;
    const handler = (e: MediaQueryListEvent) => setSystemResolved(e.matches ? "dark" : "light");
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // Apply resolved theme to DOM whenever it changes.
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  // Persist user preference (NOT resolved theme) — so System mode survives reloads.
  useEffect(() => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Ignore local storage write failures in restricted environments.
    }
  }, [preference]);

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref);
  }, []);

  const toggleTheme = useCallback(() => {
    // Legacy binary toggle: flip between explicit light/dark, skip system.
    setPreferenceState((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme: resolved, preference, setPreference, toggleTheme }),
    [resolved, preference, setPreference, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
