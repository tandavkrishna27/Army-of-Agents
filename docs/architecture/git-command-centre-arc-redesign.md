# Git Command Centre — Arc Layout Redesign

**Date:** 2026-05-23  
**Branch:** `feat/git-command-centre`  
**Status:** Approved for implementation

---

## Overview

Replace the current parallel-lanes canvas layout in the Git Command Centre with a **trunk-and-arcs** layout that matches industry-standard git graph visualisations. Simultaneously surface the new GitHub integration data (CI status, PR badges, label dots, repo selector) that was built in the same branch.

The current layout assigns each branch a fixed horizontal row — all branches always visible, merge connections drawn as diagonal beziers. The new layout has one central horizontal trunk (main) with feature branches arcing above and below, clearly showing branch/merge relationships as closed loops (merged) or open rails (active).

---

## Design Decisions (approved)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Trunk position | Centre of canvas; feature arcs alternate above and below |
| 2 | Open (unmerged) branches | Arc curves off trunk, then runs as a flat horizontal rail to the right edge; dashed tail at edge |
| 3 | GitHub data on canvas | CI pass/fail dot + PR number badge on card; all other GitHub data (reviewers, labels text, comments, ahead/behind) in hover card only |
| 4 | Repo selector | Compact monospace pill in top-right of toolbar: `[GitHub icon] owner/repo ▾` — click opens repo switcher dropdown |
| 5 | Labels on canvas | 1–3 small coloured squares (4×4 px) below each task card; hover card shows full label names. Only rendered when GitHub is connected. |
| 6 | Merged arcs | Hidden by default; fourth filter chip "Merged" reveals faded closed arcs |

---

## Architecture

### What changes

| File | Change type | Summary |
|------|------------|---------|
| `ui/src/components/workspace/GitGraphCanvas.tsx` | Major rewrite | Replace `computeLayout` + parallel-lane drawing with `computeArcLayout` + arc drawing system |
| `ui/src/components/workspace/GitCommandCentre.tsx` | Moderate update | Repo selector query + pill, "Merged" chip, count badges on Running/PRs chips |
| `ui/src/api/github-integration.ts` | Already exists | `githubIntegrationApi.repositories(companyId)` and `appStatus(companyId)` — just consumed |
| `packages/shared/src/types/git-graph.ts` | Small addition | Add `labels: Array<{ name: string; color: string }>` to the `pr` field |
| `server/src/services/github-pr.ts` | Small addition | Populate `labels` from the GitHub PR object in `enrichBranchPr` |

`GitHoverCard.tsx` and `GitPipelineView.tsx` — **no changes needed**.

---

## Arc Layout Algorithm

### Core concept

```
trunkY = canvas.height / 2    (vertical centre)

For each non-default branch:
  1. Find branchPoint  — last common ancestor with main (walk parentShas)
  2. Find mergePoint   — merge commit on main that has this branch as parent (null if open)
  3. Assign direction  — alternate up/down by branch index (0=up, 1=down, 2=up …)
  4. Compute arcHeight — base 60px + 8px per extra commit, capped at 120px
  5. Position commits  — evenly spaced along the bezier t-parameter
  6. Open branches     — arc to flat rail at apexY, commits continue on the rail
```

### New data structures

```typescript
// Replaces CommitLayout
interface ArcCommitLayout {
  sha: string;
  x: number;
  y: number;
  isMerge: boolean;
  isTrunk: boolean;        // sits on the main trunk line
  branchName: string | null;
  isTaskTip: boolean;
  isBranchTip: boolean;
  issueStatus: string | null;
  isDone: boolean;         // branch is merged/done — drives opacity
  isRemoteOnly: boolean;
  isDefault: boolean;
  tags: string[];
  laneColor: string;
}

interface ArcDefinition {
  branchName: string;
  direction: "up" | "down";
  branchPointX: number;    // X on trunk where arc starts
  mergePointX: number | null; // X on trunk where arc ends (null = open)
  apexY: number;           // absolute Y of arc peak
  isOpen: boolean;         // no merge found
  color: string;
  isDone: boolean;
}

interface ArcLayoutResult {
  nodes: ArcCommitLayout[];
  arcs: ArcDefinition[];
  trunkY: number;
  totalWidth: number;
  totalHeight: number;
}
```

### Branch-point detection (client-side)

```
1. Build Set<string> of all SHAs reachable from defaultBranch tip
   (BFS/DFS on graph.commits using parentShas, capped at 500 iterations)
2. For each feature branch tip SHA, walk parentShas backwards
   until we hit a SHA that is in the default set — that is branchPointSha
3. Map branchPointSha → X coordinate from the existing X-assignment
```

### Merge-point detection (client-side)

```
For each merge commit on the default branch (isMerge === true):
  Walk that commit's parentShas — if any parentSha belongs to a known
  feature branch tip ancestry, that merge commit is the mergePoint for
  that branch.
```

### Commit X assignment (unchanged from current)

Commits are sorted newest-first (git log order). X = `PAD_LEFT + (maxIdx - idx) * X_SPACING`. Oldest commit is at the left; newest (HEAD) at the right. This is identical to the current implementation.

### Bezier arc shape

For a **merged branch** (closed arc):
```
M branchPointX,trunkY
C branchPointX+offset,trunkY  apexX,apexY  apexX,apexY
C apexX,apexY  mergePointX-offset,trunkY  mergePointX,trunkY

where apexX = (branchPointX + mergePointX) / 2
      apexY = trunkY - arcHeight  (up)  or  trunkY + arcHeight  (down)
      offset = (mergePointX - branchPointX) * 0.25
```

For an **open branch** (rail):
```
M branchPointX,trunkY
C branchPointX+offset,trunkY  railStartX,apexY  railStartX,apexY
L canvasRight,apexY            (horizontal rail)
... dashed continuation hint at right edge
```

---

## Drawing System

The drawing order inside the `redraw` callback becomes:

1. **Trunk line** — single `drawTrunk(ctx, trunkY)` horizontal line
2. **Arc lines** — `drawArcs(ctx, arcs, filter)` — one bezier per branch (+ rail for open)
3. **Flow pulse dots** — unchanged, now follow arc path instead of lane line
4. **Trunk commit circles** — `isTrunk === true` nodes
5. **Arc commit circles** — all other nodes
6. **Task cards + label dots** — for `isTaskTip` nodes
7. **CI badges + PR badges** — `drawCardBadges` (existing, already correct)
8. **Tag pills** — unchanged
9. **HEAD label** — unchanged
10. **Branch name labels** — near arc apex (replacing current lane labels)

### Label dot drawing (new)

After drawing the task card, if `branch.pr?.labels?.length > 0` (or a labels field added to `GitBranchInfo` — see data section below):

```typescript
function drawLabelDots(ctx, node, labels: Array<{ color: string }>) {
  const maxDots = Math.min(labels.length, 3);
  const startX = node.x - CARD_W / 2;
  const dotY = node.y + CARD_H / 2 + 8;
  for (let i = 0; i < maxDots; i++) {
    ctx.beginPath();
    ctx.rect(startX + i * 8, dotY, 5, 5);
    ctx.fillStyle = "#" + labels[i].color;
    ctx.fill();
  }
}
```

### Hit testing (updated)

Arc hit testing replaces edge hit testing:

```typescript
function hitTestArc(arcs: ArcDefinition[], cx, cy, threshold = 8): ArcDefinition | null
```

Samples 16 points along each arc bezier and finds the closest arc within `threshold` px. Same approach as current `hitTestEdge` but uses the arc bezier coefficients.

---

## New GitHub Data Points

### Labels on canvas

Labels are currently returned by `GET /workspaces/:id/github/labels` per workspace — that's a per-request call, too expensive for the canvas. The right approach: add `labels: Array<{ name: string; color: string }> | null` to `GitBranchInfo` and populate it from the `/git/enrich` endpoint (same enrichment pass that fetches PR data, via the existing `enrichBranchPr` function).

**Server change required:** In `server/src/services/github-pr.ts`, `enrichBranchPr` already fetches the full PR object. The `labels` array is available on the GitHub PR response as `pr.labels`. Add it to `GitBranchInfo.pr`:

```typescript
// packages/shared/src/types/git-graph.ts — extend pr field
pr: {
  number: number;
  url: string;
  reviewState: GitPrReviewState;
  ciStatus: GitCIStatus;
  ciUrl: string | null;
  commentCount: number;
  labels: Array<{ name: string; color: string }>; // ADD THIS
} | null;
```

No new API route needed — labels ride the existing `/git/enrich` response.

### Repo selector

**Query:** `githubIntegrationApi.repositories(companyId)` → `GitHubAuthorizedRepo[]` (`{ name, fullName, private, url }`)  
**When to show:** Only when `graphData.hasGitHubPat === true` (PAT) or GitHub App is installed.  
**Fallback:** When not connected, the pill shows `Connect GitHub →` in amber, linking to Settings → Integrations.  
**Repo switching:** The selected repo is stored in `project_workspaces.repoUrl`. Switching repos = `PATCH /api/companies/:cid/projects/:pid/workspaces` (existing route). After switch, invalidate `git-graph` and `git-enrich` queries.

### Counts on filter chips

Running count: `branches.filter(b => b.linkedIssueStatus === "in_progress").length`  
PRs count: `branches.filter(b => b.pr !== null).length`  
These are derived client-side from the existing `branches` array — no new API calls.

---

## Toolbar Changes (`GitCommandCentre.tsx`)

### New filter chips (full set)

```tsx
[
  { key: "running",  label: "Running", dot: "#4FB67E",  count: runningCount },
  { key: "blocked",  label: "Blocked", dot: "#ef4444",  count: null },
  { key: "prs",      label: "PRs",     dot: null,       count: prCount },
  { key: "merged",   label: "Merged",  dot: null,       count: null },
]
```

`FilterMode` type gains `"merged"` value:
```typescript
type FilterMode = "all" | "running" | "blocked" | "prs" | "merged";
```

Merged filter: shows only branches where `linkedIssueStatus === "done" || linkedIssueStatus === "cancelled"` (i.e. the faded closed arcs).

### Repo selector query

```tsx
const { data: repoList } = useQuery({
  queryKey: ["github-repos", companyId],
  queryFn: () => githubIntegrationApi.repositories(companyId),
  enabled: isWorkspacesTabActive && graphData?.hasGitHubPat === true,
  staleTime: 60_000,
});
```

No polling — repo list changes rarely. Refresh button manually invalidates.

---

## Visibility / Graceful Degradation

The canvas must look correct at every GitHub connection level:

| GitHub state | Canvas behaviour |
|-------------|-----------------|
| Not connected | No CI dots, no PR badges, no label dots, no repo pill. Repo pill absent (not shown at all). Filter chips: Running / Blocked / PRs / Merged — PRs chip always shows, just always 0 matches. |
| PAT connected | Full CI + PR badges + label dots. Repo pill shows `owner/repo`. |
| App connected | Same as PAT. Repo pill additionally allows switching repos. |

---

## Filter Logic (updated)

```typescript
const visibleBranches = useMemo(() => {
  if (filter === "all") return branches;
  if (filter === "running") return branches.filter(b => b.linkedIssueStatus === "in_progress");
  if (filter === "blocked") return branches.filter(b => b.linkedIssueStatus === "blocked");
  if (filter === "prs")     return branches.filter(b => !!b.pr);
  if (filter === "merged")  return branches.filter(
    b => b.linkedIssueStatus === "done" || b.linkedIssueStatus === "cancelled"
  );
  return branches;
}, [branches, filter]);
```

Default branch is always included as the trunk backbone regardless of filter (existing behaviour, unchanged).

---

## Testing Strategy

### Unit tests (new file: `ui/src/__tests__/GitArcLayout.test.ts`)

Tests cover the pure functions extracted from the layout algorithm:

| Test | What it verifies |
|------|-----------------|
| `findBranchPoint` — single branch off main | Returns correct SHA from ancestry walk |
| `findBranchPoint` — no common ancestor | Returns first trunk commit (graceful fallback) |
| `findMergePoint` — merged branch | Returns the merge commit SHA |
| `findMergePoint` — open branch | Returns null |
| `assignArcDirection` — 4 branches | Alternates up/down correctly |
| `computeArcHeight` — 1 commit | Returns base height (60px) |
| `computeArcHeight` — 10 commits | Returns capped height (120px) |
| `positionCommitsOnArc` — 3 commits | X values are spread, Y values near apexY |
| Filter logic — "merged" filter | Returns only done/cancelled branches |
| Filter logic — "running" filter | Excludes in_review, blocked, done |

### TypeScript check

`npx tsc --noEmit` in `ui/` must pass with zero errors after all changes.

### Manual visual verification

After implementation, verify in browser with TK-Website repo connected:
- [ ] Main trunk is a horizontal centre line
- [ ] `feat/ARM-21` arcs upward from its branch point on main
- [ ] Merged branches show as faded closed arcs (only when "Merged" chip active)
- [ ] Open branches extend as flat rails to right edge with dashed tail
- [ ] Hovering an arc line shows hover card
- [ ] Task cards show CI dot when GitHub connected
- [ ] PR badge shows PR number
- [ ] Label dots appear below cards (up to 3)
- [ ] Repo pill shows `TK-Website` and clicking it opens repo list
- [ ] Filter chips: Running/Blocked/PRs counts are accurate
- [ ] "Merged" chip reveals faded arcs; deactivating hides them
- [ ] Zoom in/out/reset still works
- [ ] `npx tsc --noEmit` = zero errors

---

## Implementation Phases

### Phase 1 — Arc layout engine (pure functions, no rendering yet)
Extract `computeArcLayout`, `findBranchPoint`, `findMergePoint`, `positionCommitsOnArc` as standalone functions. Write unit tests. No visual change until Phase 2.

### Phase 2 — Canvas arc rendering
Replace `drawEdges` with `drawTrunk` + `drawArcs`. Update commit node drawing to use `isTrunk` for positioning. Wire arc hit testing. Visually matches the approved mockup.

### Phase 3 — Label dots + CI/PR badges on arcs
Add `labels` field to `GitBranchInfo.pr` (server + shared types + enrich endpoint). Draw label dots below task cards. CI dot + PR badge already implemented — verify they still render correctly with arc layout.

### Phase 4 — Toolbar: Merged chip + count badges + repo selector
Add `FilterMode = "merged"`, update chip rendering with count badges, add repo selector query + pill component. Wire repo switching.

### Phase 5 — TypeScript + tests + visual verification
`npx tsc --noEmit` clean. All unit tests passing. Manual checklist above completed.

---

## Files Touched Summary

```
ui/src/components/workspace/GitGraphCanvas.tsx    — major rewrite (arc layout + drawing)
ui/src/components/workspace/GitCommandCentre.tsx  — toolbar additions
ui/src/__tests__/GitArcLayout.test.ts             — new unit tests
packages/shared/src/types/git-graph.ts            — add labels[] to pr field
server/src/services/github-pr.ts                  — populate labels in enrichBranchPr
```

Total: 4 modified files + 1 new test file.
