import { useCallback, useEffect, useState } from "react";

export type MemoryViewMode = "list" | "table" | "cards";

const STORAGE_KEY = "aoa:memory:view-mode";
const VALID_MODES: ReadonlyArray<MemoryViewMode> = ["list", "table", "cards"];

function isValidMode(v: unknown): v is MemoryViewMode {
  return typeof v === "string" && (VALID_MODES as readonly string[]).includes(v);
}

function readMode(): MemoryViewMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isValidMode(raw) ? raw : "list";
  } catch {
    return "list";
  }
}

export interface UseMemoryViewModeResult {
  mode: MemoryViewMode;
  setMode: (mode: MemoryViewMode) => void;
}

export function useMemoryViewMode(): UseMemoryViewModeResult {
  const [mode, setModeState] = useState<MemoryViewMode>(() => readMode());

  const setMode = useCallback((next: MemoryViewMode) => {
    if (!isValidMode(next)) return;
    setModeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Quota / privacy mode — keep in-memory state, drop persistence.
    }
  }, []);

  // React to other tabs / windows changing the value.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== STORAGE_KEY) return;
      setModeState(readMode());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { mode, setMode };
}
