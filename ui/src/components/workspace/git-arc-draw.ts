/**
 * git-arc-draw.ts — Canvas drawing functions for the trunk-and-arcs git graph.
 *
 * Extracted from GitGraphCanvas.tsx so both the React component AND the
 * standalone visual test harness can use the exact same drawing code.
 * Pure canvas drawing — no React, no DOM events, no D3.
 */

import type { GitBranchInfo } from "@armyofagents/shared";
import type { ArcCommitLayout, ArcDefinition } from "./git-arc-layout";
import { NEUTRAL_GREY, computeStackCardLayout, type TipStack } from "./git-arc-layout";
import { placeArcLabels } from "./git-arc-labels";

// ---------------------------------------------------------------------------
// Path helpers (shared by drawArcLines, drawFlowPulse, hit testing)
// ---------------------------------------------------------------------------

function segDist(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export interface SmoothSegment {
  p1: [number, number];
  cp1: [number, number];
  cp2: [number, number];
  p2: [number, number];
}

/**
 * Centripetal Catmull-Rom (alpha = 0.5) → cubic Bezier control points for a
 * polyline. Centripetal parameterization prevents the cusps / self-intersections
 * ("hooks") that UNIFORM Catmull-Rom produces on sparse, steep arcs. Pure +
 * testable. Endpoints are duplicated (p0=p1 at start, p3=p2 at end), matching
 * the previous draw behaviour. Distances are floored to a tiny epsilon so
 * duplicated/coincident points never divide by zero.
 */
export function smoothSegments(
  points: Array<[number, number]>,
  alpha = 0.5,
): SmoothSegment[] {
  const segs: SmoothSegment[] = [];
  if (points.length < 2) return segs;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;

    const t01 = Math.max(segDist(p0, p1) ** alpha, 1e-4);
    const t12 = Math.max(segDist(p1, p2) ** alpha, 1e-4);
    const t23 = Math.max(segDist(p2, p3) ** alpha, 1e-4);

    const m1x = (p2[0] - p1[0]) + t12 * ((p1[0] - p0[0]) / t01 - (p2[0] - p0[0]) / (t01 + t12));
    const m1y = (p2[1] - p1[1]) + t12 * ((p1[1] - p0[1]) / t01 - (p2[1] - p0[1]) / (t01 + t12));
    const m2x = (p2[0] - p1[0]) + t12 * ((p3[0] - p2[0]) / t23 - (p3[0] - p1[0]) / (t12 + t23));
    const m2y = (p2[1] - p1[1]) + t12 * ((p3[1] - p2[1]) / t23 - (p3[1] - p1[1]) / (t12 + t23));

    segs.push({
      p1,
      cp1: [p1[0] + m1x / 3, p1[1] + m1y / 3],
      cp2: [p2[0] - m2x / 3, p2[1] - m2y / 3],
      p2,
    });
  }
  return segs;
}

function cubicAt(
  p0: [number, number],
  c1: [number, number],
  c2: [number, number],
  p1: [number, number],
  t: number,
): [number, number] {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1],
  ];
}

/** Sample the exact curve that strokeSmoothPath draws. Used by unit tests. */
export function sampleSmoothPath(
  points: Array<[number, number]>,
  perSeg = 16,
): Array<[number, number]> {
  if (points.length < 2) return points.slice();
  if (points.length === 2) {
    const out: Array<[number, number]> = [];
    for (let i = 0; i <= perSeg; i++) {
      const t = i / perSeg;
      out.push([
        points[0]![0] + (points[1]![0] - points[0]![0]) * t,
        points[0]![1] + (points[1]![1] - points[0]![1]) * t,
      ]);
    }
    return out;
  }
  const out: Array<[number, number]> = [];
  const segs = smoothSegments(points);
  out.push(segs[0]!.p1);
  for (const seg of segs) {
    for (let i = 1; i <= perSeg; i++) {
      out.push(cubicAt(seg.p1, seg.cp1, seg.cp2, seg.p2, i / perSeg));
    }
  }
  return out;
}

/**
 * Stroke a smooth Catmull-Rom curve that PASSES THROUGH every point. Because it
 * passes through (not near) the points, commit dots placed at those points are
 * always on the line. Falls back to a straight line for < 3 points.
 */
export function strokeSmoothPath(
  ctx: CanvasRenderingContext2D,
  points: Array<[number, number]>,
) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0]![0], points[0]![1]);
  if (points.length === 2) {
    ctx.lineTo(points[1]![0], points[1]![1]);
    ctx.stroke();
    return;
  }
  for (const seg of smoothSegments(points)) {
    ctx.bezierCurveTo(seg.cp1[0], seg.cp1[1], seg.cp2[0], seg.cp2[1], seg.p2[0], seg.p2[1]);
  }
  ctx.stroke();
}

/**
 * Point at parameter t ∈ [0,1] along a polyline (linear interpolation by
 * cumulative segment length). Used by the flow pulse and hit testing so they
 * follow the exact same path the line is drawn on.
 */
export function polylinePointAt(
  points: Array<[number, number]>,
  t: number,
): [number, number] {
  if (points.length === 0) return [0, 0];
  if (points.length === 1) return points[0]!;
  const clamped = Math.max(0, Math.min(1, t));
  let total = 0;
  const segLen: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1]![0] - points[i]![0];
    const dy = points[i + 1]![1] - points[i]![1];
    const len = Math.hypot(dx, dy);
    segLen.push(len);
    total += len;
  }
  if (total === 0) return points[0]!;
  let target = clamped * total;
  for (let i = 0; i < segLen.length; i++) {
    if (target <= segLen[i]!) {
      const f = segLen[i] === 0 ? 0 : target / segLen[i]!;
      return [
        points[i]![0] + (points[i + 1]![0] - points[i]![0]) * f,
        points[i]![1] + (points[i + 1]![1] - points[i]![1]) * f,
      ];
    }
    target -= segLen[i]!;
  }
  return points[points.length - 1]!;
}

/** Shortest distance from point (px,py) to the segment (ax,ay)-(bx,by). */
export function pointToSegmentDistance(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Clip a polyline to x >= left. If the path starts left of `left`, the
 * off-screen head is dropped and a single interpolated entry point is inserted
 * exactly at x = left. Returns null if fewer than 2 points remain. Assumes the
 * path is monotonic-ish in x (arc paths are: branch point → nodes → merge/stub).
 */
export function clipPolylineLeft(
  points: Array<[number, number]>,
  left: number,
): Array<[number, number]> | null {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p[0] >= left) {
      if (i > 0 && points[i - 1]![0] < left && out.length === 0) {
        const a = points[i - 1]!;
        const dx = p[0] - a[0];
        const t = dx === 0 ? 0 : (left - a[0]) / dx;
        out.push([left, a[1] + (p[1] - a[1]) * t]);
      }
      out.push(p);
    }
  }
  return out.length >= 2 ? out : null;
}

// ---------------------------------------------------------------------------
// Drawing constants
// ---------------------------------------------------------------------------

export const COMMIT_R = 5;
export const CARD_W = 28;
export const CARD_H = 18;

/** Merge commits render a fixed indigo diamond regardless of branch. */
export const MERGE_COLOR = "#6470DC";

/** Single source of truth for task-status → color. Used by the canvas
 * (statusDotColor) and the legend, so they never drift apart. */
export const STATUS_COLORS = {
  todo: "#4A90D9",       // azure blue — queued / not started (distinct from grey + indigo)
  in_progress: "#4FB67E",
  in_review: "#D9A938",
  blocked: "#ef4444",
  done: "#7E8AA8",
  cancelled: "#7E8AA8",
  planning: "#D9A938",
} as const;

/** Calm slate used for the done ✓ / cancelled ✕ glyph on the card. */
export const TERMINAL_MARK_COLOR = "#9aa0aa";

export function statusDotColor(status: string | null, fallback: string): string {
  if (status && status in STATUS_COLORS) {
    return STATUS_COLORS[status as keyof typeof STATUS_COLORS];
  }
  return fallback;
}

export interface TaskCardStyle {
  issueStatus: string | null;
  laneColor: string;
  isDone: boolean;
  branchStatus: string | null;
}

/** Draw a task card centred at (x,y). Shared by the normal node path and the
 * same-commit stack. Labels/badges are drawn separately by the caller. */
export function drawTaskCardAt(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  style: TaskCardStyle,
  animPhase: number,
) {
  const { issueStatus, laneColor, isDone, branchStatus } = style;
  const cardX = x - CARD_W / 2;
  const cardY = y - CARD_H / 2;
  const r = 4;

  ctx.save();
  ctx.globalAlpha = isDone ? 0.45 : 1;

  const borderColor = statusDotColor(issueStatus, laneColor);
  const fillColor = "#0f0e0d";

  if (branchStatus === "in_progress") {
    const pulse = (Math.sin(animPhase) + 1) / 2;
    ctx.beginPath();
    ctx.roundRect(cardX - 6, cardY - 6, CARD_W + 12, CARD_H + 12, r + 4);
    ctx.strokeStyle = borderColor + Math.round(pulse * 0x33).toString(16).padStart(2, "0");
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(cardX - 3, cardY - 3, CARD_W + 6, CARD_H + 6, r + 2);
    ctx.strokeStyle = borderColor + Math.round(pulse * 0x66).toString(16).padStart(2, "0");
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else if (branchStatus === "in_review") {
    ctx.beginPath();
    ctx.roundRect(cardX - 3, cardY - 3, CARD_W + 6, CARD_H + 6, r + 2);
    ctx.strokeStyle = "#D9A93866";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else if (branchStatus === "blocked") {
    ctx.beginPath();
    ctx.roundRect(cardX - 3, cardY - 3, CARD_W + 6, CARD_H + 6, r + 2);
    ctx.strokeStyle = "#ef444466";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else if (branchStatus === "planning") {
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.roundRect(cardX - 3, cardY - 3, CARD_W + 6, CARD_H + 6, r + 2);
    ctx.strokeStyle = "#D9A93855";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.beginPath();
  ctx.roundRect(cardX, cardY, CARD_W, CARD_H, r);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Status marker (left side): done → ✓, cancelled → ✕ (calm slate, no pulse);
  // everything else → a status-coloured dot.
  if (issueStatus === "done" || issueStatus === "cancelled") {
    ctx.font = "bold 10px sans-serif";
    ctx.fillStyle = TERMINAL_MARK_COLOR;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(issueStatus === "done" ? "✓" : "✕", cardX + 10, y);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  } else {
    ctx.beginPath();
    ctx.arc(cardX + 10, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = statusDotColor(issueStatus, laneColor);
    ctx.fill();
  }

  ctx.strokeStyle = borderColor + "99";
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  const lineX1 = cardX + 18;
  const lineX2 = cardX + CARD_W - 5;
  ctx.beginPath(); ctx.moveTo(lineX1, y - 4); ctx.lineTo(lineX2, y - 4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(lineX1, y);     ctx.lineTo(lineX2, y);     ctx.stroke();
  ctx.beginPath(); ctx.moveTo(lineX1, y + 4); ctx.lineTo(lineX2, y + 4); ctx.stroke();
  ctx.lineCap = "butt";

  ctx.restore();
}

export function drawCommitNode(
  ctx: CanvasRenderingContext2D,
  node: ArcCommitLayout,
  animPhase: number,
  branchStatus: string | null,
  asDot = false,
) {
  if (node.isTaskTip && !asDot) {
    drawTaskCardAt(
      ctx,
      node.x,
      node.y,
      {
        issueStatus: node.issueStatus,
        laneColor: node.laneColor,
        isDone: node.isDone,
        branchStatus,
      },
      animPhase,
    );
    return;
  }

  const doneAlpha = node.isDone ? 0.45 : 1;

  if (node.isMerge) {
    // Diamond for merge commits
    ctx.save();
    ctx.globalAlpha = doneAlpha;
    const s = COMMIT_R;
    ctx.beginPath();
    ctx.moveTo(node.x, node.y - s);
    ctx.lineTo(node.x + s, node.y);
    ctx.lineTo(node.x, node.y + s);
    ctx.lineTo(node.x - s, node.y);
    ctx.closePath();
    ctx.fillStyle = MERGE_COLOR + "80";
    ctx.strokeStyle = MERGE_COLOR;
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  } else {
    // Regular commit circle
    ctx.save();
    ctx.globalAlpha = doneAlpha;
    if (!node.isTrunk && node.isBranchTip && !node.isTaskTip) {
      // Off-trunk plain branch head — slightly larger dashed circle
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.arc(node.x, node.y, COMMIT_R + 2, 0, Math.PI * 2);
    } else if (!node.isTrunk && node.isRemoteOnly) {
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.arc(node.x, node.y, COMMIT_R, 0, Math.PI * 2);
    } else {
      ctx.beginPath();
      ctx.arc(node.x, node.y, COMMIT_R, 0, Math.PI * 2);
    }
    ctx.fillStyle = node.laneColor + "60";
    ctx.strokeStyle = node.laneColor;
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

export function drawCardLabel(
  ctx: CanvasRenderingContext2D,
  node: ArcCommitLayout,
  branch: GitBranchInfo,
) {
  ctx.save();
  ctx.globalAlpha = node.isDone ? 0.45 : 1;

  const baseX = node.x - CARD_W / 2;
  const baseY = node.y + CARD_H / 2;

  // Line 1: task identifier (monospace, muted)
  if (branch.linkedIssueIdentifier) {
    ctx.font = `7px "Courier New", monospace`;
    ctx.fillStyle = "#7E8AA8";
    ctx.fillText(branch.linkedIssueIdentifier, baseX, baseY + 9);
  }

  // Line 2: truncated title
  if (branch.linkedIssueTitle) {
    ctx.font = `8px Inter, sans-serif`;
    ctx.fillStyle = "#cccccc";
    const title =
      branch.linkedIssueTitle.length > 14
        ? branch.linkedIssueTitle.slice(0, 13) + "…"
        : branch.linkedIssueTitle;
    ctx.fillText(title, baseX, baseY + 19);
  }

  ctx.restore();
}

export function drawCardBadges(
  ctx: CanvasRenderingContext2D,
  node: ArcCommitLayout,
  branch: GitBranchInfo,
) {
  const rightEdgeX = node.x + CARD_W / 2;

  // 1. CI passing badge — filled green circle with ✓
  if (branch.pr?.ciStatus === "passing") {
    const cx = rightEdgeX + 8;
    const cy = node.y - CARD_H / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#4FB67E";
    ctx.fill();
    ctx.font = "bold 6px sans-serif";
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("✓", cx, cy);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
    ctx.restore();
    return; // CI badge takes priority
  }

  // 2. PR badge — small indigo rect
  if (branch.pr) {
    const bx = rightEdgeX + 4;
    const by = node.y - 4.5;
    const bw = 18;
    const bh = 9;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 2);
    ctx.fillStyle = "#6470DC33";
    ctx.fill();
    ctx.strokeStyle = "#6470DC";
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.font = "bold 6px sans-serif";
    ctx.fillStyle = "#8490e8";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("PR", bx + bw / 2, by + bh / 2);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
    ctx.restore();
    return;
  }

  // 3. Conflict warning
  if (branch.overlays?.hasConflicts) {
    ctx.save();
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#ffa040";
    ctx.fillText("⚠", rightEdgeX + 5, node.y + 4);
    ctx.restore();
  }
}

export function drawTagPills(ctx: CanvasRenderingContext2D, node: ArcCommitLayout) {
  if (node.tags.length === 0) return;

  ctx.save();
  ctx.font = "bold 9px 'Courier New', monospace";

  let offsetX = node.x + COMMIT_R + 4;
  const pillH = 14;
  const pillY = node.y - pillH / 2;

  for (const tag of node.tags.slice(0, 2)) {
    const textW = ctx.measureText(tag).width;
    const pillW = textW + 10;
    const pillR = 7;

    ctx.beginPath();
    ctx.roundRect(offsetX, pillY, pillW, pillH, pillR);
    ctx.fillStyle = "rgba(217,169,56,0.15)";
    ctx.fill();
    ctx.strokeStyle = "rgba(217,169,56,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#D9A938";
    ctx.fillText(tag, offsetX + 5, pillY + 9.5);

    offsetX += pillW + 4;
  }
  ctx.restore();
}

export function drawHeadLabel(ctx: CanvasRenderingContext2D, node: ArcCommitLayout) {
  ctx.save();
  ctx.font = "9px 'Courier New', monospace";
  ctx.fillStyle = "#7E8AA8";
  ctx.globalAlpha = 0.9;
  // Use card half-height for task-tip nodes, commit radius for plain nodes
  const labelY = node.isTaskTip
    ? node.y - CARD_H / 2 - 8
    : node.y - COMMIT_R - 8;
  const labelW = ctx.measureText("HEAD").width;
  ctx.fillText("HEAD", node.x - labelW / 2, labelY);
  ctx.restore();
}


export function drawTrunk(
  ctx: CanvasRenderingContext2D,
  nodes: ArcCommitLayout[],
  trunkY: number,
  color: string,
  defaultBranch: string,
) {
  const trunkNodes = nodes.filter((n) => n.isTrunk);
  if (trunkNodes.length < 2) return;
  const minX = Math.min(...trunkNodes.map((n) => n.x));
  const maxX = Math.max(...trunkNodes.map((n) => n.x));
  ctx.save();
  // Glow underlay
  ctx.beginPath();
  ctx.moveTo(minX, trunkY);
  ctx.lineTo(maxX, trunkY);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = 8;
  ctx.setLineDash([]);
  ctx.stroke();
  // Solid trunk
  ctx.beginPath();
  ctx.moveTo(minX, trunkY);
  ctx.lineTo(maxX, trunkY);
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = 3.5;
  ctx.stroke();
  // Label at the left end
  ctx.globalAlpha = 0.85;
  ctx.font = `bold 9px "Courier New", monospace`;
  ctx.fillStyle = color;
  ctx.fillText(defaultBranch, minX, trunkY - 8);
  ctx.restore();
}

export function drawArcLines(
  ctx: CanvasRenderingContext2D,
  arcs: ArcDefinition[],
  visibleNames: Set<string>,
  /** Viewport's left edge in layout space. Arcs whose branch point is left of
   * this get a dashed "from older history" entry stub instead of a full arc. */
  viewportLeftInLayout = -Infinity,
) {
  for (const arc of arcs) {
    if (!visibleNames.has(arc.branchName)) continue;
    if (arc.points.length < 2) continue;

    // Clip the off-screen-left head if the branch forks from older history.
    let pts = arc.points;
    let leftStub = false;
    if (arc.branchPointX < viewportLeftInLayout) {
      const clipped = clipPolylineLeft(arc.points, viewportLeftInLayout);
      if (!clipped) continue; // fully off-screen
      pts = clipped;
      leftStub = clipped.length >= 2;
    }

    // Split into solid (smoothed) head and straight dashed stubs.
    let head = pts;
    let leftTail: [[number, number], [number, number]] | null = null;
    let rightTail: [number, number] | null = null;

    if (leftStub) {
      leftTail = [head[0]!, head[1]!];
      head = head.slice(1);
    }
    if (arc.isOpen && head.length >= 2) {
      rightTail = head[head.length - 1]!;
      head = head.slice(0, -1);
    }

    ctx.save();
    ctx.strokeStyle = arc.color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = arc.isDone ? 0.4 : 0.7;

    ctx.setLineDash([]);
    if (head.length >= 2) strokeSmoothPath(ctx, head);

    ctx.setLineDash([4, 4]);
    if (leftTail) {
      ctx.beginPath();
      ctx.moveTo(leftTail[0][0], leftTail[0][1]);
      ctx.lineTo(leftTail[1][0], leftTail[1][1]);
      ctx.stroke();
    }
    if (rightTail) {
      const lastSolid = head[head.length - 1] ?? leftTail?.[1];
      if (lastSolid) {
        ctx.beginPath();
        ctx.moveTo(lastSolid[0], lastSolid[1]);
        ctx.lineTo(rightTail[0], rightTail[1]);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  }
}

export function drawArcLabels(
  ctx: CanvasRenderingContext2D,
  arcs: ArcDefinition[],
  visibleNames: Set<string>,
  /**
   * Branch names that already render a task card. Those cards show the task
   * identifier + title, so a separate arc name label would collide — skip them.
   */
  cardBranchNames: Set<string>,
) {
  // Positions come from the shared pure pass so the hit-registry (git-arc-hit)
  // lands on the exact same de-overlapped spots (single source, no drift).
  const placed = placeArcLabels(arcs, visibleNames, cardBranchNames);
  ctx.save();
  ctx.font = `9px "Courier New", monospace`;
  ctx.globalAlpha = 0.7;
  for (const arc of arcs) {
    const p = placed.get(arc.branchName);
    if (!p) continue;
    const name =
      arc.branchName.length > 18 ? arc.branchName.slice(0, 17) + "…" : arc.branchName;
    ctx.fillStyle = arc.color;
    ctx.fillText(name, p.x, p.y);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

export function drawLabelDots(
  ctx: CanvasRenderingContext2D,
  node: ArcCommitLayout,
  branch: GitBranchInfo,
) {
  const labels = branch.pr?.labels;
  if (!labels || labels.length === 0) return;
  const maxDots = Math.min(labels.length, 3);
  const startX = node.x - CARD_W / 2;
  const dotY = node.y + CARD_H / 2 + 28; // below card label text
  ctx.save();
  for (let i = 0; i < maxDots; i++) {
    const color = labels[i]!.color;
    ctx.fillStyle = color.startsWith("#") ? color : `#${color}`;
    ctx.beginPath();
    ctx.rect(startX + i * 8, dotY, 5, 5);
    ctx.fill();
  }
  ctx.restore();
}

export function drawFlowPulse(
  ctx: CanvasRenderingContext2D,
  arcs: ArcDefinition[],
  trunkNodes: ArcCommitLayout[],
  branchByName: Map<string, GitBranchInfo>,
  animPhase: number,
  visibleNames: Set<string>,
  trunkY: number,
  _defaultBranch: string,
) {
  ctx.save();

  const t = ((animPhase * 0.3) % (Math.PI * 2)) / (Math.PI * 2);

  // Always-on trunk pulse: a bright dot travels left→right along the trunk.
  if (trunkNodes.length >= 2) {
    const minX = Math.min(...trunkNodes.map((n) => n.x));
    const maxX = Math.max(...trunkNodes.map((n) => n.x));
    const dotX = minX + t * (maxX - minX);
    ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.arc(dotX, trunkY, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff"; ctx.fill();
    ctx.beginPath(); ctx.arc(dotX, trunkY, 9, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff22"; ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Arc pulses
  for (const arc of arcs) {
    if (!visibleNames.has(arc.branchName)) continue;
    const info = branchByName.get(arc.branchName);
    if (!info) continue;
    const isRunning = info.linkedIssueStatus === "in_progress";
    const isInReview = info.linkedIssueStatus === "in_review";
    if (!isRunning && !isInReview) continue;

    const dotColor = isRunning ? "#4FB67E" : "#D9A938";
    const [dotX, dotY] = polylinePointAt(arc.points, t);

    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
    ctx.fillStyle = dotColor; ctx.fill();
    ctx.beginPath(); ctx.arc(dotX, dotY, 7, 0, Math.PI * 2);
    ctx.fillStyle = dotColor + "30"; ctx.fill();
  }

  ctx.restore();
}

/** Draw ahead/behind sync markers (↑N green, ↓N amber) above a branch tip.
 * Nudged higher on the default tip so it clears the HEAD label. */
export function drawSyncBadge(
  ctx: CanvasRenderingContext2D,
  node: ArcCommitLayout,
  branch: GitBranchInfo,
) {
  const ahead = branch.aheadCount ?? 0;
  const behind = branch.behindCount ?? 0;
  if (ahead === 0 && behind === 0) return;

  const aboveCard = node.isTaskTip ? CARD_H / 2 : COMMIT_R;
  const base = node.isDefault ? 22 : 8; // clear the HEAD label on the default tip
  const y = node.y - aboveCard - base;

  ctx.save();
  ctx.font = "bold 9px Inter, sans-serif";
  ctx.textBaseline = "middle";

  const parts: Array<{ s: string; color: string }> = [];
  if (ahead > 0) parts.push({ s: `↑${ahead}`, color: "#4FB67E" });
  if (behind > 0) parts.push({ s: `↓${behind}`, color: "#D9A938" });

  const totalW = parts.reduce((w, p) => w + ctx.measureText(p.s).width, 0) + (parts.length - 1) * 4;
  let x = node.x - totalW / 2;
  for (const p of parts) {
    ctx.fillStyle = p.color;
    ctx.fillText(p.s, x, y);
    x += ctx.measureText(p.s).width + 4;
  }

  ctx.textBaseline = "alphabetic";
  ctx.restore();
}

/** Draw fanned cards for a same-commit task stack: dashed connectors from the
 * shared commit to each card, up to STACK_MAX_CARDS cards, plus a "+N more"
 * pill (display-only). */
export function drawTipStack(
  ctx: CanvasRenderingContext2D,
  stack: TipStack,
  branchByName: Map<string, GitBranchInfo>,
  animPhase: number,
) {
  const cards = computeStackCardLayout(stack);

  // Dashed connectors commit → each card's left edge.
  ctx.save();
  ctx.strokeStyle = NEUTRAL_GREY;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([2, 2]);
  for (const c of cards) {
    ctx.beginPath();
    ctx.moveTo(stack.x, stack.y);
    ctx.lineTo(c.x - CARD_W / 2, c.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();

  // Cards + compact id label.
  for (const c of cards) {
    const b = branchByName.get(c.branchName);
    const issueStatus = b?.linkedIssueStatus ?? null;
    drawTaskCardAt(
      ctx,
      c.x,
      c.y,
      {
        issueStatus,
        laneColor: NEUTRAL_GREY,
        isDone: issueStatus === "done" || issueStatus === "cancelled",
        branchStatus: issueStatus,
      },
      animPhase,
    );
    if (b?.linkedIssueIdentifier) {
      ctx.save();
      ctx.font = `7px "Courier New", monospace`;
      ctx.fillStyle = NEUTRAL_GREY;
      ctx.textBaseline = "middle";
      ctx.fillText(b.linkedIssueIdentifier, c.x + CARD_W / 2 + 6, c.y);
      ctx.restore();
    }
  }

  // "+N more" pill (display-only — full list is in the Pipeline tab). Includes
  // absorbed plain branches (extraNames) so the broom count is honest. (Phase 2A)
  const extra = (stack.branchNames.length - cards.length) + (stack.extraNames?.length ?? 0);
  if (extra > 0) {
    const px = stack.x + 50;
    const py = stack.y + 8;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(px, py, 54, 15, 7);
    ctx.fillStyle = "#1e1d1c";
    ctx.fill();
    ctx.strokeStyle = "#2e2c2a";
    ctx.stroke();
    ctx.font = `9px Inter, sans-serif`;
    ctx.fillStyle = NEUTRAL_GREY;
    ctx.textBaseline = "middle";
    ctx.fillText(`+${extra} more`, px + 7, py + 8);
    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }
}
