import { useCallback, useEffect, useState } from "react";

/** One personal layout across reloads + all chats (Phase 1 geometry persistence). */
export function commanderViewerCollapsedKey(): string {
  return "aoa:commander:viewer-collapsed";
}

function loadCollapsed(): boolean {
  try {
    const v = localStorage.getItem(commanderViewerCollapsedKey());
    return v === null ? true : v === "true"; // default collapsed
  } catch {
    return true;
  }
}

/** Global (per-user) collapse state for the Commander detail/viewer panel. */
export function useCommanderViewerCollapsed(): readonly [boolean, (value: boolean) => void] {
  const [collapsed, setState] = useState<boolean>(() => loadCollapsed());

  // Cross-tab / late-hydration sync (cheap; mirrors useSidebarCollapsed intent).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === commanderViewerCollapsedKey()) setState(loadCollapsed());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setCollapsed = useCallback((value: boolean) => {
    setState(value);
    try {
      localStorage.setItem(commanderViewerCollapsedKey(), String(value));
    } catch {
      // ignore
    }
  }, []);

  return [collapsed, setCollapsed] as const;
}
