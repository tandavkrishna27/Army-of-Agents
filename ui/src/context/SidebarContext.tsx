import { createContext, useCallback, useContext, useState, useEffect, type ReactNode } from "react";

const COLLAPSED_KEY = "aoa:sidebar-collapsed";
const MODE_KEY = "aoa:sidebar-mode";
export type SidebarMode = "expanded" | "compact" | "hidden";

interface SidebarContextValue {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  isMobile: boolean;
  mode: SidebarMode;
  hidden: boolean;
  setMode: (mode: SidebarMode) => void;
  setTransientMode: (mode: SidebarMode | null) => void;
  collapsed: boolean;
  setCollapsed: (value: boolean) => void;
  toggleCollapse: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

const MOBILE_BREAKPOINT = 768;

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= MOBILE_BREAKPOINT);
  const [preferredMode, setPreferredMode] = useState<SidebarMode>(() => {
    if (window.innerWidth < MOBILE_BREAKPOINT) return "expanded";
    try {
      const stored = localStorage.getItem(MODE_KEY);
      if (stored === "expanded" || stored === "compact" || stored === "hidden") return stored;
      return localStorage.getItem(COLLAPSED_KEY) === "true" ? "compact" : "expanded";
    } catch {
      return "expanded";
    }
  });
  const [transientMode, setTransientMode] = useState<SidebarMode | null>(null);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      setSidebarOpen(!e.matches);
      if (e.matches) setPreferredMode("expanded");
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  const setMode = useCallback((next: SidebarMode) => {
    const safeMode = isMobile && next !== "expanded" ? "expanded" : next;
    setPreferredMode(safeMode);
    setTransientMode(null);
    try {
      localStorage.setItem(MODE_KEY, safeMode);
      localStorage.setItem(COLLAPSED_KEY, String(safeMode === "compact"));
    } catch { /* ignore */ }
  }, [isMobile]);

  const mode = transientMode ?? preferredMode;

  const toggleCollapse = useCallback(() => {
    const next: SidebarMode = mode === "expanded" ? "compact" : mode === "compact" ? "hidden" : "expanded";
    setMode(next);
  }, [mode, setMode]);

  const setCollapsedWithStorage = useCallback((value: boolean) => {
    setMode(value ? "compact" : "expanded");
  }, [setMode]);

  const collapsed = mode === "compact";
  const hidden = mode === "hidden";

  return (
    <SidebarContext.Provider value={{ sidebarOpen, setSidebarOpen, toggleSidebar, isMobile, mode, hidden, setMode, setTransientMode, collapsed, setCollapsed: setCollapsedWithStorage, toggleCollapse }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error("useSidebar must be used within SidebarProvider");
  }
  return ctx;
}
