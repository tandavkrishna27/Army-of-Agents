# Git Command Centre Map — Hit-Region Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Map's three ad-hoc hit-test functions with one **hit-region registry** so every drawn glyph (cards, id/title labels, CI/PR/conflict badges, ↑/↓ sync markers, tag pills, the "+N more" pill, branch arcs incl. done/cancelled, the trunk line, nodes) reacts to hover with the correct tooltip — and the "+N more" pill becomes **clickable → Pipeline tab**.

**Architecture:** A new pure module `git-arc-hit.ts` builds an ordered list of `HitRegion`s (rect or polyline + a `HitTarget`) that mirrors exactly what `redraw()` draws, derived from the same layout + filter memos and shared via a single pure `resolveNodeRender()` helper. The component memoizes the regions (NOT per animation frame) and `handleMouseMove`/`handleClick` walk them topmost-first; a `resolveTarget()` maps a `HitTarget` to a `HoveredNode` or the show-more action. The legacy `hitTest`/`hitTestArc`/`hitTestStacks` are retired.

**Tech Stack:** React 19 + Vite + D3 + Canvas 2D, TypeScript (strict), Vitest 3 + jsdom, esbuild (harness).

---

## Why a registry (vs per-glyph hit functions)

Hit-testing currently recomputes glyph positions independently of the draw code, so only 4 of ~12 glyph types are covered and the two can silently drift (e.g. `hitTest` already uses a card rect for a node now drawn as a dot). One registry, built from the same inputs as the draw pass, makes "hovering anything reacts" a property of the system: add a glyph → add one region next to where you draw it.

---

## Files

| File | Change |
|------|--------|
| `ui/src/components/workspace/git-arc-hit.ts` | **New.** `HitTarget`, `HitRegion`, `NodeRender`, `resolveNodeRender`, `buildHitRegions`, `hitRegionAt`. Pure (no DOM/React). |
| `ui/src/components/workspace/git-arc-draw.ts` | **No change.** Its geometry constants (`CARD_W`/`CARD_H`/`COMMIT_R`) and `pointToSegmentDistance` are already exported and are consumed by `git-arc-hit.ts`. |
| `ui/src/components/workspace/GitGraphCanvas.tsx` | Add `regions` memo; rewrite `redraw` node loop to call `resolveNodeRender`; rewrite `handleMouseMove`/`handleClick` to use `hitRegionAt` + `resolveTarget`; delete `hitTest`/`hitTestArc`/`hitTestStacks`; add `onShowMore` prop. |
| `ui/src/components/workspace/GitCommandCentre.tsx` | Pass `onShowMore={() => setViewMode("pipeline")}` to `<GitGraphCanvas>`. |
| `ui/src/__tests__/GitArcHit.test.ts` | **New.** Unit tests for `resolveNodeRender`, `buildHitRegions`, `hitRegionAt`. |

`GitHoverCard.tsx` (the `HoveredNode` union) is **not** changed — every target resolves to an existing type (`task` / `plain_tip` / `commit` / `merge` / `tag`).

---

## Verification commands (every task)

| Purpose | Command | CWD |
|---|---|---|
| App typecheck | `npx tsc -b` | `ui/` |
| One test file | `npx vitest run src/__tests__/GitArcHit.test.ts` | `ui/` |
| Full UI suite | `npx vitest run` | `ui/` |
| Rebuild harness | `npx esbuild ui/dev-harness/arc-harness.ts --bundle --format=iife --outfile=ui/dev-harness/arc-harness.bundle.js` | repo root |
| Live cursor probe | see snippet in Task D1 | — |

`jq` is NOT installed. The harness `*.bundle.js` is gitignored — never `git add` it.

---

## Geometry reference (current draw positions, for the region boxes)

From `git-arc-draw.ts`: `CARD_W=28`, `CARD_H=18`, `COMMIT_R=5`.
- **Card** centred at `(node.x, node.y)`, box `CARD_W×CARD_H`.
- **Card label** (`drawCardLabel`): id at `(node.x-CARD_W/2, node.y+CARD_H/2+9)`, title at `+19` → extends ~24px **below** the card.
- **Card badges** (`drawCardBadges`): CI/PR/conflict at `node.x+CARD_W/2 + 4..8` → ~26px **right** of the card.
- **Sync marker** (`drawSyncBadge`): centred at `node.x`, `y = node.y − (isTaskTip?CARD_H/2:COMMIT_R) − (isDefault?22:8)` → **above** the node; only when `aheadCount>0 || behindCount>0`.
- **Tag pills** (`drawTagPills`): from `node.x+COMMIT_R+4` rightward (≤2 pills).
- **Stack card** (`computeStackCardLayout`, `STACK_DX=64`): card at `(stack.x+64, stack.y−34−i*40)`; id label at `(c.x+CARD_W/2+6, c.y)` → ~36px **right**.
- **"+N more" pill**: rect `(stack.x+50, stack.y+8, 54, 15)`.
- **Trunk line**: horizontal at `trunkY` from `min` to `max` trunk node x.

---
---

# Batch A — Region model + pure builder + tests

### Task A1: Create the hit-region model + `resolveNodeRender` + `hitRegionAt`

**Files:**
- Create: `ui/src/components/workspace/git-arc-hit.ts`
- Test: `ui/src/__tests__/GitArcHit.test.ts`

- [ ] **Step 1: Write the failing test** — create `ui/src/__tests__/GitArcHit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { GitBranchInfo } from "@armyofagents/shared";
import {
  resolveNodeRender,
  hitRegionAt,
  type HitRegion,
} from "../components/workspace/git-arc-hit";
import type { ArcCommitLayout } from "../components/workspace/git-arc-layout";

function mkNode(p: Partial<ArcCommitLayout> & { sha: string }): ArcCommitLayout {
  return {
    sha: p.sha, x: p.x ?? 0, y: p.y ?? 0, isMerge: p.isMerge ?? false,
    isTrunk: p.isTrunk ?? false, arcBranchName: p.arcBranchName ?? null,
    branchName: p.branchName ?? null, isTaskTip: p.isTaskTip ?? false,
    isBranchTip: p.isBranchTip ?? false, issueStatus: p.issueStatus ?? null,
    isDone: p.isDone ?? false, isRemoteOnly: p.isRemoteOnly ?? false,
    isDefault: p.isDefault ?? false, tags: p.tags ?? [], laneColor: p.laneColor ?? "#7E8AA8",
  };
}
function mkBranch(name: string, issueId: string | null): GitBranchInfo {
  return {
    name, lastCommitSha: "s", isLocal: true, isRemote: true, aheadCount: 0, behindCount: 0,
    lastCommitMessage: "", lastCommitAt: "", lastCommitAuthor: "",
    linkedWorkspaceId: null, linkedIssueId: issueId, linkedIssueIdentifier: issueId ? "AOA-1" : null,
    linkedIssueTitle: null, linkedIssueStatus: null, linkedIssueWorkMode: null,
    pr: null, overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: [],
  };
}

describe("resolveNodeRender", () => {
  const branchByName = new Map([["feat/x", mkBranch("feat/x", "i1")]]);
  const taskByTip = new Map([["s1", mkBranch("feat/x", "i1")]]);

  it("a visible task tip draws a card (asDot false)", () => {
    const node = mkNode({ sha: "s1", isTaskTip: true, branchName: "feat/x" });
    const r = resolveNodeRender(node, new Set(["feat/x"]), branchByName, taskByTip, new Set());
    expect(r.asDot).toBe(false);
    expect(r.taskVisible).toBe(true);
    expect(r.taskBranch?.name).toBe("feat/x");
  });

  it("a task tip filtered OUT draws a plain dot (asDot true)", () => {
    const node = mkNode({ sha: "s1", isTaskTip: true, branchName: "feat/x" });
    const r = resolveNodeRender(node, new Set(["main"]), branchByName, taskByTip, new Set());
    expect(r.asDot).toBe(true);
    expect(r.taskVisible).toBe(false);
  });

  it("a stacked tip is always asDot", () => {
    const node = mkNode({ sha: "s1", isTaskTip: true, branchName: "feat/x" });
    const r = resolveNodeRender(node, new Set(["feat/x"]), branchByName, taskByTip, new Set(["s1"]));
    expect(r.asDot).toBe(true);
  });
});

describe("hitRegionAt", () => {
  const regions: HitRegion[] = [
    { shape: "poly", pts: [[0, 100], [200, 100]], threshold: 8, target: { kind: "trunkLine" } },
    { shape: "rect", x: 90, y: 90, w: 20, h: 20, target: { kind: "commit", sha: "c1" } },
  ];

  it("returns the topmost (last-pushed) region on overlap", () => {
    // point (100,100) is on the trunk poly AND inside the rect → rect wins (pushed later)
    expect(hitRegionAt(regions, 100, 100)).toEqual({ kind: "commit", sha: "c1" });
  });
  it("hits the poly within threshold when no rect overlaps", () => {
    expect(hitRegionAt(regions, 40, 104)).toEqual({ kind: "trunkLine" });
  });
  it("returns null when nothing is near", () => {
    expect(hitRegionAt(regions, 400, 400)).toBeNull();
  });
});
```

Run (CWD `ui/`): `npx vitest run src/__tests__/GitArcHit.test.ts` → FAIL (module `git-arc-hit` not found).

- [ ] **Step 2: Create `git-arc-hit.ts` with the model, `resolveNodeRender`, and `hitRegionAt`:**

```ts
/**
 * git-arc-hit.ts — pure hit-region registry for the Git Command Centre Map.
 *
 * buildHitRegions() produces an ordered list of regions that mirrors exactly
 * what GitGraphCanvas.redraw() draws (same layout + filter inputs + the shared
 * resolveNodeRender decision). hitRegionAt() walks them topmost-first. No DOM,
 * no canvas, no React — fully unit-testable.
 */

import type { GitBranchInfo } from "@armyofagents/shared";
import type { ArcCommitLayout, ArcLayoutResult, TipStack } from "./git-arc-layout";
import { computeStackCardLayout } from "./git-arc-layout";
import { CARD_W, CARD_H, COMMIT_R, pointToSegmentDistance } from "./git-arc-draw";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type HitTarget =
  | { kind: "task"; branchName: string }
  | { kind: "plainTip"; branchName: string }
  | { kind: "commit"; sha: string }
  | { kind: "merge"; sha: string }
  | { kind: "tag"; name: string; sha: string }
  | { kind: "trunkLine" }
  | { kind: "showMore" };

export type HitRegion =
  | { shape: "rect"; x: number; y: number; w: number; h: number; target: HitTarget }
  | { shape: "poly"; pts: Array<[number, number]>; threshold: number; target: HitTarget };

/** Topmost-first hit test: regions pushed later (drawn on top) win. */
export function hitRegionAt(
  regions: HitRegion[],
  cx: number,
  cy: number,
): HitTarget | null {
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i]!;
    if (r.shape === "rect") {
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) return r.target;
    } else {
      for (let j = 0; j < r.pts.length - 1; j++) {
        const d = pointToSegmentDistance(
          cx, cy, r.pts[j]![0], r.pts[j]![1], r.pts[j + 1]![0], r.pts[j + 1]![1],
        );
        if (d <= r.threshold) return r.target;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-node draw decision — SHARED by redraw() and buildHitRegions() so the hit
// area can never disagree with what's drawn.
// ---------------------------------------------------------------------------

export interface NodeRender {
  isStacked: boolean;
  /** The task branch whose tip is this commit (or null). */
  taskBranch: GitBranchInfo | null;
  /** True when that task passes the active filter (in visibleNames). */
  taskVisible: boolean;
  /** True when the node renders as a plain dot rather than a card. */
  asDot: boolean;
}

export function resolveNodeRender(
  node: ArcCommitLayout,
  visibleNames: Set<string>,
  branchByName: Map<string, GitBranchInfo>,
  taskBranchByTipSha: Map<string, GitBranchInfo>,
  stackedShas: Set<string>,
): NodeRender {
  const isStacked = stackedShas.has(node.sha);
  let taskBranch: GitBranchInfo | null =
    (node.branchName ? branchByName.get(node.branchName) : undefined) ?? null;
  if (!taskBranch?.linkedIssueId) {
    taskBranch = taskBranchByTipSha.get(node.sha) ?? null;
  }
  const taskVisible =
    !!taskBranch?.linkedIssueId && visibleNames.has(taskBranch.name);
  const asDot = isStacked || (node.isTaskTip && !taskVisible);
  return { isStacked, taskBranch, taskVisible, asDot };
}
```

- [ ] **Step 3: Run the test — expect PASS** (resolveNodeRender + hitRegionAt only; buildHitRegions is Task A2).

Run (CWD `ui/`): `npx vitest run src/__tests__/GitArcHit.test.ts` → the `resolveNodeRender` + `hitRegionAt` blocks pass.

- [ ] **Step 4: Typecheck + commit.**

```bash
# CWD ui/
npx tsc -b
git add ui/src/components/workspace/git-arc-hit.ts ui/src/__tests__/GitArcHit.test.ts
git commit -m "feat(git-graph): hit-region model + resolveNodeRender + hitRegionAt"
```

---

### Task A2: `buildHitRegions` — mirror every drawn glyph

**Files:**
- Modify: `ui/src/components/workspace/git-arc-hit.ts`
- Test: `ui/src/__tests__/GitArcHit.test.ts`

- [ ] **Step 1: Append the failing tests** to `GitArcHit.test.ts`:

```ts
// Replace the import section at the TOP of GitArcHit.test.ts (added in A1) with
// this complete block — it adds buildHitRegions, computeStackCardLayout (a VALUE
// import, used below), CARD_W/CARD_H, and the ArcLayoutResult/TipStack types:
import { describe, it, expect } from "vitest";
import type { GitBranchInfo } from "@armyofagents/shared";
import {
  resolveNodeRender,
  hitRegionAt,
  buildHitRegions,
  type HitRegion,
} from "../components/workspace/git-arc-hit";
import {
  computeStackCardLayout,
  type ArcCommitLayout,
  type ArcLayoutResult,
  type TipStack,
} from "../components/workspace/git-arc-layout";
import { CARD_W, CARD_H } from "../components/workspace/git-arc-draw";

function emptyLayout(nodes: ArcCommitLayout[], arcs: never[] = []): ArcLayoutResult {
  return { nodes, arcs: arcs as never, trunkY: 200, totalWidth: 1000, totalHeight: 500, tipStacks: [] };
}

describe("buildHitRegions", () => {
  const branchByName = new Map([
    ["feat/x", mkBranch("feat/x", "i1")],
    ["main", mkBranch("main", null)],
  ]);
  const taskByTip = new Map([["c1", mkBranch("feat/x", "i1")]]);

  it("emits a card rect (task target) that covers the label area BELOW the card", () => {
    const node = mkNode({ sha: "c1", x: 500, y: 200, isTaskTip: true, isBranchTip: true, branchName: "feat/x", arcBranchName: "feat/x" });
    const layout = emptyLayout([node]);
    const regions = buildHitRegions({
      layout, visibleNames: new Set(["feat/x", "main"]), arcVisibleNames: new Set(["feat/x"]),
      visibleStacks: [], stackedShas: new Set(), branchByName, taskBranchByTipSha: taskByTip,
      trunkSpan: null, defaultBranch: "main",
    });
    // A point 16px BELOW the card centre (in the label band) resolves to the task.
    const t = hitRegionAt(regions, 500, 200 + CARD_H / 2 + 16);
    expect(t).toEqual({ kind: "task", branchName: "feat/x" });
  });

  it("emits a rect (task) covering the badge band to the RIGHT of the card", () => {
    const node = mkNode({ sha: "c1", x: 500, y: 200, isTaskTip: true, isBranchTip: true, branchName: "feat/x", arcBranchName: "feat/x" });
    const regions = buildHitRegions({
      layout: emptyLayout([node]), visibleNames: new Set(["feat/x"]), arcVisibleNames: new Set(["feat/x"]),
      visibleStacks: [], stackedShas: new Set(), branchByName, taskBranchByTipSha: taskByTip,
      trunkSpan: null, defaultBranch: "main",
    });
    expect(hitRegionAt(regions, 500 + CARD_W / 2 + 18, 200)).toEqual({ kind: "task", branchName: "feat/x" });
  });

  it("emits the trunk polyline (trunkLine target) when trunkSpan is given", () => {
    const regions = buildHitRegions({
      layout: emptyLayout([]), visibleNames: new Set(["main"]), arcVisibleNames: new Set(),
      visibleStacks: [], stackedShas: new Set(), branchByName, taskBranchByTipSha: new Map(),
      trunkSpan: { minX: 100, maxX: 900 }, defaultBranch: "main",
    });
    expect(hitRegionAt(regions, 400, 204)).toEqual({ kind: "trunkLine" });
  });

  it("emits a showMore rect for a stack with extra branches, and task rects for shown cards", () => {
    const stack: TipStack = { sha: "c1", x: 500, y: 200, branchNames: ["a", "b", "c", "d", "e"] };
    const bb = new Map([
      ["a", mkBranch("a", "i-a")], ["b", mkBranch("b", "i-b")], ["c", mkBranch("c", "i-c")],
      ["d", mkBranch("d", "i-d")], ["e", mkBranch("e", "i-e")],
    ]);
    const regions = buildHitRegions({
      layout: emptyLayout([]), visibleNames: new Set(["a", "b", "c", "d", "e"]),
      arcVisibleNames: new Set(), visibleStacks: [stack], stackedShas: new Set(["c1"]),
      branchByName: bb, taskBranchByTipSha: new Map(), trunkSpan: null, defaultBranch: "main",
    });
    // "+N more" pill centre (stack.x+50 .. +104, stack.y+8 .. +23)
    expect(hitRegionAt(regions, 500 + 50 + 27, 200 + 8 + 7)).toEqual({ kind: "showMore" });
    // first fanned card → its task
    const cards = computeStackCardLayout(stack);
    expect(hitRegionAt(regions, cards[0]!.x, cards[0]!.y)).toEqual({ kind: "task", branchName: "a" });
  });

  it("a done branch's arc IS hittable when it is in arcVisibleNames", () => {
    const arc = {
      branchName: "feat/done", direction: "up" as const, branchPointX: 100, mergePointX: 300,
      apexY: 140, isOpen: false, color: "#7E8AA8", isDone: true,
      points: [[100, 200], [200, 140], [300, 200]] as Array<[number, number]>,
    };
    const layout: ArcLayoutResult = {
      nodes: [], arcs: [arc], trunkY: 200, totalWidth: 1000, totalHeight: 500, tipStacks: [],
    };
    const regions = buildHitRegions({
      layout, visibleNames: new Set(["feat/done"]), arcVisibleNames: new Set(["feat/done"]),
      visibleStacks: [], stackedShas: new Set(), branchByName: new Map([["feat/done", mkBranch("feat/done", null)]]),
      taskBranchByTipSha: new Map(), trunkSpan: null, defaultBranch: "main",
    });
    expect(hitRegionAt(regions, 200, 141)).toEqual({ kind: "plainTip", branchName: "feat/done" });
  });
});
```

Run: `npx vitest run src/__tests__/GitArcHit.test.ts` → the buildHitRegions block FAILS (not exported).

- [ ] **Step 2: Implement `buildHitRegions`** — append to `git-arc-hit.ts`:

```ts
// ---------------------------------------------------------------------------
// Region geometry constants (generous so the hit area always covers the glyph)
// ---------------------------------------------------------------------------

const PAD = 4;
const BADGE_EXT = 26;   // card → right, covers CI/PR/conflict badges
const LABEL_EXT = 24;   // card → down, covers the 2 label lines
const STACK_LABEL_EXT = 36; // stacked card → right, covers the id label
const SYNC_EXT_DEFAULT = 30; // node → up on the default tip (clears HEAD + sync)
const SYNC_EXT = 18;    // node → up on a normal tip (sync marker)
const TAG_W = 90;       // node → right, covers up to 2 tag pills
const ARC_THRESHOLD = 8;
const TRUNK_THRESHOLD = 8;

function hasSync(b: GitBranchInfo | null | undefined): boolean {
  return !!b && ((b.aheadCount ?? 0) > 0 || (b.behindCount ?? 0) > 0);
}

export interface BuildHitRegionsArgs {
  layout: ArcLayoutResult;
  visibleNames: Set<string>;
  arcVisibleNames: Set<string>;
  visibleStacks: TipStack[];
  stackedShas: Set<string>;
  branchByName: Map<string, GitBranchInfo>;
  taskBranchByTipSha: Map<string, GitBranchInfo>;
  trunkSpan: { minX: number; maxX: number } | null;
  defaultBranch: string;
}

/** Build the ordered hit-region list. Order = draw order (later = on top), so
 * hitRegionAt() walks it in reverse and stack cards/pills beat nodes beat lines. */
export function buildHitRegions(args: BuildHitRegionsArgs): HitRegion[] {
  const {
    layout, visibleNames, arcVisibleNames, visibleStacks, stackedShas,
    branchByName, taskBranchByTipSha, trunkSpan, defaultBranch,
  } = args;
  const regions: HitRegion[] = [];

  // 1. Trunk line (bottom of the stack).
  if (trunkSpan) {
    regions.push({
      shape: "poly",
      pts: [[trunkSpan.minX, layout.trunkY], [trunkSpan.maxX, layout.trunkY]],
      threshold: TRUNK_THRESHOLD,
      target: { kind: "trunkLine" },
    });
  }

  // 2. Arc lines (incl. done/cancelled — they are hittable whenever visible).
  for (const arc of layout.arcs) {
    if (!arcVisibleNames.has(arc.branchName)) continue;
    if (arc.points.length < 2) continue;
    const b = branchByName.get(arc.branchName);
    const target: HitTarget = b?.linkedIssueId
      ? { kind: "task", branchName: arc.branchName }
      : { kind: "plainTip", branchName: arc.branchName };
    regions.push({ shape: "poly", pts: arc.points, threshold: ARC_THRESHOLD, target });
  }

  // 3. Nodes (dots/cards) + their tags. Mirror redraw's visibleNodes filter.
  for (const node of layout.nodes) {
    const visible = node.isTrunk
      ? visibleNames.has(defaultBranch)
      : node.arcBranchName != null && visibleNames.has(node.arcBranchName);
    if (!visible) continue;

    const r = resolveNodeRender(node, visibleNames, branchByName, taskBranchByTipSha, stackedShas);

    // Tag pills (separate target — to the right of the node).
    if (node.tags.length > 0) {
      regions.push({
        shape: "rect",
        x: node.x + COMMIT_R + 4, y: node.y - 8, w: TAG_W, h: 16,
        target: { kind: "tag", name: node.tags[0]!, sha: node.sha },
      });
    }

    if (!r.asDot && r.taskBranch?.linkedIssueId) {
      // Card UNIT: card box + label (below) + badges (right) + sync (above).
      const syncUp = hasSync(r.taskBranch)
        ? (node.isDefault ? SYNC_EXT_DEFAULT : SYNC_EXT)
        : PAD;
      const top = node.y - CARD_H / 2 - syncUp;
      regions.push({
        shape: "rect",
        x: node.x - CARD_W / 2 - PAD,
        y: top,
        w: CARD_W + PAD + BADGE_EXT,
        h: (node.y + CARD_H / 2 + LABEL_EXT) - top,
        target: { kind: "task", branchName: r.taskBranch.name },
      });
    } else {
      // Plain dot/diamond. Resolve its target and extend up for a sync marker.
      const tipBranch = node.branchName ? branchByName.get(node.branchName) : undefined;
      const syncUp = hasSync(tipBranch ?? r.taskBranch)
        ? (node.isDefault ? SYNC_EXT_DEFAULT : SYNC_EXT)
        : PAD;
      let target: HitTarget;
      if (node.isMerge) target = { kind: "merge", sha: node.sha };
      else if (node.isBranchTip && tipBranch && !tipBranch.linkedIssueId)
        target = { kind: "plainTip", branchName: tipBranch.name };
      else target = { kind: "commit", sha: node.sha };
      const top = node.y - COMMIT_R - syncUp;
      regions.push({
        shape: "rect",
        x: node.x - COMMIT_R - PAD,
        y: top,
        w: 2 * (COMMIT_R + PAD),
        h: (node.y + COMMIT_R + PAD) - top,
        target,
      });
    }
  }

  // 4. Stacks (top of the stack so they win): each fanned card + the "+N" pill.
  for (const stack of visibleStacks) {
    for (const c of computeStackCardLayout(stack)) {
      regions.push({
        shape: "rect",
        x: c.x - CARD_W / 2 - PAD,
        y: c.y - CARD_H / 2 - PAD,
        w: CARD_W + PAD + STACK_LABEL_EXT,
        h: CARD_H + 2 * PAD,
        target: { kind: "task", branchName: c.branchName },
      });
    }
    if (stack.branchNames.length > computeStackCardLayout(stack).length) {
      regions.push({
        shape: "rect",
        x: stack.x + 50, y: stack.y + 8, w: 54, h: 15,
        target: { kind: "showMore" },
      });
    }
  }

  return regions;
}
```

- [ ] **Step 3: Run the tests — expect PASS** (all `GitArcHit.test.ts` blocks).

Run: `npx vitest run src/__tests__/GitArcHit.test.ts` → all pass.

- [ ] **Step 4: Typecheck + commit.**

```bash
# CWD ui/
npx tsc -b
git add ui/src/components/workspace/git-arc-hit.ts ui/src/__tests__/GitArcHit.test.ts
git commit -m "feat(git-graph): buildHitRegions mirrors every drawn glyph"
```

---

# Batch B — Wire the component to the registry

### Task B1: `redraw` uses `resolveNodeRender`; add a `regions` memo

**Files:**
- Modify: `ui/src/components/workspace/GitGraphCanvas.tsx`

- [ ] **Step 1: Import the registry.** Add below the existing `git-arc-draw` import block:

```ts
import {
  buildHitRegions,
  hitRegionAt,
  resolveNodeRender,
  type HitTarget,
} from "./git-arc-hit";
```

- [ ] **Step 2: Replace the node-loop's inline decision with `resolveNodeRender`.** Find the node loop in `redraw` (the `for (const node of visibleNodes)` block). Replace the per-node resolution + `drawCommitNode` call so it uses `resolveNodeRender` (keeps identical behaviour, single source of truth):

```ts
      const cardBranchNames = new Set<string>();
      for (const node of visibleNodes) {
        const r = resolveNodeRender(
          node, visibleNames, branchByName, taskBranchByTipSha, stackedShas,
        );
        const branchStatus = r.taskBranch?.linkedIssueStatus ?? null;
        drawCommitNode(ctx, node, animPhaseRef.current, branchStatus, r.asDot);

        if (node.isBranchTip && !r.isStacked) {
          let syncBranch = node.branchName ? branchByName.get(node.branchName) : undefined;
          if (!syncBranch) syncBranch = taskBranchByTipSha.get(node.sha);
          if (syncBranch) drawSyncBadge(ctx, node, syncBranch);
        }

        if (node.isTaskTip && !r.isStacked && r.taskVisible && r.taskBranch?.linkedIssueId) {
          drawCardLabel(ctx, node, r.taskBranch);
          drawCardBadges(ctx, node, r.taskBranch);
          drawLabelDots(ctx, node, r.taskBranch);
          if (node.arcBranchName) cardBranchNames.add(node.arcBranchName);
        }
      }
```

> This is behaviourally identical to the current loop — it just centralizes the `asDot`/`taskVisible` decision in `resolveNodeRender` so `buildHitRegions` and `redraw` can't drift. The `branchStatus` for the card ring now comes from the resolved task branch (more correct than the old `node.branchName` lookup for shared commits).

- [ ] **Step 3: Add the `regions` memo.** After the `arcVisibleNames` memo (and `trunkSpan` memo), add:

```ts
    // Hit regions for hover/click — rebuilt only when the layout/filter/branch
    // data change (NOT per animation frame).
    const regions = useMemo(
      () =>
        buildHitRegions({
          layout,
          visibleNames,
          arcVisibleNames,
          visibleStacks,
          stackedShas,
          branchByName,
          taskBranchByTipSha,
          trunkSpan,
          defaultBranch: graph.defaultBranch,
        }),
      [layout, visibleNames, arcVisibleNames, visibleStacks, stackedShas, branchByName, taskBranchByTipSha, trunkSpan, graph.defaultBranch],
    );
```

- [ ] **Step 4: Typecheck (no behaviour change yet for hover; hit-test still old).**

```bash
# CWD ui/
npx tsc -b
```
Expected: zero errors. (`regions` is unused until B2 — TS won't error since `noUnusedLocals` is off, but B2 wires it immediately.)

- [ ] **Step 5: Commit.**

```bash
git add ui/src/components/workspace/GitGraphCanvas.tsx
git commit -m "refactor(git-graph): redraw uses resolveNodeRender; add regions memo"
```

---

### Task B2: Rewrite `handleMouseMove`/`handleClick` to the registry; retire the old hit fns

**Files:**
- Modify: `ui/src/components/workspace/GitGraphCanvas.tsx`

- [ ] **Step 1: Add a `resolveTarget` helper** above the component (next to where `hitTest` was, or just below the imports). It maps a `HitTarget` → a `HoveredNode` plus an optional `showMore` flag, using the component's data passed in:

```ts
function resolveTarget(
  target: HitTarget,
  branchByName: Map<string, GitBranchInfo>,
  graph: GitGraphData,
  layoutNodes: ArcCommitLayout[],
  cx: number,
): { hover: HoveredNode | null; showMore: boolean } {
  switch (target.kind) {
    case "task": {
      const b = branchByName.get(target.branchName);
      if (b?.linkedIssueId) return { hover: { type: "task", branch: b }, showMore: false };
      return { hover: b ? { type: "plain_tip", branch: b } : null, showMore: false };
    }
    case "plainTip": {
      const b = branchByName.get(target.branchName);
      return { hover: b ? { type: "plain_tip", branch: b } : null, showMore: false };
    }
    case "commit": {
      const c = graph.commits.find((x) => x.sha === target.sha);
      return { hover: c ? { type: "commit", commit: c } : null, showMore: false };
    }
    case "merge": {
      const c = graph.commits.find((x) => x.sha === target.sha);
      return { hover: c ? { type: "merge", commit: c } : null, showMore: false };
    }
    case "tag": {
      const c = graph.commits.find((x) => x.sha === target.sha);
      return {
        hover: { type: "tag", name: target.name, sha: target.sha, date: c?.committedAt ?? "" },
        showMore: false,
      };
    }
    case "trunkLine": {
      // nearest trunk commit to the cursor x
      let nearest: ArcCommitLayout | null = null;
      let nd = Infinity;
      for (const n of layoutNodes) {
        if (!n.isTrunk) continue;
        const d = Math.abs(n.x - cx);
        if (d < nd) { nd = d; nearest = n; }
      }
      const c = nearest ? graph.commits.find((x) => x.sha === nearest!.sha) : undefined;
      return { hover: c ? { type: "commit", commit: c } : null, showMore: false };
    }
    case "showMore":
      return { hover: null, showMore: true };
  }
}
```

- [ ] **Step 2: Rewrite `handleMouseMove`.** Replace the entire body (from `const rect = ...` through the final `onHover(...)`/cursor logic) with:

```ts
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const t = transformRef.current;
        const cx = (e.clientX - rect.left - t.x) / t.k;
        const cy = (e.clientY - rect.top - t.y) / t.k;

        const target = hitRegionAt(regions, cx, cy);
        if (!target) {
          canvas.style.cursor = "grab";
          onHover(null, { x: e.clientX, y: e.clientY });
          return;
        }
        canvas.style.cursor = "pointer";
        const { hover } = resolveTarget(target, branchByName, graph, layout.nodes, cx);
        onHover(hover, { x: e.clientX, y: e.clientY });
```

Update its dependency array to:

```ts
      [regions, branchByName, graph, layout.nodes, onHover],
```

- [ ] **Step 3: Rewrite `handleClick`.** Replace its body with:

```ts
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const t = transformRef.current;
        const cx = (e.clientX - rect.left - t.x) / t.k;
        const cy = (e.clientY - rect.top - t.y) / t.k;

        const target = hitRegionAt(regions, cx, cy);
        if (!target) return;
        const { hover, showMore } = resolveTarget(target, branchByName, graph, layout.nodes, cx);
        if (showMore) { onShowMore?.(); return; }
        if (hover) onClick(hover);
```

Update its dependency array to:

```ts
      [regions, branchByName, graph, layout.nodes, onClick, onShowMore],
```

> **Ordering:** `handleClick` references `onShowMore`, which is added to the props in Task C1. To keep each commit compiling, do **C1 Step 1–2 (add the `onShowMore` prop to `GitGraphCanvasProps` + destructure it) as the first move of this task**, then rewrite `handleClick`. C1's remaining step (wiring the callback in `GitCommandCentre.tsx`) stays in C1.

- [ ] **Step 4: Delete the dead hit functions.** Remove `hitTest`, `hitTestArc`, and `hitTestStacks` (no longer referenced). Also remove now-unused imports if `tsc`/eslint flags them: `pointToSegmentDistance` (now only used inside `git-arc-hit.ts`) and `computeStackCardLayout` (now only in `git-arc-hit.ts`) — remove from `GitGraphCanvas.tsx` imports if unused there. Keep `drawTipStack`, `drawCommitNode`, etc.

- [ ] **Step 5: Typecheck + run all tests + harness + commit.**

```bash
# CWD ui/
npx tsc -b
npx vitest run
# CWD repo root
npx esbuild ui/dev-harness/arc-harness.ts --bundle --format=iife --outfile=ui/dev-harness/arc-harness.bundle.js
```
Expected: tsc clean, all tests pass, harness builds.

```bash
git add ui/src/components/workspace/GitGraphCanvas.tsx
git commit -m "refactor(git-graph): hover/click use the hit-region registry; retire legacy hit-tests"
```

---

# Batch C — "+N more" pill → Pipeline

### Task C1: Add `onShowMore` prop and wire the pill click

**Files:**
- Modify: `ui/src/components/workspace/GitGraphCanvas.tsx` (props)
- Modify: `ui/src/components/workspace/GitCommandCentre.tsx` (pass the callback)

- [ ] **Step 1: Add the prop to `GitGraphCanvasProps`:**

```ts
export interface GitGraphCanvasProps {
  branches: GitBranchInfo[];
  graph: GitGraphData;
  filter: "all" | "running" | "blocked" | "prs" | "merged";
  onHover: (node: HoveredNode | null, position: { x: number; y: number }) => void;
  onClick: (node: HoveredNode) => void;
  /** Called when the "+N more" stack pill is clicked — open the Pipeline tab. */
  onShowMore?: () => void;
}
```

- [ ] **Step 2: Destructure `onShowMore`** in the component signature:

```ts
  function GitGraphCanvas({ branches, graph, filter, onHover, onClick, onShowMore }, ref) {
```

(The `handleClick` from Task B2 already calls `onShowMore?.()` for the `showMore` target.)

- [ ] **Step 3: Wire it in `GitCommandCentre.tsx`.** In the `<GitGraphCanvas ... />` usage, add:

```tsx
            <GitGraphCanvas
              ref={canvasHandleRef}
              branches={branches}
              graph={graphData.graph}
              filter={filter}
              onHover={handleHover}
              onClick={handleClick}
              onShowMore={() => setViewMode("pipeline")}
            />
```

- [ ] **Step 4: Typecheck + browser-verify.**

```bash
# CWD ui/
npx tsc -b
```
On `http://127.0.0.1:3100` with a stack that has a "+N more" pill: hovering the pill shows a pointer; **clicking it switches to the Pipeline tab**.

- [ ] **Step 5: Commit.**

```bash
git add ui/src/components/workspace/GitGraphCanvas.tsx ui/src/components/workspace/GitCommandCentre.tsx
git commit -m "feat(git-graph): +N more stack pill is clickable -> Pipeline"
```

---

# Batch D — Done-arc hover + full cursor-probe sweep

### Task D1: Verify every glyph is hoverable (live cursor probe)

**Files:** none (verification only).

- [ ] **Step 1: Rebuild harness + open the live Map.**

```bash
# CWD repo root
npx esbuild ui/dev-harness/arc-harness.ts --bundle --format=iife --outfile=ui/dev-harness/arc-harness.bundle.js
```
Open `http://127.0.0.1:3100` → a project with a stack (or use the harness `arc-harness.html`).

- [ ] **Step 2: Probe the cursor at each glyph.** In `/browse`, run (adjust coords to the actual on-screen glyph positions from a screenshot):

```js
(() => {
  const c = document.querySelector('canvas');
  const probe = (x, y) => { c.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true })); return c.style.cursor; };
  return JSON.stringify({
    cardBox: probe(/*card*/),
    cardLabel: probe(/*id/title text*/),
    cardBadge: probe(/*right of card*/),
    syncMarker: probe(/*above a tip with ahead/behind*/),
    plusMorePill: probe(/*the +N pill*/),
    tagPill: probe(/*a tag pill*/),
    arcLine: probe(/*mid-arc*/),
    doneArc: probe(/*a merged branch arc under the Merged filter*/),
    trunkLine: probe(/*between trunk dots*/),
    empty: probe(700, 300),
  });
})()
```
Expected: every glyph except `empty` returns `"pointer"`; `empty` returns `"grab"`.

- [ ] **Step 3: Verify the "+N more" click + done-arc hover.**
- Click the "+N more" pill → the view switches to **Pipeline**.
- Switch to the **Merged** filter → hover a faded done/cancelled branch arc → cursor `pointer` + its tooltip appears (done arcs are now hittable).

- [ ] **Step 4: Final gate + commit (no code change — this task is verification; if probe coords were added to a scratch file, discard them).**

```bash
# CWD ui/
npx tsc -b && npx vitest run
```
Expected: clean + all pass. Nothing to commit unless a fix was needed.

---

## Final verification checklist

- [ ] Hovering **anywhere** on a task card group — box, id/title label, CI/PR/conflict badge, ↑/↓ sync marker — shows the pointer + the task tooltip.
- [ ] Hovering a **tag pill** shows the pointer + the tag tooltip.
- [ ] Hovering the **"+N more" pill** shows the pointer; **clicking** it opens the Pipeline tab.
- [ ] Hovering **branch arcs (incl. done/cancelled when visible)** and the **trunk line** shows the pointer + the right tooltip.
- [ ] Hovering the **HEAD label** and an **arc branch-name label** shows the pointer + the right tooltip.
- [ ] Empty canvas shows the grab cursor.
- [ ] `hitTest`/`hitTestArc`/`hitTestStacks` are gone; `git-arc-hit.ts` is the single source of hit-testing.
- [ ] `cd ui && npx tsc -b` clean; `cd ui && npx vitest run` all pass (incl. `GitArcHit.test.ts`).
- [ ] Stacking, filters, sync markers, far-left stub, and the status colours all still render correctly (no regression from the redraw refactor).

---

## Execution Order

```
A1 → A2 → [pure registry done] →
B1 → B2 → C1 → [registry wired + pill click] →
D1 → final checklist
```

Note the B2↔C1 coupling: `handleClick` references `onShowMore`, which is added in C1. Implement C1's prop addition before (or together with) B2's `handleClick` rewrite so it compiles.

## Execution Handoff

Two options:
1. **Subagent-Driven (recommended)** — fresh implementer per task, spec + code-quality review between tasks.
2. **Inline Execution** — `superpowers:executing-plans`, batch with checkpoints.

---

## Addendum — HEAD + branch-name label regions (added during D1)

The D1 live cursor probe found the **HEAD label** and the **arc branch-name labels**
were the only drawn glyphs still returning `grab` after Batch B — they were in the
original "everything hoverable" goal but `buildHitRegions` (Task A2) never emitted
regions for them. Two extra steps were added to `buildHitRegions`, mirroring the
draw code exactly:

- **Arc name labels** (mirrors `drawArcLabels`): for each arc in `arcVisibleNames`
  that is **not** `isDone` and **not** in `cardBranchNames` (the card already labels
  it), a rect at `labelX = isOpen ? branchPointX+80 : (branchPointX+mergePointX)/2`,
  `baseY = direction==="up" ? apexY-8 : apexY+14`, width approximated from the
  (≤18-char) name at `LABEL_CHAR_W=5.5`px/glyph. Target = `task`/`plainTip` for the
  branch. `cardBranchNames` is collected during the node loop (same rule as redraw).
- **HEAD label** (mirrors `drawHeadLabel`): a rect above the default tip
  (`layout.nodes.find(n => n.isDefault && n.branchName != null)`), `labelY =
  isTaskTip ? y-CARD_H/2-8 : y-COMMIT_R-8`, width `HEAD_W=24`. Target mirrors the
  tip node (`task`/`plainTip`/`commit`).

Both push **after** the stacks loop so labels sit above their arc line / node in
hit order. Covered by two unit tests in `GitArcHit.test.ts`; verified live (every
glyph → `pointer`, empty → `grab`).
