# Git Command Centre — Map Readability v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the trunk-and-arcs Git Map readable and honest — neutral-grey structure with status colour only on task cards, an indigo merge glyph, a solid trunk, same-commit card stacking, far-left history stubs, sync (ahead/behind) markers, full-line hover, an overshoot-free curve, and a legend that matches what is actually drawn.

**Architecture:** The Map is a `<canvas>` rendered by `GitGraphCanvas.tsx`. Pure layout math lives in `git-arc-layout.ts` (zero DOM, fully unit-tested); pure canvas drawing lives in `git-arc-draw.ts` (no React/DOM events). The component wires layout → drawing in a `redraw()` callback driven by a ~30fps RAF loop, with D3 for pan/zoom and hit-testing for hover/click. A standalone esbuild harness (`ui/dev-harness/arc-harness.ts`) renders the exact same draw code for pixel verification against the signed-off mock (`ui/dev-harness/git-map-final.ts`).

**Tech Stack:** React 19 + Vite + D3 v7 + Canvas 2D, TypeScript (strict), Vitest 3 + jsdom, esbuild (harness bundling).

---

## Source of Truth

- **Final agreed design (visual sign-off):** `ui/dev-harness/git-map-final.ts` → `http://localhost:4500/git-map-final.html`
- **Glyph/colour key:** `ui/dev-harness/glyph-gallery.ts`
- **Decision panels:** `ui/dev-harness/git-map-decisions.ts`

Every visual task is verified by rebuilding `arc-harness.ts` and comparing the rendered canvas to `git-map-final.html` in the browser.

---

## Files Being Changed

| File | What changes |
|------|-------------|
| `ui/src/components/workspace/git-arc-layout.ts` | `NEUTRAL_GREY` const; feature `laneColor` + `arc.color` → grey; remove unused `branchColors`; `TipStack` type + `tipStacks` in `ArcLayoutResult`; `computeStackCardLayout` + `STACK_*` consts |
| `ui/src/components/workspace/git-arc-draw.ts` | `MERGE_COLOR` const; merge diamond → indigo; solid-trunk dashed guard; ring colour → status; centripetal `smoothSegments`/`sampleSmoothPath` + refactor `strokeSmoothPath`; `pointToSegmentDistance`; `clipPolylineLeft` + far-left stub in `drawArcLines`; `drawTaskCardAt` refactor; `drawTipStack`; `drawSyncBadge` |
| `ui/src/components/workspace/GitGraphCanvas.tsx` | `hitTestArc` point-to-segment; trunk-line hover; pass `viewportLeftInLayout`; stack draw + hit-test + click; sync-badge draw pass; `asDot` for stacked nodes |
| `ui/src/components/workspace/GitGraphLegend.tsx` | Rewrite to the final dictionary |
| `ui/src/__tests__/GitArcLayout.test.ts` | grey-colour assertions; `tipStacks` grouping; `computeStackCardLayout` |
| `ui/src/__tests__/GitArcDraw.test.ts` (**new**) | `pointToSegmentDistance`; `sampleSmoothPath` (no overshoot / monotonic-x); `clipPolylineLeft` |

`GitHoverCard.tsx`, `GitPipelineView.tsx`, `GitCommandCentre.tsx` and the server are **not** changed.

---

## Verification Commands (used by every task)

Run from the indicated working directory. `jq` is NOT installed — do not use it.

| Purpose | Command | CWD |
|---------|---------|-----|
| App typecheck | `npx tsc -b` | `ui/` |
| Run one test file | `npx vitest run src/__tests__/GitArcLayout.test.ts` (or `GitArcDraw.test.ts`) | `ui/` |
| Full UI test run | `npx vitest run` | `ui/` |
| Rebuild harness | `npx esbuild ui/dev-harness/arc-harness.ts --bundle --format=iife --outfile=ui/dev-harness/arc-harness.bundle.js` | repo root |
| Browser verify (harness) | open `http://localhost:4500/arc-harness.html` (mock server already running) | — |
| Browser verify (live app) | open `http://127.0.0.1:3100` → a project → Workspaces tab → Map (SeaMaster connected to Engineering) | — |

> **Note on `tsc -b`:** `ui/tsconfig.json` excludes `src/__tests__`, so `tsc -b` typechecks app code only. Test type/Runtime errors surface via `vitest run`. Both gates must be clean before a task is marked done.
>
> **Note on the harness bundle:** `ui/dev-harness/*.bundle.js` is a **gitignored build artifact** — the esbuild step regenerates it locally for browser verification, but it is never committed (`git add` of it will fail). Only the `.ts`/`.html` harness sources are tracked.

---

## Design Notes / Deliberate Choices (read before implementing)

1. **All commit dots are grey, including trunk dots.** The trunk *line* stays default-branch blue (drawn by `drawTrunk` from `graph.defaultBranch` colour, untouched). This matches `git-map-final.ts` exactly (grey dots on a blue line). If blue trunk dots are later preferred, it is a one-line change in `computeArcLayout`.
2. **Arc flow pulses (animated status-coloured dots travelling along running/in-review arcs) are preserved.** They are motion indicators from v1, not part of the 10 v2 decisions. Removing them is a trivial follow-up if desired.
3. **The `+N more` stack pill is display-only.** The full branch list is reachable via the Pipeline tab and the toolbar `+N more` chip; the in-canvas pill is informational.
4. **Badge/stub positions** (sync ↑/↓, far-left stub margin, stack fan offsets) carry concrete starting numbers but are expected to be fine-tuned against the screenshot at each batch checkpoint.
5. **Colour ownership:** `NEUTRAL_GREY` lives in `git-arc-layout.ts` (it is a structural/layout colour). `MERGE_COLOR` lives in `git-arc-draw.ts` (a drawing colour). Consumers import from the owner.

---
---

# Batch A — Colours, trunk, merge, legend

Outcome: lines/dots go neutral grey, status shows only on cards (with status-coloured rings), merges are indigo diamonds, the trunk history is solid, and the legend matches.

---

### Task A1: Neutral grey lines + dots; status-coloured card rings (Decision 1)

**Files:**
- Modify: `ui/src/components/workspace/git-arc-layout.ts` (lines 241, 288, 364-365)
- Modify: `ui/src/components/workspace/git-arc-draw.ts` (lines 136, 142 — ring colour)
- Test: `ui/src/__tests__/GitArcLayout.test.ts`

- [ ] **Step 1: Add the `NEUTRAL_GREY` constant** in `git-arc-layout.ts`, just below the `OPEN_ARC_STUB` export (after line 23):

```ts
/** Single neutral grey for ALL feature-branch lines and commit dots. Status
 * colour lives ONLY on task cards; the trunk LINE keeps the default-branch blue. */
export const NEUTRAL_GREY = "#7E8AA8";
```

- [ ] **Step 2: Force feature arc colour to grey.** In `computeArcLayout`, replace line 288:

```ts
// BEFORE
    const color = branchColors.get(fb.name) ?? "#7E8AA8";
// AFTER
    const color = NEUTRAL_GREY;
```

- [ ] **Step 3: Force every node's `laneColor` to grey.** Replace lines 364-365:

```ts
// BEFORE
    const colorBranchName = arcBranchName ?? graph.defaultBranch;
    const laneColor = branchColors.get(colorBranchName) ?? "#7E8AA8";
// AFTER
    // All commit dots render neutral grey. The trunk LINE colour is computed
    // separately in the component (drawTrunk) and stays the default-branch blue.
    const laneColor = NEUTRAL_GREY;
```

- [ ] **Step 4: Remove the now-unused `branchColors` map.** Delete line 241:

```ts
// DELETE
  const branchColors = new Map(graph.branches.map((b) => [b.name, b.color]));
```

(`branchInfoMap` on the next line stays — it is still used.)

- [ ] **Step 5: Status-colour the in-progress card rings** in `git-arc-draw.ts` `drawCommitNode` so rings stay green/amber/red after `laneColor` goes grey. Replace the two `node.laneColor` ring strokes (lines 136 and 142) with `borderColor` (already defined at line 126 as `statusDotColor(node.issueStatus, node.laneColor)`):

```ts
// BEFORE (line 136)
      ctx.strokeStyle = node.laneColor + Math.round(pulse * 0x33).toString(16).padStart(2, "0");
// AFTER
      ctx.strokeStyle = borderColor + Math.round(pulse * 0x33).toString(16).padStart(2, "0");
```

```ts
// BEFORE (line 142)
      ctx.strokeStyle = node.laneColor + Math.round(pulse * 0x66).toString(16).padStart(2, "0");
// AFTER
      ctx.strokeStyle = borderColor + Math.round(pulse * 0x66).toString(16).padStart(2, "0");
```

- [ ] **Step 6: Write the failing colour tests.** Append to the `describe("computeArcLayout", …)` block in `GitArcLayout.test.ts`:

```ts
  it("renders feature arcs in neutral grey, not the branch palette colour", () => {
    const graph = makeGraph();          // feat/x palette colour is #4FB67E
    const branches = makeBranches();
    const result = computeArcLayout(graph, branches);
    const arc = result.arcs.find((a) => a.branchName === "feat/x")!;
    expect(arc.color).toBe("#7E8AA8");
  });

  it("renders every commit dot (trunk and feature) in neutral grey", () => {
    const graph = makeGraph();
    const branches = makeBranches();
    const result = computeArcLayout(graph, branches);
    for (const n of result.nodes) {
      expect(n.laneColor).toBe("#7E8AA8");
    }
  });
```

- [ ] **Step 7: Run the tests — expect FAIL first, then PASS after Steps 2-3.**

Run (CWD `ui/`): `npx vitest run src/__tests__/GitArcLayout.test.ts`
Expected: the two new tests pass; all pre-existing tests still pass.

- [ ] **Step 8: Typecheck + rebuild harness + browser-verify.**

```bash
# CWD ui/
npx tsc -b
# CWD repo root
npx esbuild ui/dev-harness/arc-harness.ts --bundle --format=iife --outfile=ui/dev-harness/arc-harness.bundle.js
```
Open `http://localhost:4500/arc-harness.html`: all arc lines and commit dots are grey; in-progress task cards still show a green pulsing ring; trunk line stays blue.

- [ ] **Step 9: Commit.**

```bash
git add ui/src/components/workspace/git-arc-layout.ts ui/src/components/workspace/git-arc-draw.ts ui/src/__tests__/GitArcLayout.test.ts
git commit -m "feat(git-map): neutral grey lines + dots, status colour only on cards"
```

---

### Task A2: Merge commit = fixed indigo (Decision 2)

**Files:**
- Modify: `ui/src/components/workspace/git-arc-draw.ts` (constants block + `drawCommitNode` merge branch, lines 209-210)

- [ ] **Step 1: Add the `MERGE_COLOR` constant** below `CARD_H` (after line 89):

```ts
/** Merge commits render a fixed indigo diamond regardless of branch. */
export const MERGE_COLOR = "#6470DC";
```

- [ ] **Step 2: Use it for the merge diamond.** In `drawCommitNode`, replace lines 209-210:

```ts
// BEFORE
    ctx.fillStyle = node.laneColor + "80";
    ctx.strokeStyle = node.laneColor;
// AFTER
    ctx.fillStyle = MERGE_COLOR + "80";
    ctx.strokeStyle = MERGE_COLOR;
```

- [ ] **Step 3: Typecheck + rebuild harness + browser-verify.**

```bash
# CWD ui/
npx tsc -b
# CWD repo root
npx esbuild ui/dev-harness/arc-harness.ts --bundle --format=iife --outfile=ui/dev-harness/arc-harness.bundle.js
```
Open `http://localhost:4500/arc-harness.html`: every merge diamond is indigo `#6470DC`, matching `git-map-final.html`.

- [ ] **Step 4: Commit.**

```bash
git add ui/src/components/workspace/git-arc-draw.ts
git commit -m "feat(git-map): merge diamonds use fixed indigo"
```

---

### Task A3: Solid trunk history (Decision 3)

**Files:**
- Modify: `ui/src/components/workspace/git-arc-draw.ts` (`drawCommitNode` regular-circle branch, lines 219-231)

- [ ] **Step 1: Guard the dashed-circle cases with `!node.isTrunk`** so trunk nodes are always solid dots even when they are also a branch tip or remote ref. Replace the `if/else if` head of the regular-commit branch:

```ts
// BEFORE
    if (node.isBranchTip && !node.isTaskTip) {
      // Plain branch tip — slightly larger dashed circle
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.arc(node.x, node.y, COMMIT_R + 2, 0, Math.PI * 2);
    } else if (node.isRemoteOnly) {
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.arc(node.x, node.y, COMMIT_R, 0, Math.PI * 2);
    } else {
// AFTER
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
```

- [ ] **Step 2: Typecheck + rebuild harness + browser-verify.**

```bash
# CWD ui/
npx tsc -b
# CWD repo root
npx esbuild ui/dev-harness/arc-harness.ts --bundle --format=iife --outfile=ui/dev-harness/arc-harness.bundle.js
```
Open `http://localhost:4500/arc-harness.html`: the trunk shows only solid grey dots (and indigo merges) — no dashed circles mid-trunk. Off-trunk plain heads and remote-only tips remain dashed.

- [ ] **Step 3: Commit.**

```bash
git add ui/src/components/workspace/git-arc-draw.ts
git commit -m "feat(git-map): trunk history is always solid dots"
```

---

### Task A4: Legend rewrite to the final dictionary (Decision 10)

**Files:**
- Rewrite: `ui/src/components/workspace/GitGraphLegend.tsx`

- [ ] **Step 1: Replace the whole file** with the final dictionary. Removes the inaccurate "Trunk (white)" and "Branch arc (green)" rows; adds Branch (grey), Commit (grey dot), Branch head/no task (off-trunk dashed circle), Merge (indigo diamond), Open branch (right dashed stub), From older history (left dashed stub), and ahead/behind:

```tsx
import { useState } from "react";
import { STATUS_COLORS, MERGE_COLOR } from "./git-arc-draw";
import { NEUTRAL_GREY } from "./git-arc-layout";

/** Trunk LINE colour = default-branch blue. Same hex as MERGE_COLOR by default;
 * the legend distinguishes trunk vs merge by SHAPE (thick line vs diamond). */
const TRUNK_BLUE = "#6470DC";

/** Collapsible legend explaining the Map's glyphs and status colours.
 * Mirrors exactly what git-arc-draw renders (see ui/dev-harness/git-map-final.ts). */
export function GitGraphLegend() {
  // Default collapsed so the legend doesn't cover the graph on arrival.
  const [open, setOpen] = useState(false);

  const statusRows: Array<{ color: string; label: string }> = [
    { color: STATUS_COLORS.in_progress, label: "In progress" },
    { color: STATUS_COLORS.in_review, label: "In review" },
    { color: STATUS_COLORS.blocked, label: "Blocked" },
    { color: STATUS_COLORS.done, label: "Done / cancelled" },
  ];

  return (
    <div className="absolute top-3 left-3 z-10 select-none">
      <button
        className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#1e1d1c]/90 border border-[#2e2c2a] text-[11px] text-[#7E8AA8] hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-[10px]">{open ? "▾" : "▸"}</span> Legend
      </button>
      {open && (
        <div className="mt-1 p-2.5 rounded bg-[#141312]/95 border border-[#2e2c2a] text-[11px] text-[#ccc] space-y-2 w-52">
          {/* Structure */}
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-[#7E8AA8]">Graph</div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-5 h-[3px] rounded shrink-0" style={{ background: TRUNK_BLUE }} /> Trunk (main)
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-5 h-[2px] rounded shrink-0" style={{ background: NEUTRAL_GREY }} /> Branch
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: NEUTRAL_GREY }} /> Commit
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-full border border-dashed shrink-0" style={{ borderColor: NEUTRAL_GREY }} /> Branch head (no task)
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rotate-45 shrink-0" style={{ background: MERGE_COLOR }} /> Merge
            </div>
          </div>

          {/* Tasks */}
          <div className="space-y-1 pt-1 border-t border-[#2e2c2a]">
            <div className="text-[10px] uppercase tracking-wide text-[#7E8AA8]">Task (status colour)</div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-5 h-3 rounded-sm border shrink-0" style={{ borderColor: STATUS_COLORS.in_progress, background: "#0f0e0d" }} /> Task card
            </div>
            {statusRows.map((r) => (
              <div key={r.label} className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full inline-block shrink-0" style={{ background: r.color }} />
                {r.label}
              </div>
            ))}
          </div>

          {/* Stubs + sync */}
          <div className="space-y-1 pt-1 border-t border-[#2e2c2a]">
            <div className="text-[10px] uppercase tracking-wide text-[#7E8AA8]">Markers</div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-5 border-t border-dashed shrink-0" style={{ borderColor: NEUTRAL_GREY }} /> Open branch (more ahead)
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-5 border-t border-dashed shrink-0" style={{ borderColor: NEUTRAL_GREY }} /> From older history
            </div>
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-medium" style={{ color: STATUS_COLORS.in_progress }}>↑</span>
              <span className="shrink-0 font-medium" style={{ color: STATUS_COLORS.in_review }}>↓</span>
              ahead / behind remote
            </div>
          </div>

          {/* Badges */}
          <div className="space-y-1 pt-1 border-t border-[#2e2c2a]">
            <div className="text-[10px] uppercase tracking-wide text-[#7E8AA8]">Badges</div>
            <div className="flex items-center gap-2"><span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-[#4FB67E] text-[7px] text-white shrink-0">✓</span> CI passing</div>
            <div className="flex items-center gap-2"><span className="inline-flex items-center justify-center px-1 h-3.5 rounded bg-[#6470DC]/30 border border-[#6470DC] text-[7px] text-[#8490e8] shrink-0">PR</span> Pull request</div>
            <div className="flex items-center gap-2"><span className="text-[#ffa040] shrink-0">⚠</span> Conflicts</div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + browser-verify the live app.**

```bash
# CWD ui/
npx tsc -b
```
Open `http://127.0.0.1:3100` → project → Workspaces → Map → expand Legend. Confirm every row matches the rendered glyphs: trunk blue thick line, grey branch line, grey commit dot, grey dashed "branch head (no task)", indigo merge diamond, status swatches, both dashed stubs, ahead/behind arrows, badges. No "white trunk" or "green branch arc" rows remain.

- [ ] **Step 3: Commit.**

```bash
git add ui/src/components/workspace/GitGraphLegend.tsx
git commit -m "feat(git-map): rewrite legend to match the final glyph dictionary"
```

---

### ✅ Batch A checkpoint (PAUSE for screenshot review)

Rebuild harness, then capture both:
- `http://localhost:4500/arc-harness.html` (harness)
- `http://127.0.0.1:3100` live Map (SeaMaster)

Confirm against `git-map-final.html`: grey lines/dots, indigo merges, solid trunk, status-only-on-cards with coloured rings, accurate legend. **Get explicit approval before Batch B.**

---
---

# Batch B — Line hover + trunk hover + overshoot fix

Outcome: the whole branch line and the trunk line become hoverable, and the smooth curve no longer hooks/loops on sparse steep arcs.

---

### Task B1: Centripetal Catmull-Rom (Decision 6)

**Files:**
- Modify: `ui/src/components/workspace/git-arc-draw.ts` (`strokeSmoothPath`, add `smoothSegments` + `sampleSmoothPath`)
- Test: `ui/src/__tests__/GitArcDraw.test.ts` (**new file**)

- [ ] **Step 1: Create the new test file** `ui/src/__tests__/GitArcDraw.test.ts`. Per review decision D2→A, each task adds only its own function's tests so every task ends green. B1 imports + tests **only** `sampleSmoothPath` (B2 appends `pointToSegmentDistance`, D1 appends `clipPolylineLeft`):

```ts
import { describe, it, expect } from "vitest";
import { sampleSmoothPath } from "../components/workspace/git-arc-draw";

// ---------------------------------------------------------------------------
// sampleSmoothPath — centripetal Catmull-Rom must not hook or overshoot
// ---------------------------------------------------------------------------

describe("sampleSmoothPath (centripetal Catmull-Rom)", () => {
  it("keeps a sparse steep arc monotonic in x (no backward hook)", () => {
    // Asymmetric, steep, sparse — the config that makes uniform Catmull-Rom
    // bulge its control point backward (the grey 'hook').
    const pts: Array<[number, number]> = [
      [0, 200],
      [40, 80],
      [50, 90],
      [400, 200],
    ];
    const sampled = sampleSmoothPath(pts, 24);
    for (let i = 1; i < sampled.length; i++) {
      expect(sampled[i]![0]).toBeGreaterThanOrEqual(sampled[i - 1]![0] - 1);
    }
  });

  it("does not overshoot the points' vertical bounding box", () => {
    const pts: Array<[number, number]> = [
      [0, 200],
      [40, 80],
      [50, 90],
      [400, 200],
    ];
    const ys = pts.map((p) => p[1]);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    for (const [, y] of sampleSmoothPath(pts, 24)) {
      expect(y).toBeGreaterThanOrEqual(minY - 2);
      expect(y).toBeLessThanOrEqual(maxY + 2);
    }
  });

  it("passes through the endpoints", () => {
    const pts: Array<[number, number]> = [[0, 0], [50, 50], [100, 0]];
    const s = sampleSmoothPath(pts, 8);
    expect(s[0]).toEqual([0, 0]);
    expect(s[s.length - 1]).toEqual([100, 0]);
  });

  it("handles < 3 points without throwing", () => {
    expect(sampleSmoothPath([], 8)).toEqual([]);
    expect(sampleSmoothPath([[5, 5]], 8)).toEqual([[5, 5]]);
    const two = sampleSmoothPath([[0, 0], [10, 0]], 4);
    expect(two[0]).toEqual([0, 0]);
    expect(two[two.length - 1]).toEqual([10, 0]);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL** (functions not exported yet).

Run (CWD `ui/`): `npx vitest run src/__tests__/GitArcDraw.test.ts`
Expected: FAIL — `sampleSmoothPath` is not exported yet.

- [ ] **Step 3: Implement `smoothSegments` + `sampleSmoothPath`** in `git-arc-draw.ts`. Add directly above the existing `strokeSmoothPath` (line 21):

```ts
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
```

- [ ] **Step 4: Refactor `strokeSmoothPath`** to draw via `smoothSegments` (so the drawn curve and the sampled curve are identical). Replace the body's per-point loop (lines 33-44):

```ts
// BEFORE
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
  }
  ctx.stroke();
// AFTER
  for (const seg of smoothSegments(points)) {
    ctx.bezierCurveTo(seg.cp1[0], seg.cp1[1], seg.cp2[0], seg.cp2[1], seg.p2[0], seg.p2[1]);
  }
  ctx.stroke();
```

(Keep the existing `if (points.length < 2) return;`, `moveTo`, and `points.length === 2 → lineTo` guards above the loop exactly as-is.)

- [ ] **Step 5: Run the overshoot test — expect PASS.**

Run (CWD `ui/`): `npx vitest run src/__tests__/GitArcDraw.test.ts`
Expected: all tests in the file PASS. At this point the file contains only the `sampleSmoothPath` block (per D2→A); `pointToSegmentDistance` and `clipPolylineLeft` blocks are added by B2 and D1 alongside their implementations, so the suite stays green at every task boundary.

- [ ] **Step 6: Typecheck + rebuild harness + browser-verify.**

```bash
# CWD ui/
npx tsc -b
# CWD repo root
npx esbuild ui/dev-harness/arc-harness.ts --bundle --format=iife --outfile=ui/dev-harness/arc-harness.bundle.js
```
Open `http://localhost:4500/arc-harness.html`: arcs are smooth with no grey hooks/loops on sparse/steep branches.

- [ ] **Step 7: Commit.**

```bash
git add ui/src/components/workspace/git-arc-draw.ts ui/src/__tests__/GitArcDraw.test.ts
git commit -m "fix(git-map): centripetal Catmull-Rom removes arc overshoot hooks"
```

---

### Task B2: Arc line hover via point-to-segment (Decision 7)

**Files:**
- Modify: `ui/src/components/workspace/git-arc-draw.ts` (add `pointToSegmentDistance`)
- Modify: `ui/src/components/workspace/GitGraphCanvas.tsx` (`hitTestArc`, lines 100-122; import)
- Test: `ui/src/__tests__/GitArcDraw.test.ts`

- [ ] **Step 1: Add the failing `pointToSegmentDistance` tests** to `GitArcDraw.test.ts`. First extend the import at the top of the file (D2→A — B2 owns this function's tests):

```ts
import { sampleSmoothPath, pointToSegmentDistance } from "../components/workspace/git-arc-draw";
```

Then append this block:

```ts
describe("pointToSegmentDistance", () => {
  it("is 0 for a point on the segment", () => {
    expect(pointToSegmentDistance(5, 0, 0, 0, 10, 0)).toBeCloseTo(0, 6);
  });
  it("returns the perpendicular distance when the foot is interior", () => {
    expect(pointToSegmentDistance(5, 3, 0, 0, 10, 0)).toBeCloseTo(3, 6);
  });
  it("clamps to the nearest endpoint when the foot is outside", () => {
    // Left of A → distance to A.
    expect(pointToSegmentDistance(-4, 0, 0, 0, 10, 0)).toBeCloseTo(4, 6);
    // Right of B → distance to B.
    expect(pointToSegmentDistance(13, 4, 0, 0, 10, 0)).toBeCloseTo(5, 6);
  });
  it("handles a zero-length segment as distance to the point", () => {
    expect(pointToSegmentDistance(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 6);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`pointToSegmentDistance` not exported).

Run (CWD `ui/`): `npx vitest run src/__tests__/GitArcDraw.test.ts`

- [ ] **Step 3: Implement `pointToSegmentDistance`** in `git-arc-draw.ts`, in the path-helpers section (just below `polylinePointAt`, after line 81):

```ts
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
```

- [ ] **Step 4: Rewrite `hitTestArc`** in `GitGraphCanvas.tsx` to test true point-to-segment distance against consecutive `arc.points`. Replace the body (lines 107-121):

```ts
// BEFORE
  let best: ArcDefinition | null = null;
  let bestDist = threshold;
  for (const arc of arcs) {
    if (!visibleNames.has(arc.branchName)) continue;
    if (arc.isDone) continue;
    for (let i = 0; i <= 24; i++) {
      const [px, py] = polylinePointAt(arc.points, i / 24);
      const d = Math.hypot(cx - px, cy - py);
      if (d < bestDist) {
        bestDist = d;
        best = arc;
      }
    }
  }
  return best;
// AFTER
  let best: ArcDefinition | null = null;
  let bestDist = threshold;
  for (const arc of arcs) {
    if (!visibleNames.has(arc.branchName)) continue;
    if (arc.isDone) continue;
    const pts = arc.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = pointToSegmentDistance(cx, cy, pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1]);
      if (d < bestDist) {
        bestDist = d;
        best = arc;
      }
    }
  }
  return best;
```

- [ ] **Step 5: Update the import** in `GitGraphCanvas.tsx`. `polylinePointAt` is still used by `drawFlowPulse`’s module but no longer by `hitTestArc`; the component itself no longer references it directly. Change the import block (lines 29-44) to drop `polylinePointAt` and add `pointToSegmentDistance`:

```ts
// In the import from "./git-arc-draw": remove `polylinePointAt`, add `pointToSegmentDistance`.
import {
  COMMIT_R,
  CARD_W,
  CARD_H,
  drawCommitNode,
  drawCardLabel,
  drawCardBadges,
  drawTagPills,
  drawHeadLabel,
  drawTrunk,
  drawArcLines,
  drawArcLabels,
  drawLabelDots,
  drawFlowPulse,
  pointToSegmentDistance,
} from "./git-arc-draw";
```

> If `tsc -b` reports `polylinePointAt` as unused-imported, it confirms the removal was needed. If any other code in the component still uses it, keep it in the import.

- [ ] **Step 6: Typecheck + run tests + browser-verify.**

```bash
# CWD ui/
npx tsc -b
npx vitest run src/__tests__/GitArcDraw.test.ts
```
Open `http://127.0.0.1:3100` Map: hovering ANYWHERE along a branch line (not just near sampled points) shows that branch's tooltip and a pointer cursor.

- [ ] **Step 7: Commit.**

```bash
git add ui/src/components/workspace/git-arc-draw.ts ui/src/components/workspace/GitGraphCanvas.tsx ui/src/__tests__/GitArcDraw.test.ts
git commit -m "feat(git-map): whole branch line is hoverable via point-to-segment hit test"
```

---

### Task B3: Trunk line hover (Decision 8)

**Files:**
- Modify: `ui/src/components/workspace/GitGraphCanvas.tsx` (`handleMouseMove`, no-hit branch, lines 426-447; add a `trunkSpan` memo)

- [ ] **Step 1: Add a `trunkSpan` memo** in the component, just after the `layout` memo (after line 188):

```ts
    // Trunk x-range (layout space) for trunk-line hover.
    const trunkSpan = useMemo(() => {
      const xs = layout.nodes.filter((n) => n.isTrunk).map((n) => n.x);
      if (xs.length === 0) return null;
      return { minX: Math.min(...xs), maxX: Math.max(...xs) };
    }, [layout]);
```

- [ ] **Step 2: Insert a trunk-line test** in `handleMouseMove`'s no-node branch. Replace the no-hit block (lines 426-447):

```ts
// BEFORE
        if (!hit) {
          // No node — check if cursor is over a branch arc
          const arcHit = hitTestArc(layout.arcs, visibleNames, cx, cy);
          if (arcHit) {
            canvas.style.cursor = "pointer";
            const branch = branchByName.get(arcHit.branchName);
            if (branch) {
              onHover(
                branch.linkedIssueId
                  ? { type: "task", branch }
                  : { type: "plain_tip", branch },
                { x: e.clientX, y: e.clientY },
              );
            } else {
              onHover(null, { x: e.clientX, y: e.clientY });
            }
          } else {
            canvas.style.cursor = "grab";
            onHover(null, { x: e.clientX, y: e.clientY });
          }
          return;
        }
// AFTER
        if (!hit) {
          // No node — check if cursor is over a branch arc
          const arcHit = hitTestArc(layout.arcs, visibleNames, cx, cy);
          if (arcHit) {
            canvas.style.cursor = "pointer";
            const branch = branchByName.get(arcHit.branchName);
            if (branch) {
              onHover(
                branch.linkedIssueId
                  ? { type: "task", branch }
                  : { type: "plain_tip", branch },
                { x: e.clientX, y: e.clientY },
              );
            } else {
              onHover(null, { x: e.clientX, y: e.clientY });
            }
            return;
          }

          // No arc — check the trunk line (horizontal at layout.trunkY).
          if (
            trunkSpan &&
            Math.abs(cy - layout.trunkY) <= 8 &&
            cx >= trunkSpan.minX - 8 &&
            cx <= trunkSpan.maxX + 8
          ) {
            let nearest: ArcCommitLayout | null = null;
            let nd = Infinity;
            for (const n of layout.nodes) {
              if (!n.isTrunk) continue;
              const d = Math.abs(n.x - cx);
              if (d < nd) { nd = d; nearest = n; }
            }
            if (nearest) {
              const commit = graph.commits.find((c) => c.sha === nearest!.sha);
              if (commit) {
                canvas.style.cursor = "pointer";
                onHover({ type: "commit", commit }, { x: e.clientX, y: e.clientY });
                return;
              }
            }
          }

          canvas.style.cursor = "grab";
          onHover(null, { x: e.clientX, y: e.clientY });
          return;
        }
```

- [ ] **Step 3: Add `trunkSpan` and `graph.commits` to the `handleMouseMove` dependency array.** The current deps (line 491) are `[layout.nodes, layout.arcs, visibleNames, branchByName, taskBranchByTipSha, graph.commits, onHover]`. Add `trunkSpan` and `layout.trunkY`:

```ts
      [layout.nodes, layout.arcs, layout.trunkY, trunkSpan, visibleNames, branchByName, taskBranchByTipSha, graph.commits, onHover],
```

- [ ] **Step 4: Typecheck + browser-verify.**

```bash
# CWD ui/
npx tsc -b
```
Open `http://127.0.0.1:3100` Map: hovering directly on the trunk line (between dots) shows the nearest trunk commit's tooltip with a pointer cursor; hovering empty space still shows the grab cursor and no tooltip.

- [ ] **Step 5: Commit.**

```bash
git add ui/src/components/workspace/GitGraphCanvas.tsx
git commit -m "feat(git-map): trunk line is hoverable, shows nearest trunk commit"
```

---

### ✅ Batch B checkpoint (PAUSE for screenshot review)

Verify: no arc hooks; hovering anywhere on a branch line or on the trunk line shows the right tooltip. **Get approval before Batch C.**

---
---

# Batch C — Same-commit / zero-ahead stacking (Decision 4)

Outcome: multiple task branches sharing one tip commit render as up to 3 fanned cards with short connectors + a `+N more` pill, instead of collapsing into one card. The card-drawing is refactored into a reusable `drawTaskCardAt`.

---

### Task C1: `tipStacks` + `computeStackCardLayout` in layout (with tests)

**Files:**
- Modify: `ui/src/components/workspace/git-arc-layout.ts` (types, `ArcLayoutResult`, end of `computeArcLayout`, new consts + `computeStackCardLayout`)
- Test: `ui/src/__tests__/GitArcLayout.test.ts`

- [ ] **Step 1: Add the `TipStack` type and stack constants.** In `git-arc-layout.ts`, just below `NEUTRAL_GREY` (added in A1):

```ts
/** Horizontal/vertical geometry for fanned same-commit task cards. */
export const STACK_MAX_CARDS = 3;
export const STACK_DX = 64;       // cards sit this far right of the shared commit
export const STACK_DY = 40;       // vertical gap between fanned cards
export const STACK_BASE_DY = 34;  // first card's vertical offset above the commit

export interface TipStack {
  sha: string;
  x: number;
  y: number;
  /** Task branch names sharing this tip commit (length >= 2). */
  branchNames: string[];
}

export interface StackCardPos {
  branchName: string;
  x: number;
  y: number;
}

/** Positions of the (up to STACK_MAX_CARDS) cards fanned upward from a stack. */
export function computeStackCardLayout(stack: TipStack): StackCardPos[] {
  const shown = Math.min(stack.branchNames.length, STACK_MAX_CARDS);
  const out: StackCardPos[] = [];
  for (let i = 0; i < shown; i++) {
    out.push({
      branchName: stack.branchNames[i]!,
      x: stack.x + STACK_DX,
      y: stack.y - STACK_BASE_DY - i * STACK_DY,
    });
  }
  return out;
}
```

- [ ] **Step 2: Add `tipStacks` to `ArcLayoutResult`.** Update the interface (lines 79-85):

```ts
export interface ArcLayoutResult {
  nodes: ArcCommitLayout[];
  arcs: ArcDefinition[];
  trunkY: number;
  totalWidth: number;
  totalHeight: number;
  /** Groups of >=2 TASK branches sharing a tip commit (rendered as fanned cards). */
  tipStacks: TipStack[];
}
```

- [ ] **Step 3: Compute `tipStacks` at the end of `computeArcLayout`.** Insert just before the `return` (before line 391's `totalWidth`):

```ts
  // ── Same-commit task stacks ───────────────────────────────────────────────
  // Group TASK branches (linkedIssueId) by their tip commit. Two or more on the
  // same commit (e.g. several tasks at HEAD with 0 commits ahead) would collapse
  // into one card; expose them so the component can fan them out instead.
  const nodeBySha = new Map(nodes.map((n) => [n.sha, n]));
  const tasksByTipSha = new Map<string, string[]>();
  for (const b of branches) {
    if (!b.linkedIssueId) continue;
    const list = tasksByTipSha.get(b.lastCommitSha) ?? [];
    list.push(b.name);
    tasksByTipSha.set(b.lastCommitSha, list);
  }
  const tipStacks: TipStack[] = [];
  for (const [sha, branchNames] of tasksByTipSha) {
    if (branchNames.length < 2) continue;
    const node = nodeBySha.get(sha);
    if (!node) continue;
    tipStacks.push({ sha, x: node.x, y: node.y, branchNames });
  }
```

- [ ] **Step 4: Return `tipStacks`.** Update the return (line 395):

```ts
  return { nodes, arcs, trunkY: TRUNK_Y, totalWidth, totalHeight, tipStacks };
```

- [ ] **Step 5: Write the failing tests.** Add a new `describe` block to `GitArcLayout.test.ts` (after the `computeArcLayout` block):

```ts
describe("computeArcLayout tipStacks", () => {
  function taskBranch(
    name: string,
    sha: string,
    issueId: string | null,
    identifier: string | null = null,
  ): GitBranchInfo {
    return {
      name, lastCommitSha: sha,
      isLocal: true, isRemote: true, aheadCount: 0, behindCount: 0,
      lastCommitMessage: "", lastCommitAt: "2024-01-01T00:00:00Z", lastCommitAuthor: "t",
      linkedWorkspaceId: null, linkedIssueId: issueId,
      linkedIssueIdentifier: identifier, linkedIssueTitle: null,
      linkedIssueStatus: null, linkedIssueWorkMode: null,
      pr: null, overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: [],
    };
  }

  const graph: GitGraphData = {
    defaultBranch: "main",
    commits: [mkCommit("c2", ["c1"]), mkCommit("c1", [])],
    branches: [
      { name: "main",   laneIndex: 0, color: "#6470DC", tipSha: "c2" },
      { name: "feat/a", laneIndex: 1, color: "#4FB67E", tipSha: "c2" },
      { name: "feat/b", laneIndex: 2, color: "#D9A938", tipSha: "c2" },
    ],
  };

  it("groups multiple task branches sharing a tip commit", () => {
    const branches = [
      taskBranch("main", "c2", null),
      taskBranch("feat/a", "c2", "i1", "AOA-1"),
      taskBranch("feat/b", "c2", "i2", "AOA-2"),
    ];
    const result = computeArcLayout(graph, branches);
    expect(result.tipStacks).toHaveLength(1);
    expect(result.tipStacks[0]!.sha).toBe("c2");
    expect([...result.tipStacks[0]!.branchNames].sort()).toEqual(["feat/a", "feat/b"]);
  });

  it("does not create a stack for a single task branch at a commit", () => {
    const branches = [
      taskBranch("main", "c2", null),
      taskBranch("feat/a", "c2", "i1", "AOA-1"),
    ];
    expect(computeArcLayout(graph, branches).tipStacks).toHaveLength(0);
  });
});

describe("computeStackCardLayout", () => {
  it("fans up to STACK_MAX_CARDS cards upward and to the right", () => {
    const stack = { sha: "x", x: 100, y: 200, branchNames: ["a", "b", "c", "d", "e"] };
    const cards = computeStackCardLayout(stack);
    expect(cards).toHaveLength(STACK_MAX_CARDS);
    expect(cards[0]!.x).toBe(100 + STACK_DX);
    expect(cards[0]!.y).toBeLessThan(200);          // above the commit
    expect(cards[1]!.y).toBeLessThan(cards[0]!.y);  // each higher than the last
  });
});
```

Add the imports at the top of the test file:

```ts
// add to the existing import from "../components/workspace/git-arc-layout":
  computeStackCardLayout,
  STACK_MAX_CARDS,
  STACK_DX,
```

- [ ] **Step 6: Run — expect FAIL first, then PASS.**

Run (CWD `ui/`): `npx vitest run src/__tests__/GitArcLayout.test.ts`
Then confirm the existing `getLayoutBounds`/empty-layout test still passes (it does — `tipStacks` defaults to `[]` for an empty graph).

- [ ] **Step 7: Typecheck + commit.**

```bash
# CWD ui/
npx tsc -b
git add ui/src/components/workspace/git-arc-layout.ts ui/src/__tests__/GitArcLayout.test.ts
git commit -m "feat(git-map): detect same-commit task stacks in layout (tipStacks)"
```

---

### Task C2: `drawTaskCardAt` refactor + `drawTipStack`

**Files:**
- Modify: `ui/src/components/workspace/git-arc-draw.ts` (extract card block; add `drawTipStack`; import `computeStackCardLayout`)

- [ ] **Step 1: Add the value import** from layout in `git-arc-draw.ts`. Below the existing `import type { ArcCommitLayout, ArcDefinition } from "./git-arc-layout";` (line 10):

```ts
import {
  NEUTRAL_GREY,
  computeStackCardLayout,
  type TipStack,
} from "./git-arc-layout";
```

- [ ] **Step 2: Add `drawTaskCardAt`** — the card visual (rings + bg + border + dot + micro-lines) parameterized by position + style. Insert just above `drawCommitNode` (before line 109):

```ts
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

  ctx.beginPath();
  ctx.arc(cardX + 10, y, 3, 0, Math.PI * 2);
  ctx.fillStyle = statusDotColor(issueStatus, laneColor);
  ctx.fill();

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
```

- [ ] **Step 3: Make `drawCommitNode` delegate to `drawTaskCardAt`** and accept an `asDot` flag (so a stacked node draws as a plain dot, not a card). Replace the signature + the `if (node.isTaskTip) { … }` block (lines 109-197) with:

```ts
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
```

Keep the existing merge branch and regular-circle branch exactly as they are after A2/A3 (the merge `MERGE_COLOR` and the `!node.isTrunk` dashed guards), but note the chain now reads `if (node.isMerge) { … } else { … }` (the task-tip case already returned above). Verify the final `else` still closes the function correctly.

> When `asDot` is true for a task-tip node, it falls through to the `else` regular-circle branch. Because that node has `isTaskTip === true`, the `!node.isTrunk && node.isBranchTip && !node.isTaskTip` dashed condition is false → it draws a **solid** dot, which is exactly what a stack base should be.

- [ ] **Step 4: Add `drawTipStack`** at the end of `git-arc-draw.ts`:

```ts
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

  // "+N more" pill (display-only — full list is in the Pipeline tab).
  const extra = stack.branchNames.length - cards.length;
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
```

- [ ] **Step 5: Typecheck + run the full UI test suite** (the refactor must not regress existing layout tests; drawing functions have no direct unit tests but `tsc` + the harness cover them).

```bash
# CWD ui/
npx tsc -b
npx vitest run
```
Expected: all tests pass (no behavioural change yet — `drawTipStack` is not wired in until C3).

- [ ] **Step 6: Commit.**

```bash
git add ui/src/components/workspace/git-arc-draw.ts
git commit -m "refactor(git-map): extract drawTaskCardAt; add drawTipStack for same-commit stacks"
```

---

### Task C3: Wire stacks into redraw + hit-test + click

**Files:**
- Modify: `ui/src/components/workspace/GitGraphCanvas.tsx` (import; `stackedShas` memo; `redraw`; `hitTest` for stacks; `handleMouseMove`; `handleClick`)

- [ ] **Step 1: Import the stack helpers + types** in `GitGraphCanvas.tsx`. Add `drawTipStack` to the `git-arc-draw` import, and `computeStackCardLayout` + `type TipStack` + `CARD_W` usage already present. Update the layout import (lines 23-28):

```ts
import {
  computeArcLayout,
  computeHeadFocusTransform,
  computeStackCardLayout,
  type ArcCommitLayout,
  type ArcDefinition,
  type TipStack,
} from "./git-arc-layout";
```

And add `drawTipStack` to the `git-arc-draw` import list (alongside `drawCommitNode` etc.).

- [ ] **Step 2: Add the filtered-stack memos** after the `layout` memo (and after `trunkSpan` from B3). Per review decision D1→A, stacks must respect the active filter, and a stack's degenerate arcs must be suppressed. A stack that filters down to <2 visible branches is NOT a stack — its node renders the normal single-card path.

```ts
    // Stacks restricted to currently-visible branches. A stack needs >=2 visible
    // members to fan; otherwise it falls back to the normal single-card node path.
    const visibleStacks = useMemo(
      () =>
        layout.tipStacks
          .map((s) => ({ ...s, branchNames: s.branchNames.filter((n) => visibleNames.has(n)) }))
          .filter((s) => s.branchNames.length >= 2),
      [layout.tipStacks, visibleNames],
    );
    // SHAs drawn as a fan (their node becomes a plain dot, not a card).
    const stackedShas = useMemo(
      () => new Set(visibleStacks.map((s) => s.sha)),
      [visibleStacks],
    );
    // Branch names whose (degenerate) arc + arc-label must be suppressed because
    // the branch is represented by a fanned card instead.
    const stackedBranchNames = useMemo(
      () => new Set(visibleStacks.flatMap((s) => s.branchNames)),
      [visibleStacks],
    );
    // visibleNames minus stacked branches — used only for arc lines + arc labels
    // so stacked branches don't also draw overlapping stub-arcs at the shared commit.
    const arcVisibleNames = useMemo(() => {
      const s = new Set(visibleNames);
      for (const n of stackedBranchNames) s.delete(n);
      return s;
    }, [visibleNames, stackedBranchNames]);
```

- [ ] **Step 3: In `redraw`, pass `asDot` for stacked nodes and skip their single card/labels.** Update the node loop (lines 269-286). The key changes: `drawCommitNode(..., stackedShas.has(node.sha))`, and guard the label/badge block with `&& !stackedShas.has(node.sha)`:

```ts
      const cardBranchNames = new Set<string>();
      for (const node of visibleNodes) {
        const branchStatus =
          node.branchName != null
            ? (branchByName.get(node.branchName)?.linkedIssueStatus ?? null)
            : null;
        const isStacked = stackedShas.has(node.sha);
        drawCommitNode(ctx, node, animPhaseRef.current, branchStatus, isStacked);

        if (node.isTaskTip && !isStacked) {
          let branch = node.branchName ? branchByName.get(node.branchName) : undefined;
          if (!branch?.linkedIssueId) branch = taskBranchByTipSha.get(node.sha);
          if (branch?.linkedIssueId) {
            drawCardLabel(ctx, node, branch);
            drawCardBadges(ctx, node, branch);
            drawLabelDots(ctx, node, branch);
            if (node.arcBranchName) cardBranchNames.add(node.arcBranchName);
          }
        }
      }
```

- [ ] **Step 4a: Suppress stacked branches' arcs + arc-labels** (D1→A). In `redraw`, the arc-line and arc-label passes must use `arcVisibleNames` (visible minus stacked) so a stacked branch doesn't draw an overlapping stub-arc at the shared commit. Change the two calls:

```ts
// redraw step 2 — was: drawArcLines(ctx, layout.arcs, visibleNames);
//   (Batch C signature is still 3-arg; D1 later adds the viewportLeftInLayout arg)
      drawArcLines(ctx, layout.arcs, arcVisibleNames);

// redraw step 7 — was: drawArcLabels(ctx, layout.arcs, visibleNames, cardBranchNames);
      drawArcLabels(ctx, layout.arcs, arcVisibleNames, cardBranchNames);
```

> Node visibility (`visibleNodes`), the flow pulse, and HEAD label keep using the full `visibleNames` — only the arc LINE + arc LABEL passes use `arcVisibleNames`. The shared commit's dot still draws (it's a visible node); only its branches' redundant stub-arcs are removed.
> **D1 dependency:** Task D1 (far-left stub) adds a 4th `viewportLeftInLayout` arg to `drawArcLines`. When D1 updates this call, it must keep `arcVisibleNames` as the 3rd arg → `drawArcLines(ctx, layout.arcs, arcVisibleNames, viewportLeftInLayout)`.

- [ ] **Step 4b: Draw the stacks** after the node loop. Add immediately after the node loop closes (before the tag-pills loop at line 288). Iterate `visibleStacks` (filtered), not `layout.tipStacks`:

```ts
      // 4c. Same-commit task stacks (fanned cards + connectors + "+N more").
      // visibleStacks is already filtered to the active filter + >=2 members.
      for (const stack of visibleStacks) {
        drawTipStack(ctx, stack, branchByName, animPhaseRef.current);
      }
```

- [ ] **Step 5: Update the `redraw` dependency array** (line 302) to include the new memos it now reads:

```ts
    }, [layout, visibleNames, arcVisibleNames, visibleStacks, stackedShas, branchByName, taskBranchByTipSha, graph.defaultBranch, graph.branches]);
```

- [ ] **Step 6: Add a stack hit-test helper** above the component (next to `hitTestArc`, after line 122). It returns the task branch under a fanned card:

```ts
function hitTestStacks(
  tipStacks: TipStack[],
  branchByName: Map<string, GitBranchInfo>,
  cx: number,
  cy: number,
): GitBranchInfo | null {
  for (const stack of tipStacks) {
    for (const c of computeStackCardLayout(stack)) {
      if (
        cx >= c.x - CARD_W / 2 - 4 &&
        cx <= c.x + CARD_W / 2 + 4 &&
        cy >= c.y - CARD_H / 2 - 4 &&
        cy <= c.y + CARD_H / 2 + 4
      ) {
        const b = branchByName.get(c.branchName);
        if (b) return b;
      }
    }
  }
  return null;
}
```

- [ ] **Step 7: Check stacks first in `handleMouseMove`.** Immediately after computing `cx`/`cy` and before `const hit = hitTest(...)` (line 424), insert:

```ts
        // Fanned same-commit stack cards take priority over the underlying node.
        const stackBranch = hitTestStacks(visibleStacks, branchByName, cx, cy);
        if (stackBranch) {
          canvas.style.cursor = "pointer";
          onHover(
            stackBranch.linkedIssueId
              ? { type: "task", branch: stackBranch }
              : { type: "plain_tip", branch: stackBranch },
            { x: e.clientX, y: e.clientY },
          );
          return;
        }
```

Add `visibleStacks` to the `handleMouseMove` dependency array.

- [ ] **Step 8: Check stacks first in `handleClick`.** After computing `cx`/`cy` and before `const hit = hitTest(...)` (line 511), insert:

```ts
        const stackBranch = hitTestStacks(visibleStacks, branchByName, cx, cy);
        if (stackBranch?.linkedIssueId) {
          onClick({ type: "task", branch: stackBranch });
          return;
        }
```

Add `visibleStacks` to the `handleClick` dependency array.

- [ ] **Step 9: Typecheck + browser-verify with a real stack.**

```bash
# CWD ui/
npx tsc -b
```
On `http://127.0.0.1:3100`, create 2-3 tasks in a `software_development` project whose branches all sit at the same commit (e.g. fresh task branches with 0 commits). Confirm the Map fans up to 3 cards with dashed connectors from the shared commit, a `+N more` pill appears for >3, hovering a fanned card shows its task tooltip, and clicking opens that task. Also confirm the harness still renders (no stack data there, so unchanged):

```bash
# CWD repo root
npx esbuild ui/dev-harness/arc-harness.ts --bundle --format=iife --outfile=ui/dev-harness/arc-harness.bundle.js
```

- [ ] **Step 10: Commit.**

```bash
git add ui/src/components/workspace/GitGraphCanvas.tsx
git commit -m "feat(git-map): fan same-commit task branches into a stacked card group"
```

---

### ✅ Batch C checkpoint (PAUSE for screenshot review)

Verify fanned stacks, connectors, `+N more`, hover + click on stacked cards. **Get approval before Batch D.**

---
---

# Batch D — Far-left history stub + sync markers

Outcome: branches that fork from off-screen-left history show a dashed "from older history" entry stub instead of a long arc back off-screen; branch tips show ↑N / ↓N sync markers.

---

### Task D1: Far-left fork dashed stub (Decision 5)

**Files:**
- Modify: `ui/src/components/workspace/git-arc-draw.ts` (`clipPolylineLeft`; rewrite `drawArcLines`)
- Modify: `ui/src/components/workspace/GitGraphCanvas.tsx` (compute + pass `viewportLeftInLayout`)
- Test: `ui/src/__tests__/GitArcDraw.test.ts`

- [ ] **Step 1: Add the failing `clipPolylineLeft` tests** to `GitArcDraw.test.ts`. First extend the import at the top of the file (D2→A — D1 owns this function's tests):

```ts
import {
  sampleSmoothPath,
  pointToSegmentDistance,
  clipPolylineLeft,
} from "../components/workspace/git-arc-draw";
```

Then append this block:

```ts
describe("clipPolylineLeft", () => {
  const path: Array<[number, number]> = [[0, 200], [60, 140], [120, 200]];

  it("inserts an interpolated entry point at x = left and drops off-screen head", () => {
    const clipped = clipPolylineLeft(path, 30)!;
    expect(clipped[0]![0]).toBe(30);
    // Interpolated y between (0,200) and (60,140): t=0.5 → y=170.
    expect(clipped[0]![1]).toBeCloseTo(170, 6);
    expect(clipped[clipped.length - 1]).toEqual([120, 200]);
  });

  it("returns null when fewer than 2 points remain visible", () => {
    expect(clipPolylineLeft(path, 200)).toBeNull();
  });

  it("returns the path unchanged-ish when nothing is left of `left`", () => {
    const clipped = clipPolylineLeft(path, -10)!;
    expect(clipped).toHaveLength(3);
    expect(clipped[0]).toEqual([0, 200]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`clipPolylineLeft` not exported).

Run (CWD `ui/`): `npx vitest run src/__tests__/GitArcDraw.test.ts`

- [ ] **Step 3: Implement `clipPolylineLeft`** in `git-arc-draw.ts`, in the path-helpers section (below `pointToSegmentDistance`):

```ts
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
```

- [ ] **Step 4: Rewrite `drawArcLines`** to accept `viewportLeftInLayout` and draw a dashed left entry stub for far-left forks. Replace the whole function (lines 418-449):

```ts
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
```

> The dashed left stub carries no per-arc text label (multiple far-left forks would clutter). The legend's "From older history" row explains the glyph.

- [ ] **Step 5: Compute + pass `viewportLeftInLayout` in `redraw`.** In `GitGraphCanvas.tsx` `redraw`, after `const t = transformRef.current;` and `const dpr = …` (lines 227-228), add:

```ts
      // Left viewport edge in layout space (+ a small inset so the stub is visible).
      const viewportLeftInLayout = (0 - t.x) / t.k + 24;
```

Then update the `drawArcLines` call (line 248). Keep `arcVisibleNames` as the 3rd arg (from Batch C, D1→A) and add `viewportLeftInLayout` as the 4th:

```ts
      drawArcLines(ctx, layout.arcs, arcVisibleNames, viewportLeftInLayout);
```

- [ ] **Step 6: Typecheck + run tests + rebuild harness + browser-verify.**

```bash
# CWD ui/
npx tsc -b
npx vitest run src/__tests__/GitArcDraw.test.ts
# CWD repo root
npx esbuild ui/dev-harness/arc-harness.ts --bundle --format=iife --outfile=ui/dev-harness/arc-harness.bundle.js
```
On `http://127.0.0.1:3100` Map: pan right so a branch's fork point goes off the left edge → its arc starts with a short dashed stub near the left edge (not a long line back off-screen). Normal arcs (fork point on-screen) are unchanged. Open-branch right stubs still render.

- [ ] **Step 7: Commit.**

```bash
git add ui/src/components/workspace/git-arc-draw.ts ui/src/components/workspace/GitGraphCanvas.tsx ui/src/__tests__/GitArcDraw.test.ts
git commit -m "feat(git-map): dashed 'from older history' stub for far-left forks"
```

---

### Task D2: Sync markers ↑N / ↓N (Decision 9)

**Files:**
- Modify: `ui/src/components/workspace/git-arc-draw.ts` (add `drawSyncBadge`)
- Modify: `ui/src/components/workspace/GitGraphCanvas.tsx` (call it in `redraw`)

- [ ] **Step 1: Add `drawSyncBadge`** at the end of `git-arc-draw.ts`:

```ts
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
```

- [ ] **Step 2: Add `drawSyncBadge` to the `git-arc-draw` import** in `GitGraphCanvas.tsx`.

- [ ] **Step 3: Call it in `redraw`** for non-stacked branch tips. Add inside the node loop, right after `drawCommitNode(...)` and before the `if (node.isTaskTip && !isStacked)` block:

```ts
        if (node.isBranchTip && !isStacked) {
          let syncBranch = node.branchName ? branchByName.get(node.branchName) : undefined;
          if (!syncBranch) syncBranch = taskBranchByTipSha.get(node.sha);
          if (syncBranch) drawSyncBadge(ctx, node, syncBranch);
        }
```

- [ ] **Step 4: Typecheck + rebuild harness + browser-verify.**

```bash
# CWD ui/
npx tsc -b
# CWD repo root
npx esbuild ui/dev-harness/arc-harness.ts --bundle --format=iife --outfile=ui/dev-harness/arc-harness.bundle.js
```
On `http://127.0.0.1:3100` Map (SeaMaster, where branches have real ahead/behind): branch tips with un-pushed commits show a green ↑N; tips behind remote show an amber ↓N; in-sync tips show nothing. Confirm no collision with HEAD on the default tip. Tune `STACK_*`-style offsets only if visibly off.

- [ ] **Step 5: Commit.**

```bash
git add ui/src/components/workspace/git-arc-draw.ts ui/src/components/workspace/GitGraphCanvas.tsx
git commit -m "feat(git-map): ahead/behind sync markers on branch tips"
```

---

### ✅ Batch D checkpoint (PAUSE for screenshot review)

Verify far-left stubs + sync markers against `git-map-final.html`. **Get approval before final review.**

---
---

## Final Verification Checklist

After all four batches:

- [ ] Branch arcs and ALL commit dots are neutral grey `#7E8AA8`; trunk line stays default-branch blue
- [ ] Task cards carry the only status colour (border/dot/ring): green/amber/red/grey
- [ ] Merge commits are indigo `#6470DC` diamonds
- [ ] Trunk history shows solid dots only (no mid-trunk dashed circles), even at branch-tip/remote trunk commits
- [ ] Multiple task branches on one commit fan into ≤3 cards with connectors + `+N more`; hover + click work on fanned cards
- [ ] Far-left forks show a dashed "from older history" entry stub (not a long off-screen arc)
- [ ] Branch tips show ↑N (green) / ↓N (amber) sync markers from ahead/behind counts
- [ ] Hovering anywhere on a branch line shows its tooltip; hovering the trunk line shows the nearest trunk commit
- [ ] No grey hooks/loops on sparse/steep arcs (centripetal smoothing)
- [ ] Legend matches the rendered glyphs exactly; no "white trunk" / "green branch arc" rows
- [ ] `cd ui && npx tsc -b` clean
- [ ] `cd ui && npx vitest run` all pass (incl. new `GitArcDraw.test.ts` + extended `GitArcLayout.test.ts`)
- [ ] Harness (`arc-harness.html`) and live Map match `git-map-final.html`

Then dispatch a final code review over the whole branch and proceed to `superpowers:finishing-a-development-branch`.

---

## Execution Order

Strictly in order; each task is its own verifiable unit. Do not batch multiple tasks into one edit-run.

```
A1 → A2 → A3 → A4 → [screenshot] →
B1 → B2 → B3 → [screenshot] →
C1 → C2 → C3 → [screenshot] →
D1 → D2 → [screenshot] → final review
```

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh implementer per task with two-stage review (spec compliance, then code quality), pausing for a screenshot at each batch boundary.
2. **Inline Execution** — execute tasks in this session via `superpowers:executing-plans`, with the same batch checkpoints.

---

## GSTACK REVIEW REPORT

Reviewed by `/plan-eng-review` on 2026-05-24 (branch `feat/git-command-centre`, commit `48d4a44d`).

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (UI polish, not a product/scope change) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 2 issues found + folded in, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (design locked via signed-off mock) |
| Outside Voice | `/codex` | Independent 2nd opinion | 0 | skipped | user skipped (tightly-scoped polish) |

**Findings (both resolved into the plan):**
- **D1 (Architecture, P2):** Batch C stack rendering bypassed the active filter and left overlapping degenerate arcs at the shared commit. Fix (option A) folded into Task C3: `visibleStacks` (filtered to the active filter, ≥2 visible members), `stackedShas` derived from it, and `arcVisibleNames` so stacked branches' stub-arcs + labels are suppressed.
- **D2 (Tests, P1):** `GitArcDraw.test.ts` imported all three pure helpers up front but they ship across B1/B2/D1, leaving the suite red between tasks. Fix (option A) folded into B1/B2/D1: each task adds only its own function's import + describe block, so every task ends green.

**Scope:** accepted as-is (6 files, 0 new classes — no complexity trigger). **Distribution:** N/A (UI change). **Parallelization:** sequential (shared files). **Outside voice:** skipped.

- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED — ready to implement. 0 critical gaps. Recommended next step: build via `superpowers:subagent-driven-development` with a screenshot checkpoint after each batch.
