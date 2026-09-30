import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Live-tracks `prefers-reduced-motion: reduce`. Server/first-paint snapshot
 * is `false` (no flash of animated content assumed on the server; the real
 * value settles on hydration/mount).
 */
export function usePrefersReducedMotion() {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(QUERY);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => matchMedia(QUERY).matches,
    () => false,
  );
}
