import { useCallback, useEffect, useState } from "react";

/** One personal layout across reloads + all chats (Phase 3a cockpit persistence). */
export function cockpitCollapsedKey(): string {
  return "aoa:commander:cockpit-collapsed";
}

function loadCollapsed(): boolean {
  try {
    const v = localStorage.getItem(cockpitCollapsedKey());
    return v === null ? true : v === "true"; // default collapsed (semi-rail)
  } catch {
    return true;
  }
}

/** Global (per-user) collapse state for the Commander cockpit panel. */
export function useCommanderCockpitCollapsed(): readonly [boolean, (value: boolean) => void] {
  const [collapsed, setState] = useState<boolean>(() => loadCollapsed());

  // Cross-tab / late-hydration sync (mirrors useCommanderViewerCollapsed).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === cockpitCollapsedKey()) setState(loadCollapsed());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setCollapsed = useCallback((value: boolean) => {
    setState(value);
    try {
      localStorage.setItem(cockpitCollapsedKey(), String(value));
    } catch {
      // ignore
    }
  }, []);

  return [collapsed, setCollapsed] as const;
}
