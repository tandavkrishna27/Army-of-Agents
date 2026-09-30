import { useEffect, useState } from "react";

/**
 * Generic, project-wide responsive tier hook.
 *
 * Tiers (matching the Tailwind breakpoints used across the app):
 *   - mobile:  < 640px
 *   - tablet:  640px – 1023px
 *   - desktop: 1024px – 1535px
 *   - wide:    >= 1536px
 *
 * This is intentionally a generic hook (not commander-specific). It is
 * matchMedia-based, SSR-safe (guards `window`), and cleans up its listeners.
 *
 * `useSidebar().isMobile` (768px threshold) remains a separate concern for the
 * global app nav rail — do NOT conflate the two.
 */
export type Breakpoint = "mobile" | "tablet" | "desktop" | "wide";

// Lower bounds (min-width) for each tier above mobile.
const TABLET_MIN = 640;
const DESKTOP_MIN = 1024;
const WIDE_MIN = 1536;

function computeTier(width: number): Breakpoint {
  if (width >= WIDE_MIN) return "wide";
  if (width >= DESKTOP_MIN) return "desktop";
  if (width >= TABLET_MIN) return "tablet";
  return "mobile";
}

function readTier(): Breakpoint {
  // SSR-safe: default to desktop when there's no window (matches the inline
  // desktop layout, the most common viewport and the unchanged default).
  if (typeof window === "undefined") return "desktop";
  return computeTier(window.innerWidth);
}

export interface BreakpointState {
  tier: Breakpoint;
  isMobile: boolean;
  isTablet: boolean;
  /** True at desktop OR wide (>= 1024px) — the inline-sidebar layout. */
  isDesktopUp: boolean;
  isWide: boolean;
  /** True when sessions should live in a drawer (mobile or tablet, < 1024px). */
  useDrawerSessions: boolean;
}

function toState(tier: Breakpoint): BreakpointState {
  return {
    tier,
    isMobile: tier === "mobile",
    isTablet: tier === "tablet",
    isDesktopUp: tier === "desktop" || tier === "wide",
    isWide: tier === "wide",
    useDrawerSessions: tier === "mobile" || tier === "tablet",
  };
}

export function useBreakpoint(): BreakpointState {
  const [tier, setTier] = useState<Breakpoint>(readTier);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;

    // One media query per tier boundary; recompute the tier on any change.
    const queries = [
      window.matchMedia(`(min-width: ${TABLET_MIN}px)`),
      window.matchMedia(`(min-width: ${DESKTOP_MIN}px)`),
      window.matchMedia(`(min-width: ${WIDE_MIN}px)`),
    ];

    const update = () => setTier(computeTier(window.innerWidth));
    // Sync once on mount in case the initial read raced with hydration.
    update();

    for (const mql of queries) mql.addEventListener("change", update);
    return () => {
      for (const mql of queries) mql.removeEventListener("change", update);
    };
  }, []);

  return toState(tier);
}
