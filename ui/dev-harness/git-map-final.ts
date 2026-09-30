/**
 * git-map-final.ts — the FULL agreed Git Map design in one scene, for sign-off.
 * Illustrative (manual primitives), shows every locked decision together.
 *
 * Build: npx esbuild ui/dev-harness/git-map-final.ts --bundle --format=iife \
 *          --outfile=ui/dev-harness/git-map-final.bundle.js
 * View:  http://localhost:4500/git-map-final.html
 */

import { STATUS_COLORS } from "../src/components/workspace/git-arc-draw";

type Ctx = CanvasRenderingContext2D;
const GREY = "#7E8AA8";
const TRUNK_BLUE = "#6470DC";
const INDIGO = "#6470DC";

function txt(ctx: Ctx, s: string, x: number, y: number, color = "#e5e5e5", font = "12px Inter, sans-serif") {
  ctx.save(); ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = "middle"; ctx.fillText(s, x, y); ctx.restore();
}
const tiny = (ctx: Ctx, s: string, x: number, y: number, c = "#9aa0aa") => txt(ctx, s, x, y, c, "10px 'Courier New', monospace");

function trunk(ctx: Ctx, x0: number, x1: number, y: number) {
  ctx.save(); ctx.strokeStyle = TRUNK_BLUE; ctx.setLineDash([]);
  ctx.globalAlpha = 0.16; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  ctx.globalAlpha = 0.95; ctx.lineWidth = 3.5; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  ctx.restore();
}
function commit(ctx: Ctx, x: number, y: number, color = GREY) {
  ctx.save(); ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = color + "55"; ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke(); ctx.restore();
}
function dashedTip(ctx: Ctx, x: number, y: number, color = GREY) {
  ctx.save(); ctx.setLineDash([3, 2]); ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fillStyle = color + "44"; ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke(); ctx.restore();
}
function merge(ctx: Ctx, x: number, y: number) {
  const s = 5.5; ctx.save(); ctx.beginPath();
  ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath();
  ctx.fillStyle = INDIGO + "85"; ctx.strokeStyle = INDIGO; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke(); ctx.restore();
}
function arc(ctx: Ctx, x0: number, y0: number, ax: number, ay: number, x1: number, y1: number, dashedTail = false) {
  ctx.save(); ctx.strokeStyle = GREY; ctx.globalAlpha = 0.7; ctx.lineWidth = 2; ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(ax, ay, x1, y1); ctx.stroke();
  if (dashedTail) { ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 + 46, y1); ctx.stroke(); }
  ctx.restore();
}
function dashedStub(ctx: Ctx, x0: number, y: number, x1: number) {
  ctx.save(); ctx.strokeStyle = GREY; ctx.globalAlpha = 0.6; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.restore();
}
function card(ctx: Ctx, x: number, y: number, status: keyof typeof STATUS_COLORS | null, id: string, title: string, ring = true) {
  const col = status ? STATUS_COLORS[status] : GREY;
  const done = status === "done";
  ctx.save(); ctx.globalAlpha = done ? 0.55 : 1;
  if (ring && status && status !== "done") {
    ctx.beginPath(); (ctx as any).roundRect(x - 17, y - 12, 34, 24, 6);
    ctx.strokeStyle = col + "55"; ctx.lineWidth = 1.5; ctx.stroke();
  }
  ctx.beginPath(); (ctx as any).roundRect(x - 14, y - 9, 28, 18, 4);
  ctx.fillStyle = "#0f0e0d"; ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(x - 4, y, 3, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
  ctx.restore();
  tiny(ctx, id, x - 14, y + 18, GREY);
  txt(ctx, title, x - 14, y + 30, "#cccccc", "10px Inter, sans-serif");
}
function badge(ctx: Ctx, x: number, y: number, s: string, color: string) {
  txt(ctx, s, x, y, color, "bold 10px Inter, sans-serif");
}
function pulse(ctx: Ctx, x: number, y: number) {
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fillStyle = "#ffffff22"; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill();
  ctx.restore();
}

function draw() {
  const c = document.getElementById("g") as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  const W = 1180, H = 680;
  c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = W + "px"; c.style.height = H + "px";
  const ctx = c.getContext("2d")!; ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);

  txt(ctx, "Git Map — final agreed design (sign-off)", 24, 26, "#ffffff", "bold 16px Inter, sans-serif");
  tiny(ctx, "grey lines + dots · status only on cards · indigo merges · solid trunk · stacks · sync markers", 24, 46, "#9aa0aa");

  const TY = 360;
  trunk(ctx, 120, 980, TY);
  txt(ctx, "main", 120, TY - 14, TRUNK_BLUE, "bold 10px 'Courier New', monospace");

  // trunk history (solid grey dots) + indigo merges, NO mid-trunk dashes
  const tx = [160, 240, 330, 430, 540, 660, 780, 900, 980];
  for (const x of tx) commit(ctx, x, TY);
  merge(ctx, 430, TY);   // a branch merged here
  merge(ctx, 780, TY);   // another merge
  pulse(ctx, 600, TY);   // live pulse sweeping the trunk

  // 1. MERGED branch (top-left) — grey closed arc to merge diamond; DONE card (faded grey)
  arc(ctx, 330, TY, 380, TY - 60, 430, TY);
  card(ctx, 380, TY - 64, "done", "AOA-3", "Auth refactor", false);

  // 2. OPEN branch (top) — grey arc + right dashed tail; IN-PROGRESS card (green) + ahead badge
  arc(ctx, 540, TY, 600, TY - 70, 660, TY - 70, true);
  card(ctx, 660, TY - 70, "in_progress", "AOA-18", "Search", true);
  badge(ctx, 690, TY - 82, "↑2", STATUS_COLORS.in_progress);

  // 3. OPEN branch (top-right) — IN-REVIEW card (amber)
  arc(ctx, 780, TY, 850, TY - 55, 905, TY - 55, true);
  card(ctx, 850, TY - 55, "in_review", "AOA-21", "Export CSV", true);

  // 4. FAR-LEFT fork — left dashed "from older history" stub → grey arc → BLOCKED card (red)
  dashedStub(ctx, 30, TY + 80, 120);
  txt(ctx, "← from older history", 30, TY + 66, GREY, "10px Inter, sans-serif");
  arc(ctx, 120, TY + 80, 175, TY + 110, 235, TY + 80);  // little arc near the entry
  card(ctx, 235, TY + 80, "blocked", "AOA-7", "Crash fix", true);

  // 5. NO-TASK branch (bottom-middle) — grey arc → grey DASHED tip (no card) + behind badge
  arc(ctx, 540, TY, 600, TY + 70, 660, TY + 70);
  dashedTip(ctx, 660, TY + 70, GREY);
  tiny(ctx, "chore/cleanup", 632, TY + 90, GREY);
  badge(ctx, 690, TY + 70, "↓1", STATUS_COLORS.in_review);

  // 6. REMOTE-ONLY branch (bottom-right) — dashed grey arc + dashed tip
  ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = GREY; ctx.globalAlpha = 0.6; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(780, TY); ctx.quadraticCurveTo(840, TY + 55, 900, TY + 55); ctx.stroke(); ctx.restore();
  dashedTip(ctx, 900, TY + 55, GREY);
  tiny(ctx, "origin/feat-x (remote-only)", 855, TY + 75, GREY);

  // 7. SAME-COMMIT STACK at HEAD (x=980) — stacked cards + "+N more"
  txt(ctx, "HEAD", 968, TY - 86, GREY, "9px 'Courier New', monospace");
  card(ctx, 1060, TY - 60, "in_progress", "AOA-30", "Indexing", true);
  card(ctx, 1060, TY - 18, "in_review", "AOA-31", "Voice input", true);
  // connector from HEAD to the stack
  ctx.save(); ctx.strokeStyle = GREY; ctx.globalAlpha = 0.5; ctx.setLineDash([2, 2]); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(985, TY); ctx.lineTo(1043, TY - 60); ctx.moveTo(985, TY); ctx.lineTo(1043, TY - 18); ctx.stroke(); ctx.restore();
  ctx.save(); ctx.beginPath(); (ctx as any).roundRect(1040, TY + 4, 70, 16, 8);
  ctx.fillStyle = "#1e1d1c"; ctx.fill(); ctx.strokeStyle = "#2e2c2a"; ctx.stroke();
  txt(ctx, "+3 more", 1048, TY + 12, GREY, "10px Inter, sans-serif"); ctx.restore();
  tiny(ctx, "3+ branches on the same commit", 985, TY + 36, GREY);

  // ── Legend strip ───────────────────────────────────────────────────────────
  const ly = 600;
  ctx.save(); ctx.strokeStyle = "#2e2c2a"; ctx.strokeRect(24, ly - 24, W - 48, 56); ctx.restore();
  txt(ctx, "KEY", 36, ly - 10, GREY, "bold 10px 'Courier New', monospace");
  let lx = 90;
  const item = (drawIt: () => void, label: string, w = 150) => { drawIt(); txt(ctx, label, lx + 16, ly + 4, "#cccccc", "11px Inter, sans-serif"); lx += 16 + w; };
  item(() => commit(ctx, lx, ly + 4), "commit", 90);
  item(() => merge(ctx, lx, ly + 4), "merge (indigo)", 130);
  item(() => dashedTip(ctx, lx, ly + 4), "branch head (no task)", 165);
  item(() => { ctx.save(); ctx.strokeStyle = GREY; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(lx - 8, ly + 4); ctx.lineTo(lx + 8, ly + 4); ctx.stroke(); ctx.restore(); }, "branch (grey)", 120);
  item(() => card(ctx, lx + 4, ly + 4, "in_progress", "", "", false), "task (status colour)", 150);
  item(() => badge(ctx, lx, ly + 8, "↑↓", "#cccccc"), "ahead / behind", 120);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => requestAnimationFrame(draw));
} else {
  requestAnimationFrame(draw);
}
