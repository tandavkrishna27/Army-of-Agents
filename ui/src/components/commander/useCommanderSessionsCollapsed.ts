import { useCallback, useEffect, useState } from "react";

/**
 * Global-persisted collapse state for the Commander Sessions sidebar.
 *
 * Single key across all conversations (B5: "one personal layout across reloads
 * + all chats"). Mirrors the useSidebarCollapsed pattern from
 * ui/src/components/workspace/useSidebarCollapsed.ts.
 */
const STORAGE_KEY = "aoa:commander:sessions-collapsed";

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function useCommanderSessionsCollapsed(): readonly [boolean, (value: boolean) => void] {
  const [collapsed, setCollapsedState] = useState<boolean>(loadCollapsed);

  // Re-sync on mount (handles SSR / test environments where localStorage may
  // not be available during the initial render).
  useEffect(() => {
    setCollapsedState(loadCollapsed());
  }, []);

  const setCollapsed = useCallback((value: boolean) => {
    setCollapsedState(value);
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // ignore write errors (private browsing, quota exceeded)
    }
  }, []);

  return [collapsed, setCollapsed] as const;
}
