/**
 * git-arc-labels.ts — pure de-overlap pass for arc branch-name labels.
 *
 * Both GitGraphCanvas's draw code (drawArcLabels) and the hit-region builder
 * (buildHitRegions) call placeArcLabels with the SAME inputs, so the label hit
 * box always lands on the exact spot the label is drawn (single source, no
 * drift). Replaces the old in-drawArcLabels 6-step nudge that saturated when
 * more than ~6 labels shared a coordinate. Approx char widths (no canvas).
 */
import type { ArcDefinition } from "./git-arc-layout";

const LABEL_CHAR_W = 5.5; // approx px width of a 9px "Courier New" glyph
const LABEL_H = 9;

export interface PlacedLabel {
  /** Left edge (drawX) — pass straight to ctx.fillText. */
  x: number;
  /** Text baseline y. */
  y: number;
  /** Approx label width. */
  w: number;
}

/** Returns de-overlapped label positions keyed by branch name, for the arcs
 * that get a name label (visible, not done, not already shown as a card). */
export function placeArcLabels(
  arcs: ArcDefinition[],
  arcVisibleNames: Set<string>,
  cardBranchNames: Set<string>,
): Map<string, PlacedLabel> {
  const out = new Map<string, PlacedLabel>();
  const placed: Array<{ x: number; y: number; w: number }> = [];
  for (const arc of arcs) {
    if (!arcVisibleNames.has(arc.branchName)) continue;
    if (arc.isDone) continue;
    if (cardBranchNames.has(arc.branchName)) continue;
    const labelX =
      arc.isOpen || arc.mergePointX == null
        ? arc.branchPointX + 80
        : (arc.branchPointX + arc.mergePointX) / 2;
    const baseY = arc.direction === "up" ? arc.apexY - 8 : arc.apexY + 14;
    const name =
      arc.branchName.length > 18 ? arc.branchName.slice(0, 17) + "…" : arc.branchName;
    const w = name.length * LABEL_CHAR_W + 4;
    const drawX = labelX - w / 2;
    // Greedy vertical de-overlap: push along the arc's direction until clear of
    // every already-placed label. Bounded only by a high safety guard, so it
    // never saturates the way the old 6-step cap did.
    const step = arc.direction === "up" ? -11 : 11;
    let y = baseY;
    let guard = 0;
    while (
      guard < 200 &&
      placed.some(
        (p) => Math.abs(p.y - y) < LABEL_H + 1 && drawX < p.x + p.w + 4 && drawX + w > p.x - 4,
      )
    ) {
      y += step;
      guard++;
    }
    placed.push({ x: drawX, y, w });
    out.set(arc.branchName, { x: drawX, y, w });
  }
  return out;
}
