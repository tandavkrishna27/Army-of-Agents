/**
 * git-map-decisions.ts — illustrative mock for the open Git Map design calls:
 *   1. Dotted circles on the trunk (current noise vs a cleaner option)
 *   2. Status on the whole branch vs only on the task card
 *   3. Local vs remote markers (+ the multi-user limitation)
 *
 * Manual primitives (not the production draw code) so we can sketch options that
 * aren't built yet. Build:
 *   npx esbuild ui/dev-harness/git-map-decisions.ts --bundle --format=iife \
 *     --outfile=ui/dev-harness/git-map-decisions.bundle.js
 */

import { STATUS_COLORS } from "../src/components/workspace/git-arc-draw";

type Ctx = CanvasRenderingContext2D;

function txt(ctx: Ctx, s: string, x: number, y: number, color = "#e5e5e5", font = "13px Inter, sans-serif") {
  ctx.save(); ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = "middle"; ctx.fillText(s, x, y); ctx.restore();
}
const small = (ctx: Ctx, s: string, x: number, y: number, c = "#9aa0aa") => txt(ctx, s, x, y, c, "11px Inter, sans-serif");
const head = (ctx: Ctx, s: string, x: number, y: number) => txt(ctx, s, x, y, "#cfcfcf", "bold 13px Inter, sans-serif");
const sect = (ctx: Ctx, s: string, x: number, y: number) => txt(ctx, s.toUpperCase(), x, y, "#7E8AA8", "bold 11px 'Courier New', monospace");

function line(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, color: string, dash: number[] = [], w = 2) {
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash(dash); ctx.globalAlpha = 0.85;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.restore();
}
function trunk(ctx: Ctx, x0: number, x1: number, y: number) {
  ctx.save(); ctx.strokeStyle = "#6470DC"; ctx.setLineDash([]);
  ctx.globalAlpha = 0.18; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  ctx.globalAlpha = 0.95; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  ctx.restore();
}
function dot(ctx: Ctx, x: number, y: number, color: string, dashed = false, r = 5) {
  ctx.save(); ctx.setLineDash(dashed ? [3, 2] : []); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color + "60"; ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke(); ctx.restore();
}
function diamond(ctx: Ctx, x: number, y: number, color = "#6470DC") {
  const s = 5; ctx.save(); ctx.beginPath();
  ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath();
  ctx.fillStyle = color + "80"; ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke(); ctx.restore();
}
function card(ctx: Ctx, x: number, y: number, color: string) {
  ctx.save();
  ctx.beginPath(); (ctx as any).roundRect(x - 14, y - 9, 28, 18, 4);
  ctx.fillStyle = "#0f0e0d"; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(x - 4, y, 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  ctx.restore();
}
function panel(ctx: Ctx, x: number, y: number, w: number, h: number, title: string, tc = "#cfcfcf") {
  ctx.save(); ctx.strokeStyle = "#2e2c2a"; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h); ctx.restore();
  txt(ctx, title, x + 12, y + 16, tc, "bold 12px Inter, sans-serif");
}

function draw() {
  const c = document.getElementById("g") as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  const W = 1000, H = 1010;
  c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = W + "px"; c.style.height = H + "px";
  const ctx = c.getContext("2d")!; ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);

  txt(ctx, "Git Map — open design decisions (illustrative sketch)", 24, 26, "#ffffff", "bold 16px Inter, sans-serif");

  const PW = 440, gap = 30, leftX = 24, rightX = 24 + PW + gap;

  // ── 1. Trunk dotted circles ────────────────────────────────────────────────
  let y = 58; sect(ctx, "1. Dotted circles on the trunk", 24, y); y += 22;
  small(ctx, "Interior main commits go dashed when they're also a branch tip / remote ref → noisy.", 24, y); y += 22;
  const ph1 = 120;
  panel(ctx, leftX, y, PW, ph1, "Current — dashed circles mid-history", "#C264B8");
  panel(ctx, rightX, y, PW, ph1, "Cleaner — solid history, small branch tab", STATUS_COLORS.in_progress);
  {
    const ty = y + 70;
    // current: trunk with mixed dashed dots + merge
    trunk(ctx, leftX + 24, leftX + PW - 24, ty);
    const xs = [leftX + 60, leftX + 120, leftX + 180, leftX + 250, leftX + 320, leftX + 380];
    dot(ctx, xs[0]!, ty, "#6470DC");
    dot(ctx, xs[1]!, ty, "#6470DC", true);     // dashed (also a branch tip)
    diamond(ctx, xs[2]!, ty);                   // merge
    dot(ctx, xs[3]!, ty, "#6470DC", true);     // dashed
    dot(ctx, xs[4]!, ty, "#6470DC");
    diamond(ctx, xs[5]!, ty);
    small(ctx, "dashed + diamonds scattered → hard to read", leftX + 40, ty + 28);

    // cleaner: solid dots + merges; a tiny tab marks where a branch diverges
    trunk(ctx, rightX + 24, rightX + PW - 24, ty);
    const rxs = [rightX + 60, rightX + 120, rightX + 180, rightX + 250, rightX + 320, rightX + 380];
    dot(ctx, rxs[0]!, ty, "#6470DC");
    dot(ctx, rxs[1]!, ty, "#6470DC");
    diamond(ctx, rxs[2]!, ty);
    dot(ctx, rxs[3]!, ty, "#6470DC");
    dot(ctx, rxs[4]!, ty, "#6470DC");
    diamond(ctx, rxs[5]!, ty);
    // branch tab at rxs[3]
    line(ctx, rxs[3]!, ty - 6, rxs[3]!, ty - 18, STATUS_COLORS.in_progress, [], 2);
    small(ctx, "feat/x", rxs[3]! - 14, ty - 26, STATUS_COLORS.in_progress);
    small(ctx, "history stays solid; tab = a branch starts here", rightX + 40, ty + 28);
  }
  y += ph1 + 26;

  // ── 2. Status placement ────────────────────────────────────────────────────
  sect(ctx, "2. Status colour — on the branch, or only on the task card?", 24, y); y += 22;
  small(ctx, "Status belongs to the TASK (which owns a branch). So show it on the card, not the whole line?", 24, y); y += 22;
  const ph2 = 150;
  panel(ctx, leftX, y, PW, ph2, "A — whole arc coloured by status", "#C264B8");
  panel(ctx, rightX, y, PW, ph2, "B — arc neutral, status only on card (your lean)", STATUS_COLORS.in_progress);
  {
    const ty = y + 100, bx0 = 60, bx1 = 175;
    // A: arc colored green
    trunk(ctx, leftX + 24, leftX + PW - 24, ty);
    line(ctx, leftX + bx0, ty, leftX + (bx0 + bx1) / 2, ty - 44, STATUS_COLORS.in_progress);
    line(ctx, leftX + (bx0 + bx1) / 2, ty - 44, leftX + bx1, ty, STATUS_COLORS.in_progress);
    card(ctx, leftX + (bx0 + bx1) / 2, ty - 44, STATUS_COLORS.in_progress);
    small(ctx, "whole branch green = blocked/active at a glance", leftX + 40, ty + 26);

    // B: arc neutral grey, card green
    trunk(ctx, rightX + 24, rightX + PW - 24, ty);
    line(ctx, rightX + bx0, ty, rightX + (bx0 + bx1) / 2, ty - 44, "#7E8AA8");
    line(ctx, rightX + (bx0 + bx1) / 2, ty - 44, rightX + bx1, ty, "#7E8AA8");
    card(ctx, rightX + (bx0 + bx1) / 2, ty - 44, STATUS_COLORS.in_progress);
    small(ctx, "lines are quiet structure; status reads on the card", rightX + 40, ty + 26);
  }
  y += ph2 + 26;

  // ── 3. Local vs remote ─────────────────────────────────────────────────────
  sect(ctx, "3. Local vs remote (and multiple users)", 24, y); y += 22;
  small(ctx, "The Map reads the server's clone + the remote (GitHub). It can't see other people's un-pushed local work.", 24, y); y += 20;
  small(ctx, "The remote is the shared truth; per-branch we can show sync state for the server's clone:", 24, y); y += 26;
  {
    const ry = y + 10; let x = 70;
    const seg = (label: string, drawIt: () => void, wlabel = 150) => {
      drawIt(); small(ctx, label, x + 18, ry); x += 18 + wlabel;
    };
    // synced
    seg("Synced (local = remote)", () => { line(ctx, x - 18, ry, x - 2, ry, "#7E8AA8"); dot(ctx, x + 4, ry, "#7E8AA8"); }, 160);
    // remote-only
    seg("Remote-only (not here)", () => { line(ctx, x - 18, ry, x - 2, ry, "#7E8AA8", [3, 2]); dot(ctx, x + 4, ry, "#7E8AA8", true); }, 160);
    // ahead
    seg("", () => { dot(ctx, x + 4, ry, "#7E8AA8"); txt(ctx, "↑2", x + 14, ry, "#4FB67E", "11px Inter"); small(ctx, "Local ahead (un-pushed)", x + 34, ry); }, 0);
    // (next line) behind
    const ry2 = ry + 30; x = 70;
    dot(ctx, x + 4, ry2, "#7E8AA8"); txt(ctx, "↓1", x + 14, ry2, "#D9A938", "11px Inter"); small(ctx, "Behind remote", x + 34, ry2);
    small(ctx, "Multi-user: others' pushed branches appear via the remote; their private local work cannot.", 270, ry2, "#9aa0aa");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => requestAnimationFrame(draw));
} else {
  requestAnimationFrame(draw);
}
