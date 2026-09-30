import { useCallback, useEffect, useState } from "react";

export function sidebarCollapsedKey(workspaceId: string, side: "left" | "right") {
  return `aoa:workspace:${workspaceId}:sidebar-${side}-collapsed`;
}

function loadCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

/**
 * Per-workspace sidebar collapse state persisted in localStorage.
 * Returns [collapsed, setCollapsed] tuple. Defaults to `false` (expanded).
 */
export function useSidebarCollapsed(
  workspaceId: string,
  side: "left" | "right",
): readonly [boolean, (value: boolean) => void] {
  const key = sidebarCollapsedKey(workspaceId, side);
  const [collapsed, setCollapsedState] = useState<boolean>(() => loadCollapsed(key));

  // Re-sync when workspaceId or side changes
  useEffect(() => {
    setCollapsedState(loadCollapsed(key));
  }, [key]);

  const setCollapsed = useCallback(
    (value: boolean) => {
      setCollapsedState(value);
      try {
        localStorage.setItem(key, String(value));
      } catch {
        // ignore
      }
    },
    [key],
  );

  return [collapsed, setCollapsed] as const;
}
