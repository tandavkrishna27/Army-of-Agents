import { createContext, useCallback, useContext, useState, useEffect, type ReactNode } from "react";

const COLLAPSED_KEY = "aoa:sidebar-collapsed";

interface SidebarContextValue {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  isMobile: boolean;
  collapsed: boolean;
  setCollapsed: (value: boolean) => void;
  toggleCollapse: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

const MOBILE_BREAKPOINT = 768;

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= MOBILE_BREAKPOINT);
  const [collapsed, setCollapsed] = useState(() => {
    if (window.innerWidth < MOBILE_BREAKPOINT) return false;
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      setSidebarOpen(!e.matches);
      // On mobile, collapsed is always false
      if (e.matches) setCollapsed(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  const toggleCollapse = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(COLLAPSED_KEY, String(next));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  const setCollapsedWithStorage = useCallback((value: boolean) => {
    setCollapsed(value);
    try {
      localStorage.setItem(COLLAPSED_KEY, String(value));
    } catch { /* ignore */ }
  }, []);

  return (
    <SidebarContext.Provider value={{ sidebarOpen, setSidebarOpen, toggleSidebar, isMobile, collapsed, setCollapsed: setCollapsedWithStorage, toggleCollapse }}>
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
