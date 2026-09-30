# Git Command Centre Map — Enterprise Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **Status of phases:** Phase 1 is fully specified and ready to execute. Phases 2–4 are specified to the task/interface level but contain **flagged design decisions** that must go through `/plan-design-review` (and re-confirm `/plan-eng-review`) before their build tasks start. Do NOT invent the cluster/adaptive visuals during execution — resolve them in design review first.

**Goal:** Make the Map readable, correct, and performant for real org-scale repos (≤250 branches, ≤15k commits) where most branches fork off HEAD ("broom" topology), without regressing the river case.

**Architecture:** The Map's defects are concentrated in the data→geometry layer (`git-arc-layout.ts`); rendering (`git-arc-draw.ts`) and hit-testing (`git-arc-hit.ts`) are healthy. The plan fixes the layout algorithm in leverage order: latent correctness/perf/stability wins first (Phase 1), then the visible co-location collapse via clustering + a single global label pass (Phase 2), then the structural 2-lane ceiling via multi-lane + adaptive density modes (Phase 3), then lifecycle/a11y/proof (Phase 4). Decisions locked with the user: **org-scale target, adaptive view, Map = overview / Pipeline = density.**

**Tech Stack:** React 19 + Vite + D3 + Canvas 2D, TypeScript (strict), Vitest 3 + jsdom, esbuild (harness).

---

## Evidence base (measured during investigation — do not relitigate)

| Finding | Number |
|---|---|
| `computeArcLayout` river, recent-base 150br/10k | 11.7 ms |
| `computeArcLayout` river, **old-base** 150br/10k | **270 ms** |
| `findTrunkShas` on 10k commits | recognizes only **500** |
| old-based branch `getFeatureCommitShas` | walked **9,004** commits (should be ~4) |
| broom 250: arcs on one pixel | **125** |
| add 1 branch | **5–10 / 10** lanes flip |
| done branches laid out | **100 / 100** (never aged) |
| buildHitRegions / hitRegionAt / redraw | 0.07 ms / 1–3 µs / 60 fps (all fine) |
| canvas a11y | role/aria/tabindex all null |

Six defects, ranked: (1) `findTrunkShas` 500-guard, (2) co-location collapse, (3) layout instability, (4) 2-lane ceiling, (5) done-branch accumulation, (6) zero accessibility. Rendering + hit-registry are de-risked.

---

## File map

| File | Phase(s) | Change |
|------|----------|--------|
| `ui/src/components/workspace/git-arc-layout.ts` | 1,2,3,4 | `findTrunkShas` full-walk; stable `assignArcDirections`; cluster detection; multi-lane packing; drop zero-divergence; done filtering |
| `ui/src/components/workspace/git-arc-labels.ts` | 2 | **New.** Pure global label-placement pass (collect rects → de-overlap) |
| `ui/src/components/workspace/git-arc-draw.ts` | 2,3 | Cluster glyph; consume placed label positions; condensed-mode draw |
| `ui/src/components/workspace/git-arc-hit.ts` | 2,3 | Cluster hit region + expand target; multi-lane regions |
| `ui/src/components/workspace/GitGraphCanvas.tsx` | 3,4 | Density detection + adaptive mode; pass active-only branches; a11y |
| `ui/src/components/workspace/GitCommandCentre.tsx` | 3,4 | "Open in Pipeline" affordance; a11y toggle |
| `ui/src/__tests__/GitArcLayout.test.ts` | 1,2,3 | Trunk walk, stable lanes, cluster, multi-lane |
| `ui/src/__tests__/MapPerf.bench.test.ts` | 4 | **New.** Committed perf gates (the throwaway benches, made permanent) |
| `ui/src/__tests__/MapTopology.fixtures.test.ts` | 4 | **New.** Golden-layout fixtures per topology |

---

## Verification commands (every task)

| Purpose | Command | CWD |
|---|---|---|
| Typecheck | `npx tsc -b` | `ui/` |
| One test file | `npx vitest run src/__tests__/GitArcLayout.test.ts` | `ui/` |
| Full UI suite | `npx vitest run` | `ui/` |
| Harness rebuild | `npx esbuild ui/dev-harness/arc-harness.ts --bundle --format=iife --outfile=ui/dev-harness/arc-harness.bundle.js` | repo root |
| Live cursor/redraw probe | `/browse` on `http://127.0.0.1:3100` | — |

`jq` is NOT installed. Harness `*.bundle.js` is gitignored — never `git add` it.

---
---

# Phase 1 — Correctness + perf + stability (latent, ready to execute)

These are surgical, well-understood, and fix defects that hurt every repo today. No new visuals.

### Task 1A: `findTrunkShas` walks the full first-parent chain

**Defect:** `guard < 500` caps recognized trunk at 500 commits → history loss + O(branches×commits) feature-walk (270 ms) + wrong branch points for branches off older commits.

**Files:**
- Modify: `ui/src/components/workspace/git-arc-layout.ts` (`findTrunkShas`)
- Test: `ui/src/__tests__/GitArcLayout.test.ts`

- [ ] **Step 1: Write failing tests.** Append to `GitArcLayout.test.ts`:

```ts
import { findTrunkShas, getFeatureCommitShas, findBranchPoint } from "../components/workspace/git-arc-layout";

describe("findTrunkShas full-walk (no 500 guard)", () => {
  function linear(n: number) {
    const commits = Array.from({ length: n }, (_, i) => ({
      sha: "c" + i, parentShas: i < n - 1 ? ["c" + (i + 1)] : [], shortSha: "c" + i,
      message: "m", author: "a", committedAt: new Date(Date.now() - i * 1000).toISOString(),
      branchNames: [], isMerge: false, tags: [],
    }));
    return { commits, branches: [{ name: "main", laneIndex: 0, color: "#000", tipSha: "c0" }], defaultBranch: "main" };
  }
  it("recognizes ALL trunk commits beyond 500", () => {
    const g = linear(1200) as any;
    expect(findTrunkShas(g).size).toBe(1200);
  });
  it("a branch off an old commit resolves a real branch point (not the tip) and a bounded feature walk", () => {
    const g = linear(1000) as any;
    // feature off c800 with 2 unique commits f1<-f0<-c800
    g.commits.unshift(
      { sha: "f0", parentShas: ["c800"], shortSha: "f0", message: "f", author: "a", committedAt: new Date().toISOString(), branchNames: [], isMerge: false, tags: [] },
    );
    g.commits.unshift(
      { sha: "f1", parentShas: ["f0"], shortSha: "f1", message: "f", author: "a", committedAt: new Date().toISOString(), branchNames: [], isMerge: false, tags: [] },
    );
    const commitMap = new Map(g.commits.map((c: any) => [c.sha, c]));
    const trunk = findTrunkShas(g);
    expect(getFeatureCommitShas(commitMap as any, trunk, "f1")).toEqual(["f1", "f0"]);
    expect(findBranchPoint(commitMap as any, trunk, "f1")).toBe("c800");
  });
});
```

Run (CWD `ui/`): `npx vitest run src/__tests__/GitArcLayout.test.ts` → FAIL (size 500, branch point wrong).

- [ ] **Step 2: Replace the guard with a visited-set cycle guard.** In `git-arc-layout.ts`:

```ts
export function findTrunkShas(graph: GitGraphData): Set<string> {
  const defaultBranch = graph.branches.find((b) => b.name === graph.defaultBranch);
  if (!defaultBranch) return new Set();
  const commitMap = new Map(graph.commits.map((c) => [c.sha, c]));
  const result = new Set<string>();
  // Walk the FULL first-parent chain. The visited-set (result.has) bounds a
  // cyclic/malformed parent ref without truncating a deep trunk. The old
  // `guard < 500` dropped older trunk (history loss) and made branches that
  // fork before commit 500 walk to end-of-history in getFeatureCommitShas.
  let current: string | undefined = defaultBranch.tipSha;
  while (current && !result.has(current)) {
    result.add(current);
    current = commitMap.get(current)?.parentShas[0];
  }
  return result;
}
```

- [ ] **Step 3: Run tests — expect PASS.** `npx vitest run src/__tests__/GitArcLayout.test.ts`.

- [ ] **Step 4: Verify the perf cliff is gone.** Temporarily re-add the throwaway `LayoutPerf2.bench.test.ts` from the investigation (river old-base vs recent-base) OR trust Task 4's committed bench. Expected: old-base layout drops from ~270 ms toward the recent-base ~12 ms. Then `npx tsc -b`.

- [ ] **Step 5: Commit.**

```bash
git add ui/src/components/workspace/git-arc-layout.ts ui/src/__tests__/GitArcLayout.test.ts
git commit -m "fix(git-graph): findTrunkShas walks the full trunk (kills 500-commit history loss + O(B*C) cliff)"
```

---

### Task 1B: Stable lane assignment (no reshuffle on branch add/remove)

**Defect:** `assignArcDirections` uses list-index parity, so adding one branch flips 5–10 of 10 existing branches' lanes — the Map scrambles on every poll/enrich.

**Files:**
- Modify: `ui/src/components/workspace/git-arc-layout.ts` (`assignArcDirections`)
- Test: `ui/src/__tests__/GitArcLayout.test.ts`

- [ ] **Step 1: Write failing test.**

```ts
import { assignArcDirections } from "../components/workspace/git-arc-layout";
describe("assignArcDirections stability", () => {
  it("adding a branch does not change existing branches' directions", () => {
    const base = ["a", "b", "c", "d", "e"].map((name) => ({ name }));
    const d1 = assignArcDirections(base);
    const d2 = assignArcDirections([{ name: "NEW" }, ...base]); // inserted at front
    for (const { name } of base) expect(d2.get(name)).toBe(d1.get(name));
  });
});
```

Run → FAIL (front-insert flips parity for all).

- [ ] **Step 2: Derive direction from a stable name hash, not index.**

```ts
/** Deterministic 32-bit hash so a branch's lane depends only on its name, not
 * its position in the list (position-based parity reshuffled the whole Map when
 * any branch was added/removed). Multi-lane packing (Phase 3) handles balance. */
function branchHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

export function assignArcDirections(
  featureBranches: Array<{ name: string }>,
): Map<string, "up" | "down"> {
  const result = new Map<string, "up" | "down">();
  for (const b of featureBranches) {
    result.set(b.name, (branchHash(b.name) & 1) === 0 ? "up" : "down");
  }
  return result;
}
```

- [ ] **Step 3: Run tests — expect PASS** (existing GitArcLayout tests that asserted index-based directions may need updating to the hash result; update the expected values, do not revert the logic).

- [ ] **Step 4: Typecheck + commit.**

```bash
npx tsc -b
git add ui/src/components/workspace/git-arc-layout.ts ui/src/__tests__/GitArcLayout.test.ts
git commit -m "fix(git-graph): stable name-hash lane assignment (Map no longer reshuffles on branch changes)"
```

> **Note for executor:** after 1B, eyeball the live Map (`/browse`) under a few refreshes to confirm branches keep their lanes. Phase 3 replaces this binary up/down with true multi-lane packing; 1B only removes the *instability*.

---

# Phase 2 — Co-location clustering + global labels (the visible failure)

> **DESIGN GATE:** Tasks 2A and 2B introduce new glyphs (the cluster affordance) and a new label-placement subsystem. Resolve the flagged decisions in `/plan-design-review` before writing their draw code.

### Task 2A: Generalize same-commit grouping to ALL branches (cluster affordance)

**Defect:** `tipStacks` only groups *task* branches at a commit (fan of 3 + "+N"). The 9+ plain branches at HEAD spray individual stub arcs + labels → 125 arcs on one pixel.

**Approach:** Replace task-only `tipStacks` with a general `commitClusters`: any commit with ≥ `CLUSTER_MIN` branches (task or plain) at its tip becomes one cluster. The cluster renders as a single node + count badge ("29 branches") that expands to the existing fan/list. Members are removed from the individual arc/label/node passes (as `stackedBranchNames` already does for the fan).

**Files:** `git-arc-layout.ts` (add `commitClusters` to `ArcLayoutResult`, replacing/superseding `tipStacks`), `git-arc-draw.ts` (`drawCluster`), `git-arc-hit.ts` (cluster rect → `showCluster`/expand target).

**Flagged design decisions (resolve in design review):**
1. Cluster visual: count-badge node that expands in place (fan) vs. opens a popover/side-list vs. routes to Pipeline filtered to that commit.
2. `CLUSTER_MIN` threshold (e.g., 3? 4?) and interaction with the existing 3-card fan.
3. Expanded state: how many to show inline before "+N / open in Pipeline".

**Test sketch (lock once visual is decided):** a commit with 20 branches → exactly 1 cluster region; expand target resolves; members absent from individual arc regions.

- [ ] Steps (write after design review): failing test for `commitClusters` grouping → implement grouping → draw glyph → hit region → verify live that the broom collapses to one cluster.

### Task 2B: Single global label-placement pass

**Defect:** Three independent placers (`drawArcLabels` greedy 6-step nudge, `drawCardLabel`/`drawTipStack`, `drawHeadLabel`) with no shared collision model → labels overprint cards overprint labels.

**Approach:** New pure module `git-arc-labels.ts`: `placeLabels(candidates: LabelCandidate[]): PlacedLabel[]` where each candidate has an anchor + preferred offset + measured-ish width (char-count × constant, as `git-arc-hit.ts` already does). One pass de-overlaps (greedy by priority: cards > sync > branch labels, then push-down/aside on collision). `redraw` collects candidates and draws from placed positions; `buildHitRegions` reads the same placed rects (single source — no drift, same principle as the hit-registry).

**Files:** new `git-arc-labels.ts` (+ test `GitArcLabels.test.ts`), `git-arc-draw.ts` (consume), `git-arc-hit.ts` (consume).

**Flagged design decision:** placement strategy (greedy push vs. simple force relaxation). Greedy is enough for ≤250; keep it pure + testable.

**Test sketch:** N candidates at the same anchor → N non-overlapping placed rects; deterministic.

- [ ] Steps (write after design review): failing test → implement `placeLabels` → wire draw + hit → live verify no overprint.

### Task 2C: Stop drawing zero-divergence branches as arcs

**Defect:** A branch whose tip == HEAD (0 ahead) gets a degenerate stub at HEAD; 28 of them stack identically.

**Approach:** In `computeArcLayout`, classify a branch with no unique feature commits AND tip == default tip as a **HEAD member** (folded into the HEAD cluster from 2A), not a feature arc. No stub, no arc label.

**Files:** `git-arc-layout.ts`. **Test:** branch with tip==HEAD produces no arc; appears as a cluster member.

- [ ] Steps: failing test → implement classification → verify arc count drops.

---

# Phase 3 — Multi-lane + adaptive density (structural ceiling)

> **DESIGN GATE:** Resolve thresholds + condensed-mode visual in `/plan-design-review` first.

### Task 3A: Multi-lane packing (>2 lanes)

**Defect:** Only 2 lanes (up/down); >2 concurrent branches at a region overlap (proven with parallel-release: 2 of 3 share `apexY`).

**Approach:** Replace binary up/down with lane assignment by interval scheduling: treat each arc's [branchPointX, mergePointX] as an interval; assign the lowest non-conflicting lane index per side; map lane index → apexY offset. Keeps Phase 1B stability (seed order by stable hash). Bound max lanes (e.g., 6) then overflow to cluster/condensed.

**Files:** `git-arc-layout.ts` (lane packing), `git-arc-draw.ts` (apexY from lane). **Test:** 3 overlapping parallel branches → 3 distinct lanes/apexY.

- [ ] Steps (after design review).

### Task 3B: Adaptive density mode + "open in Pipeline"

**Approach:** Compute a density signal in the layout (max branches-per-commit, total visible branches). When it exceeds a threshold, the canvas renders **condensed mode** (clusters-first, labels suppressed until hover/zoom) and surfaces an "Open in Pipeline" affordance (Pipeline already handles density cleanly — the decided "Map = overview" strategy).

**Files:** `GitGraphCanvas.tsx` (mode selection), `GitCommandCentre.tsx` (affordance → `setViewMode("pipeline")`, which already exists).

**Flagged design decisions:** density threshold values; condensed-mode visual; whether the switch is automatic, suggested, or manual.

- [ ] Steps (after design review).

---

# Phase 4 — Lifecycle, accessibility, proof

### Task 4A: Age out done/cancelled branches from layout

**Defect:** Done branches are fully laid out + occupy lanes even when hidden (100/100). 

**Approach:** Default Map computes layout over **active branches only** (exclude done/cancelled) unless the "Merged" filter is active. Pass the filtered list into `computeArcLayout` in `GitGraphCanvas.tsx`, or add a `includeDone` flag to the layout.

**Files:** `GitGraphCanvas.tsx` (or `git-arc-layout.ts`). **Test:** done branches absent from layout.arcs in default mode; present under Merged.

- [ ] Steps: failing test → implement → verify perf + lane reduction.

### Task 4B: Accessibility path

**Defect:** Canvas is opaque to keyboard/screen reader (role/aria/tabindex null).

**Approach:** Add `role="img"` + a dynamic `aria-label` summarizing the Map ("N branches, M running, …") to the canvas; ensure the Pipeline tab is reachable and is the documented accessible/keyboard path; optionally a visually-hidden live region listing visible branches. Decided strategy (Map=overview) means Pipeline is the canonical a11y surface — make that explicit and keyboard-reachable.

**Files:** `GitGraphCanvas.tsx`, `GitCommandCentre.tsx`. **Test:** canvas has role + aria-label; Pipeline reachable by keyboard.

- [ ] Steps.

### Task 4C: Commit the proof harness (perf gates + topology fixtures)

**Approach:** Promote the throwaway investigation benches into committed gates: `MapPerf.bench.test.ts` (layout time thresholds at org scale — fail if `computeArcLayout` regresses past, e.g., 30 ms for 250br/10k recent-base) and `MapTopology.fixtures.test.ts` (golden metrics per topology: broom/river/parallel-release/deep-linear/octopus — assert no identical-pixel arc explosions, bounded feature walks, full trunk recognition).

**Files:** new test files. **Verification:** `npx vitest run`.

- [ ] Steps.

### Task 4D: Stale-data reconciliation (edge correctness)

**Approach:** Where `taskTipShas` keys off enriched `lastCommitSha`, reconcile against graph `tipSha` (prefer graph truth or validate membership) so a stale enrichment doesn't drop/misplace a task card. (See the existing code comment in `computeArcLayout`.)

**Files:** `git-arc-layout.ts`. **Test:** divergent lastCommitSha vs tipSha → card still placed on the real tip.

- [ ] Steps.

---

## Execution order

```
Phase 1 (1A → 1B)           [execute now — surgical, high-leverage]
  ↓  ship + verify on /browse
/plan-design-review for Phase 2 + 3 visuals (cluster, multi-lane, adaptive, condensed mode)
  ↓
Phase 2 (2C → 2A → 2B)      [readability — the visible fix]
Phase 3 (3A → 3B)           [structural + adaptive]
Phase 4 (4A → 4C → 4B → 4D) [lifecycle, proof, a11y, edge correctness]
```

Phase 1 stands alone and is worth shipping immediately (fixes latent bugs for every repo). Phases 2–3 must clear design review first because they add user-visible glyphs and modes.

---

## Self-review (writing-plans)

- **Spec coverage:** all six measured defects map to tasks — (1)→1A, (3)→1B, (2)→2A/2B/2C, (4)→3A, (5)→4A, (6)→4B; plus adaptive (3B), proof (4C), stale-data (4D). ✓
- **Placeholders:** Phase 1 has complete code + tests + commands. Phases 2–4 intentionally defer code behind a **DESIGN GATE** rather than fabricate unproven visuals — flagged explicitly, not hidden TODOs. ✓
- **Type consistency:** `findTrunkShas`/`assignArcDirections` signatures unchanged (drop-in). New `commitClusters` supersedes `tipStacks` — Task 2A must update `ArcLayoutResult` + all `tipStacks` consumers (`GitGraphCanvas` memos, `git-arc-hit` stack regions, `drawTipStack`) in one task to avoid drift. ✓ (noted)
- **Scale fit:** targets org-scale (≤250); no full virtualization (matches the user's scale pick); Phase 3 caps lanes then defers to clusters/Pipeline. ✓

---

## Execution Handoff

1. **Recommended:** run `/plan-eng-review` on this plan (architecture sign-off), then `/plan-design-review` for the Phase 2–3 visuals, then build Phase 1 immediately via superpowers:subagent-driven-development while design review runs in parallel.
2. **Fast path:** execute Phase 1 now (it needs no design review), ship it, then design-review 2–3.

---

## Eng-review decisions (plan-eng-review — applied)

- **D2 (Phase 2A) — additive migration, NOT wholesale replace.** Introduce `commitClusters` as the superset concept but keep the existing `tipStacks` task-fan working throughout; migrate the 5 consumers (ArcLayoutResult, GitGraphCanvas memos, git-arc-hit regions, drawTipStack, computeStackCardLayout) one at a time with the existing task-stacking + GitArcHit hover tests green as the safety net. Avoids a 5-consumer big-bang regressing the live-verified hover-registry.
- **D3 (Phase 1A) — fix the whole guard class.** Alongside `findTrunkShas`, also fix `findBranchPoint`'s `guard < 500` (and confirm `getFeatureCommitShas`' visited-set bound) so a branch with >500 of its own commits still resolves a correct branch point. Add a >500-commit-branch test.

## Test additions (IRON RULE — regressions)

- **R1 (CRITICAL, Phase 2):** broom-collapse regression — a 28-branches-at-HEAD fixture yields **1 cluster, not 28 arcs** (assert max-arcs-on-one-pixel drops). Proves the visible defect is fixed and stays fixed.
- **R2 (CRITICAL, Phase 2A):** hover-registry survives the `commitClusters` migration — the existing `GitArcHit` suite stays green + a new cluster-region hit test (hover cluster → pointer; click → expand/Pipeline).
- **R3 (Phase 4C):** committed perf gate — `computeArcLayout` under threshold at 250br/10k for BOTH recent-base and old-base (old-base must not regress past recent-base now that 1A is fixed).

## NOT in scope (deferred, with rationale)

- **Full viewport virtualization / windowing** — unnecessary at org-scale (≤250); redraw is already 60 fps. Revisit only if the scale target rises.
- **Replacing trunk-and-arcs with a generic DAG layout (dagre / d3-dag)** — the metaphor is a locked product choice; custom layout stays.
- **Octopus-merge first-class rendering** — doesn't crash today; represent-as-merge is polish, not a defect.
- **i18n / long-branch-name treatment beyond the existing 18-char truncation** — separate concern; flag if it surfaces.
- **Multi-workspace / repo-switch UX** — orthogonal; out of this plan.

## What already exists (reused, not rebuilt)

- `tipStacks` + `computeStackCardLayout` + `drawTipStack` — **extended** by Phase 2A (clustering), not replaced (per D2).
- `git-arc-hit.ts` registry — reused; Phase 2A adds cluster regions to it.
- The three label placers (`drawArcLabels`, `drawCardLabel`, `drawHeadLabel`) — **consolidated** by Phase 2B into one pure pass (net code reduction).
- Pipeline tab — reused as the dense-repo + accessibility path (Phases 3B, 4B); not rebuilt.
- The investigation benches — promoted to the Phase 4C proof harness.

## Failure modes (per new codepath)

| Codepath | Realistic failure | Test | Error handling | User sees |
|---|---|---|---|---|
| `findTrunkShas` full-walk | cyclic parent ref → infinite loop | cycle-guard test | visited-set guard | bounded, fine |
| `findBranchPoint` guard fix | branch >500 own commits | R / D3 test | proper walk | correct position |
| `commitClusters` migration | a consumer missed → stale region | R2 | existing tests catch | none |
| global label pass | candidate overflow at huge density | cap test | clamp/condense | fewer labels (intended) |
| done-aging (4A) | Merged serves active-only memo | memo-key test | memo key includes filter | Merged shows done |

No silent-failure critical gaps once R1/R2 + the memo-key test land.

## Parallelization

- **Lane A:** Phase 1A → 1B (sequential, both in `git-arc-layout.ts`). Ship now.
- Phases 2 and 3 also touch `git-arc-layout.ts` → **must sequence after Phase 1** (conflict flag: do not parallelize across phases on that file).
- Phase 4C (tests) and 4B (a11y, in components) can run parallel to the Phase 3 design pass.

## Implementation Tasks (synthesized)

- [ ] **T1 (P1, CC ~15min)** — `git-arc-layout.ts` — `findTrunkShas` full-walk + `findBranchPoint` guard fix (Phase 1A + D3). Verify: `GitArcLayout.test.ts` (trunk=1200 recognized; >500-commit branch correct).
- [ ] **T2 (P1, CC ~10min)** — `git-arc-layout.ts` — stable name-hash lanes (Phase 1B). Verify: add-branch-no-flip test.
- [ ] **T3 (P2, design-gated)** — `commitClusters` additive model + cluster glyph + cluster hit region (Phase 2A + D2 + R2).
- [ ] **T4 (P2, design-gated)** — `git-arc-labels.ts` global placement pass (Phase 2B).
- [ ] **T5 (P2, design-gated)** — drop zero-divergence arcs (Phase 2C) + broom-collapse regression R1.
- [ ] **T6 (P3, design-gated)** — multi-lane packing (3A) + adaptive density (3B).
- [ ] **T7 (P3)** — done-aging + memo key (4A); a11y (4B); perf + topology proof harness (4C, incl. R3); stale-data reconcile (4D).

_(JSONL task artifact skipped — `jq` not installed on this machine.)_

---

## Design-review decisions (plan-design-review — applied)

Outcome: the Map reuses the existing, approved visual system. No new glyphs, no mockups. Design completeness 3/10 → 9/10.

- **DD1 (Phase 2A cluster):** reuse the existing fan + "+N more" pill, generalized to ALL branches at a commit (tasks + plain). 28 at HEAD → 3 cards + "+25 more" pill (already clicks → Pipeline). Tokens: existing card glyph (`CARD_W`/`CARD_H` + status border) and "+N more" pill (`--data-slate #7E8AA8` / `--data-indigo #6470DC`, `--radius-sm` 4px, mono count). No new visual vocabulary.
- **DD2 (Phase 2B labels):** de-overlap is algorithm-only; labels keep their current style + already-decided colors. No new visual.
- **DD3 (Phase 3A multi-lane):** lane vertical gap derived from existing arc-height constants (`BASE_ARC_HEIGHT`/`MAX_ARC_HEIGHT`); reuse the grey arc style. No new style.
- **DD4 (Phase 3B condensed + Open-in-Pipeline):** reuse the Pipeline tab + an existing-style button for "Open in Pipeline"; condensed mode = suppress labels until hover/zoom. No new glyph.
- **Minor (P3, pre-existing):** canvas labels use `"Courier New"`; design-system specifies Geist Mono for counts/IDs. Tracked as polish, out of scope for this plan.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 2 arch decisions (additive cluster migration, full guard-class fix); 3 test adds (R1/R2/R3); 1 perf note (memo key); 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR | score 3→9; 4 decisions, all reuse the existing system (no new glyphs / mockups) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **UNRESOLVED:** none.
- **VERDICT:** ENG + DESIGN CLEARED — architecture sound, scope right-sized (one phased roadmap), visuals locked to the existing design system (no new glyphs). All phases buildable; Phase 1 ships first (no gate).
