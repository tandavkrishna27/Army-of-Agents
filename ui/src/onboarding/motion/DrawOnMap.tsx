import type { CSSProperties } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

export type MapEdge = {
  /** Stable key AND the `data-testid` suffix (`map-edge-{id}`). */
  id: string;
  /** SVG path `d` attribute. */
  d: string;
  /** Depth-stagger index — later depths draw in after earlier ones (WS9
   * Map: Commander/Discussion/Direct → TASK first, TASK → Agent/Human next,
   * Review + Memory last). Defaults to 0 (no stagger). */
  depth?: number;
};

const STAGGER_SECONDS = 0.15;
const DRAW_DURATION_SECONDS = 0.5;

/**
 * WS9 — the deferred WS1 primitive (see WS1 file-structure note: "The
 * `DrawOnMap` primitive is built in WS9, co-located with the Map that
 * consumes it"). Renders a set of SVG edges that draw themselves via CSS
 * `stroke-dashoffset` (using `pathLength={1}` so every path's dash math is
 * `0..1` regardless of its actual geometric length — ports the mockup's
 * `.map.draw svg .edge` animation + the `OrgHierarchyChart` draw-on grammar).
 *
 * Must be rendered inside an `<svg>` ancestor (it renders `<path>` elements
 * directly, not a wrapping `<svg>`) so callers can lay it under/over
 * absolutely-positioned node markup, as the mockup does.
 *
 * Reduced motion (decided in JS, matching `Reveal` — see its doc comment):
 * edges render already-drawn (`stroke-dashoffset: 0`, no animation) instead
 * of starting hidden and never resolving.
 */
export function DrawOnMap({
  edges,
  stroke = "var(--border-strong)",
  strokeWidth = 1.4,
}: {
  edges: MapEdge[];
  stroke?: string;
  strokeWidth?: number;
}) {
  const reduce = usePrefersReducedMotion();

  return (
    <>
      {edges.map((edge) => {
        const style: CSSProperties = reduce
          ? {}
          : {
              strokeDasharray: 1,
              strokeDashoffset: 1,
              animation: `obd-draw-edge ${DRAW_DURATION_SECONDS}s ease forwards`,
              animationDelay: `${(edge.depth ?? 0) * STAGGER_SECONDS}s`,
            };
        return (
          <path
            key={edge.id}
            data-testid={`map-edge-${edge.id}`}
            data-depth={edge.depth ?? 0}
            d={edge.d}
            pathLength={1}
            fill="none"
            stroke={stroke}
            strokeWidth={strokeWidth}
            style={style}
          />
        );
      })}
    </>
  );
}
