/**
 * glyph-gallery.ts — visual key for the Git Map: every shape, colour, and what
 * it means, drawn with the REAL draw code. Also shows the two "no-status colour"
 * options side by side so the choice is by eye, not by description.
 *
 * Build: npx esbuild ui/dev-harness/glyph-gallery.ts --bundle --format=iife \
 *          --outfile=ui/dev-harness/glyph-gallery.bundle.js
 * View:  browse goto file://./ui/dev-harness/glyph-gallery.html
 */

import {
  drawCommitNode,
  drawTrunk,
  drawArcLines,
  STATUS_COLORS,
} from "../src/components/workspace/git-arc-draw";
import type {
  ArcCommitLayout,
  ArcDefinition,
} from "../src/components/workspace/git-arc-layout";

function node(over: Partial<ArcCommitLayout>): ArcCommitLayout {
  return {
    sha: "x",
    x: 0,
    y: 0,
    isMerge: false,
    isTrunk: false,
    arcBranchName: null,
    branchName: null,
    isTaskTip: false,
    isBranchTip: false,
    issueStatus: null,
    isDone: false,
    isRemoteOnly: false,
    isDefault: false,
    tags: [],
    laneColor: "#7E8AA8",
    ...over,
  };
}

function arc(
  name: string,
  color: string,
  isOpen: boolean,
  points: Array<[number, number]>,
): ArcDefinition {
  return {
    branchName: name,
    direction: "up",
    branchPointX: points[0]![0],
    mergePointX: isOpen ? null : points[points.length - 1]![0],
    apexY: points[1]![1],
    isOpen,
    color,
    isDone: false,
    points,
  };
}

function text(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  color = "#e5e5e5",
  font = "13px Inter, sans-serif",
) {
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(s, x, y);
  ctx.restore();
}
const meaning = (ctx: CanvasRenderingContext2D, s: string, x: number, y: number) =>
  text(ctx, s, x, y, "#9aa0aa", "12px Inter, sans-serif");
const header = (ctx: CanvasRenderingContext2D, s: string, x: number, y: number) =>
  text(ctx, s.toUpperCase(), x, y, "#7E8AA8", "bold 11px 'Courier New', monospace");

function drawPanel(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  w: number,
  h: number,
  title: string,
  titleColor: string,
  noStatusColor: string,
) {
  ctx.save();
  ctx.strokeStyle = "#2e2c2a";
  ctx.lineWidth = 1;
  ctx.strokeRect(px, py, w, h);
  ctx.restore();
  text(ctx, title, px + 12, py + 18, titleColor, "bold 12px Inter, sans-serif");

  const ty = py + 95;
  const x0 = px + 24;
  const x1 = px + w - 24;
  drawTrunk(ctx, [node({ x: x0, y: ty, isTrunk: true }), node({ x: x1, y: ty, isTrunk: true })], ty, "#6470DC", "");

  // task branch (green, up) — closed arc + card
  const tbx0 = px + 60;
  const tbx1 = px + 175;
  drawArcLines(ctx, [arc("t", STATUS_COLORS.in_progress, false, [[tbx0, ty], [(tbx0 + tbx1) / 2, ty - 42], [tbx1, ty]])], new Set(["t"]));
  drawCommitNode(ctx, node({ x: (tbx0 + tbx1) / 2, y: ty - 42, isTaskTip: true, issueStatus: "in_progress", laneColor: STATUS_COLORS.in_progress }), 1.5, "in_progress");
  text(ctx, "task → green", tbx0, ty - 64, "#9aa0aa", "11px Inter, sans-serif");

  // no-task branch (noStatusColor, down) — open arc + dashed tip
  const nbx0 = px + 230;
  drawArcLines(ctx, [arc("n", noStatusColor, true, [[nbx0, ty], [nbx0 + 42, ty + 40], [nbx0 + 95, ty + 40]])], new Set(["n"]));
  drawCommitNode(ctx, node({ x: nbx0 + 42, y: ty + 40, isBranchTip: true, laneColor: noStatusColor }), 0, null);
  text(ctx, "no-task branch", nbx0, ty + 60, "#9aa0aa", "11px Inter, sans-serif");
}

function draw() {
  const canvas = document.getElementById("g") as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  const W = 980;
  const H = 880;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  text(ctx, "Git Map — glyph & colour key (drawn with the real code)", 24, 28, "#ffffff", "bold 16px Inter, sans-serif");

  // ── SHAPES ────────────────────────────────────────────────────────────────
  let y = 66;
  header(ctx, "Shapes — what KIND of thing it is", 24, y);
  y += 28;
  const gx = 60;
  const lx = 110;
  const mx = 320;
  const rowH = 44;

  drawCommitNode(ctx, node({ x: gx, y, laneColor: "#7E8AA8" }), 0, null);
  text(ctx, "Commit", lx, y); meaning(ctx, "a single commit (solid circle)", mx, y); y += rowH;

  drawCommitNode(ctx, node({ x: gx, y, isBranchTip: true, laneColor: "#7E8AA8" }), 0, null);
  text(ctx, "Branch tip — no task", lx, y); meaning(ctx, 'the "dotted circle" you saw — a branch head with no AoA task', mx, y); y += rowH;

  drawCommitNode(ctx, node({ x: gx, y, isRemoteOnly: true, laneColor: "#7E8AA8" }), 0, null);
  text(ctx, "Remote-only ref", lx, y); meaning(ctx, "on the remote but not local (also a dashed circle)", mx, y); y += rowH;

  drawCommitNode(ctx, node({ x: gx, y, isMerge: true, laneColor: "#6470DC" }), 0, null);
  text(ctx, "Merge commit", lx, y); meaning(ctx, "a merge — fixed indigo so it always reads as 'merge'", mx, y); y += rowH;

  drawCommitNode(ctx, node({ x: gx + 6, y, isTaskTip: true, issueStatus: "in_progress", laneColor: STATUS_COLORS.in_progress }), 1.5, "in_progress");
  text(ctx, "Task", lx, y); meaning(ctx, "branch linked to a task — card; border/ring = status", mx, y); y += rowH + 8;

  // ── LINES ─────────────────────────────────────────────────────────────────
  header(ctx, "Lines", 24, y); y += 28;

  drawTrunk(ctx, [node({ x: 40, y, isTrunk: true }), node({ x: 92, y, isTrunk: true })], y, "#6470DC", "");
  text(ctx, "Trunk (main)", lx, y); meaning(ctx, "the mainline; a white dot pulses along it L→R", mx, y); y += rowH;

  drawArcLines(ctx, [arc("b", STATUS_COLORS.in_progress, false, [[40, y], [66, y - 14], [92, y]])], new Set(["b"]));
  text(ctx, "Branch", lx, y); meaning(ctx, "a feature/task branch (coloured by status)", mx, y); y += rowH;

  drawArcLines(ctx, [arc("o", STATUS_COLORS.in_progress, true, [[40, y], [70, y - 10], [112, y - 10]])], new Set(["o"]));
  text(ctx, "Open branch", lx, y); meaning(ctx, 'the "dotted line" — unmerged, more commits may come', mx, y); y += rowH + 8;

  // ── STATUS COLOURS ─────────────────────────────────────────────────────────
  header(ctx, "Status colours — what the COLOUR means", 24, y); y += 28;
  const statuses: Array<[keyof typeof STATUS_COLORS, string]> = [
    ["in_progress", "In progress"],
    ["in_review", "In review"],
    ["blocked", "Blocked"],
    ["done", "Done / cancelled"],
  ];
  let sx = 60;
  ctx.font = "13px Inter, sans-serif";
  for (const [k, lab] of statuses) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(sx, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = STATUS_COLORS[k];
    ctx.fill();
    ctx.restore();
    text(ctx, lab, sx + 14, y);
    sx += 14 + ctx.measureText(lab).width + 40;
  }
  y += rowH + 12;

  // ── DECISION: no-status colour ─────────────────────────────────────────────
  header(ctx, "Decision #2: branches with NO task — what colour?", 24, y); y += 24;
  meaning(ctx, "Plain git branches (no AoA task) have no status. Left = grey; right = each branch its own colour. Which reads better?", 24, y);
  y += 26;

  const panelW = 440;
  const panelH = 150;
  drawPanel(ctx, 24, y, panelW, panelH, "A — no-status = GREY  (recommended)", STATUS_COLORS.done, "#7E8AA8");
  drawPanel(ctx, 24 + panelW + 30, y, panelW, panelH, "B — no-status = per-branch colour", "#C264B8", "#C264B8");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => requestAnimationFrame(draw));
} else {
  requestAnimationFrame(draw);
}
