import { useCallback, useEffect, useState } from "react";

export function cockpitPrefsKey(): string {
  return "aoa:commander:cockpit-prefs";
}

/** Per-user-per-browser cockpit prefs. `hidden` = card ids the user turned off
 *  (overrides show-only-active for those). `order` = explicit card order (ids);
 *  empty = registry default order. `enabled` = opt-in card ids the user turned on
 *  (defaultOn:false cards are excluded unless their id appears here). */
export interface CockpitPrefs {
  hidden: string[];
  order: string[];
  enabled: string[];
}
export const DEFAULT_COCKPIT_PREFS: CockpitPrefs = { hidden: [], order: [], enabled: [] };

function loadPrefs(): CockpitPrefs {
  try {
    const v = localStorage.getItem(cockpitPrefsKey());
    if (!v) return DEFAULT_COCKPIT_PREFS;
    const p = JSON.parse(v) as Partial<CockpitPrefs>;
    // Normalize — old localStorage entries (no `enabled`) must not crash.
    return {
      hidden: Array.isArray(p.hidden) ? p.hidden : [],
      order: Array.isArray(p.order) ? p.order : [],
      enabled: Array.isArray(p.enabled) ? p.enabled : [],
    };
  } catch {
    return DEFAULT_COCKPIT_PREFS;
  }
}

export function useCommanderCockpitPrefs(): readonly [CockpitPrefs, (next: CockpitPrefs) => void] {
  const [prefs, setState] = useState<CockpitPrefs>(() => loadPrefs());
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === cockpitPrefsKey()) setState(loadPrefs());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const setPrefs = useCallback((next: CockpitPrefs) => {
    setState(next);
    try { localStorage.setItem(cockpitPrefsKey(), JSON.stringify(next)); } catch { /* ignore */ }
  }, []);
  return [prefs, setPrefs] as const;
}
