# Git Command Centre — Tooltips Redesign + Sortable Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Git Command Centre glyph a purpose-built hover tooltip (merge / remote-only / trunk / cluster get real variants; task / commit get "who" + relative time + actions) and make the Pipeline table sortable with a status-priority default.

**Architecture:** All tooltip *content logic* and all *sort logic* move into two new pure, unit-tested modules (`git-tooltip-data.ts`, `git-pipeline-sort.ts`) — no React, no canvas — mirroring the existing `git-arc-hit.ts` / `git-arc-labels.ts` pattern. `GitHoverCard.tsx` gains four new card variants + enrichments and renders off the `HoveredNode` union. `git-arc-hit.ts` extends the `showMore` hit target to carry the cluster's branch names; `GitGraphCanvas.resolveTarget` maps the new targets (trunkLine → trunk summary, showMore → cluster peek on hover while click still → Pipeline, remote-only split from plain_tip). `GitPipelineView.tsx` becomes sortable; `GitGraphCanvas.visibleBranches` gets recency-sort + cap on its filtered views.

**Tech Stack:** React 19 + Vite + Canvas 2D, TypeScript (strict), Vitest 3 + jsdom, esbuild harness. Helpers already present: `relativeTime` (`ui/src/lib/utils.ts`), `issueStatusText` (`ui/src/lib/status-colors.ts`).

**Locked design decisions (from approved mock `~/Desktop/git-tooltip-mocks.html`):**
1. "who" = `branch.lastCommitAuthor` (git author proxy, NO server enrichment).
2. Pipeline default sort = status priority (`blocked → in_review → in_progress → todo → backlog → done → cancelled`) then most-recent activity.
3. Rich tooltip density approved (keep the 5-step pipeline, ahead/behind, CI/PR, actions).

**Out of scope (data not available without backend work — do NOT attempt):**
- Tag *annotation message* / "release" flag — `HoveredNode.tag` only carries `{name, sha, date}`. Keep the Tag card lean (name + points-to sha + date).
- Agent-vs-human *identity* — proxy only shows the git author string; no agent badge enrichment.

---

## Eng-Review Amendments (apply these during build — they override the base phases below)

The plan-eng-review pass produced four decisions. Apply each on top of the corresponding phase.

### A1 (from D3) — Single-source the pipeline-stage rule (kills triplication)

In **Phase 1** add to `git-tooltip-data.ts`:

```ts
export const STAGE_LABELS = ["Changes", "Committed", "Pushed", "PR", "Merged"] as const;

/** Branch → pipeline stage index 0..4. SINGLE SOURCE for the tooltip pipeline
 * steps, the GitPipelineView dots, and the sort "pipeline" key. */
export function pipelineStageRank(b: GitBranchInfo): number {
  if (b.pr?.reviewState === "merged") return 4;
  if (b.pr) return 3;
  if (b.isRemote && b.aheadCount === 0) return 2;
  if (b.aheadCount > 0) return 1;
  return 0;
}
```

Add to `GitTooltipData.test.ts`:

```ts
import { pipelineStageRank } from "../components/workspace/git-tooltip-data";
describe("pipelineStageRank", () => {
  it("maps each stage", () => {
    expect(pipelineStageRank(mkBranch({ name: "x" }))).toBe(0); // dirty
    expect(pipelineStageRank(mkBranch({ name: "x", aheadCount: 2 }))).toBe(1); // committed
    expect(pipelineStageRank(mkBranch({ name: "x", isRemote: true, aheadCount: 0 }))).toBe(2); // pushed
    expect(pipelineStageRank(mkBranch({ name: "x", pr: { number: 1, url: "", reviewState: "open", ciStatus: null, ciUrl: null, commentCount: 0, labels: [] } }))).toBe(3); // pr
    expect(pipelineStageRank(mkBranch({ name: "x", pr: { number: 1, url: "", reviewState: "merged", ciStatus: null, ciUrl: null, commentCount: 0, labels: [] } }))).toBe(4); // merged
  });
});
```

In **Phase 2** `git-pipeline-sort.ts`, delete the local `pipelineRank` and import the shared one:

```ts
import { pipelineStageRank } from "./git-tooltip-data";
// ...in compareBranches: case "pipeline": r = pipelineStageRank(a) - pipelineStageRank(b); break;
```

In **Phase 3** `GitHoverCard.tsx`, replace the existing `deriveStage` body so it derives from the rank (single source):

```ts
import { pipelineStageRank, parseMergeMessage, commitBranchContext, type TrunkSummary } from "./git-tooltip-data";
const STAGE_NAMES: GitPipelineStage[] = ["dirty", "committed", "pushed", "pr_open", "merged"];
function deriveStage(branch: GitBranchInfo): GitPipelineStage {
  return STAGE_NAMES[pipelineStageRank(branch)]!;
}
```

In **Phase 5** `GitPipelineView.tsx`, replace `PipelineDots`'s inline `activeIdx` IIFE with `const activeIdx = pipelineStageRank(branch);` and `import { pipelineStageRank } from "./git-tooltip-data";`.

### A2 (from D2) — Memoize the trunk summary (no per-mousemove recompute)

In **Phase 4 / GitGraphCanvas.tsx**, add a memo beside the other memos:

```tsx
const trunkSummary = useMemo(() => buildTrunkSummary(graph, branches), [graph, branches]);
```

Add `trunkSummary: TrunkSummary` as the last param of `resolveTarget`; its `trunkLine` case uses the passed value instead of calling `buildTrunkSummary`:

```tsx
    case "trunkLine": {
      const b = branchByName.get(graph.defaultBranch) ?? null;
      return { hover: { type: "trunk", branch: b, summary: trunkSummary }, showMore: false };
    }
```

Both `handleMouseMove` and `handleClick` pass `trunkSummary` into `resolveTarget(...)`, and add `trunkSummary` to their `useCallback` dependency arrays. Import `TrunkSummary` type from `./git-tooltip-data` (drop the `buildTrunkSummary` call from inside `resolveTarget`; keep the import for the memo).

### A3 (from D4) — Full wiring-layer tests

1. **Export `resolveTarget`** in `GitGraphCanvas.tsx` (change `function resolveTarget` → `export function resolveTarget`). Create `ui/src/__tests__/GitResolveTarget.test.ts` asserting: `trunkLine` → `{type:"trunk"}` with the passed summary; `showMore` (`branchNames:["a","b"]`) → `{type:"cluster", total:2}` AND `showMore:true`; a `plainTip` whose branch is `isLocal:false,isRemote:true` → `{type:"remote_marker"}`; a `merge` → carries `defaultBranch`.
2. **Create `ui/src/__tests__/GitPipelineView.test.tsx`** (uses `@testing-library/react`): render with 3 linked branches of mixed status, assert default order is blocked-first; click the **Status** header twice, assert order flips; assert the **Who** and **Last activity** column headers render.
3. **Extract the recency helper** into `git-pipeline-sort.ts` and test it:

```ts
export function sortByRecency(branches: GitBranchInfo[], cap: number): GitBranchInfo[] {
  return [...branches]
    .sort((a, b) => (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? ""))
    .slice(0, cap);
}
```

In **Phase 6**, `visibleBranches` imports and uses `sortByRecency(arr, MAX_DEFAULT_BRANCHES)` instead of the inline `byRecency`. Add a `GitPipelineSort.test.ts` case for `sortByRecency` (newest-first + respects cap) and cases asserting the `pipeline`, `who`, and `id` sort keys order correctly.

### A4 (fold-ins, no decision needed)

- **Phase 5**: wrap the sorted row groups in `useMemo` keyed on `[linked, unlinked, sortKey, sortDir]` so they don't re-sort on unrelated re-renders.
- **Phase 3**: add a `GitHoverCard.test.tsx` case for the **commit** variant asserting the relative-time text and the `on <branch>` context line render.

---

## File Structure

| File | Responsibility | New? |
|------|----------------|------|
| `ui/src/components/workspace/git-tooltip-data.ts` | Pure tooltip-content helpers: merge-message parse, remote-only test, trunk summary, commit branch context | **Create** |
| `ui/src/components/workspace/git-pipeline-sort.ts` | Pure pipeline sort: `STATUS_PRIORITY`, `SortKey`, `compareBranches`, `sortBranches` | **Create** |
| `ui/src/__tests__/GitTooltipData.test.ts` | Unit tests for `git-tooltip-data.ts` | **Create** |
| `ui/src/__tests__/GitPipelineSort.test.ts` | Unit tests for `git-pipeline-sort.ts` | **Create** |
| `ui/src/__tests__/GitHoverCard.test.tsx` | Render tests for each `GitHoverCard` variant (+ commit-enrich, A4) | **Create** |
| `ui/src/__tests__/GitResolveTarget.test.ts` | Unit tests for exported `resolveTarget` mapping (A3) | **Create** |
| `ui/src/__tests__/GitPipelineView.test.tsx` | Render + click-to-sort integration tests (A3) | **Create** |
| `ui/src/components/workspace/GitHoverCard.tsx` | `HoveredNode` union + card variants (4 new, 2 enriched) + `onOpenPipeline` prop | Modify |
| `ui/src/components/workspace/git-arc-hit.ts` | `showMore` HitTarget carries `branchNames` | Modify |
| `ui/src/__tests__/GitArcHit.test.ts` | Update `showMore` assertions to include `branchNames` | Modify |
| `ui/src/components/workspace/GitGraphCanvas.tsx` | `resolveTarget` wiring (trunk/cluster/remote) + `visibleBranches` filtered sort+cap | Modify |
| `ui/src/components/workspace/GitCommandCentre.tsx` | Pass `onOpenPipeline` to `GitHoverCard` | Modify |
| `ui/src/components/workspace/GitPipelineView.tsx` | Sortable headers + default sort + Who/Last-activity columns | Modify |

---

## Phase 0 — Clean baseline (commit the existing review fixes)

The working tree currently has 5 verified-but-uncommitted review fixes (2 P1 hover-correctness bugs + 3 P2s + 2 regression tests) from the prior `/review` pass. Commit them first so this feature starts from a clean baseline.

### Task 0: Commit review fixes

**Files:** (already modified, no new edits)
- `ui/src/components/workspace/git-arc-hit.ts`
- `ui/src/components/workspace/git-arc-layout.ts`
- `ui/src/components/workspace/GitGraphCanvas.tsx`
- `ui/src/__tests__/GitArcHit.test.ts`

- [ ] **Step 1: Confirm green before committing**

Run: `cd ui && npx tsc -b && npx vitest run src/__tests__/GitArcHit.test.ts src/__tests__/GitArcLayout.test.ts`
Expected: tsc exit 0; vitest all pass (GitArcHit 16 tests, GitArcLayout 52 tests).

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/workspace/git-arc-hit.ts ui/src/components/workspace/git-arc-layout.ts ui/src/components/workspace/GitGraphCanvas.tsx ui/src/__tests__/GitArcHit.test.ts
git commit -m "$(cat <<'EOF'
fix(git-map): hover-registry review fixes (tag per-pill, label parity, lane clamp, memo)

- emit one tag hit rect per drawn pill (2nd pill reported tags[0])
- gate cardBranchNames add on isTaskTip && taskVisible (label-shift parity)
- clamp arc lane to MAX_LANES-1 (was allowing a 6th lane)
- layout memo depends on includeDone, not raw filter
- +2 regression tests

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

Expected: commit succeeds (pre-commit hook passes).

---

## Phase 1 — Pure tooltip-data helpers (TDD)

### Task 1: `git-tooltip-data.ts` + tests

**Files:**
- Create: `ui/src/components/workspace/git-tooltip-data.ts`
- Test: `ui/src/__tests__/GitTooltipData.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/__tests__/GitTooltipData.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { GitBranchInfo, GitCommitNode, GitGraphData } from "@armyofagents/shared";
import {
  parseMergeMessage,
  isRemoteOnly,
  buildTrunkSummary,
  commitBranchContext,
} from "../components/workspace/git-tooltip-data";

function mkBranch(p: Partial<GitBranchInfo> & { name: string }): GitBranchInfo {
  return {
    name: p.name, isLocal: p.isLocal ?? true, isRemote: p.isRemote ?? true,
    aheadCount: p.aheadCount ?? 0, behindCount: p.behindCount ?? 0,
    lastCommitSha: p.lastCommitSha ?? "s", lastCommitMessage: "", lastCommitAt: p.lastCommitAt ?? "",
    lastCommitAuthor: p.lastCommitAuthor ?? "", linkedWorkspaceId: null,
    linkedIssueId: p.linkedIssueId ?? null, linkedIssueIdentifier: null, linkedIssueTitle: null,
    linkedIssueStatus: p.linkedIssueStatus ?? null, linkedIssueWorkMode: null, pr: null,
    overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: [],
  };
}
function mkCommit(p: Partial<GitCommitNode> & { sha: string }): GitCommitNode {
  return {
    sha: p.sha, parentShas: p.parentShas ?? [], shortSha: p.sha.slice(0, 7),
    message: p.message ?? "", author: p.author ?? "", committedAt: p.committedAt ?? "",
    branchNames: p.branchNames ?? [], isMerge: p.isMerge ?? false, tags: p.tags ?? [],
  };
}

describe("parseMergeMessage", () => {
  it("parses a GitHub PR merge (#num + source)", () => {
    expect(parseMergeMessage("Merge pull request #98 from MeteoriteLabs/feat/login-flow", "main"))
      .toEqual({ source: "feat/login-flow", target: "main", prNumber: 98 });
  });
  it("parses a CLI branch merge with explicit target", () => {
    expect(parseMergeMessage("Merge branch 'feat/x' into develop", "main"))
      .toEqual({ source: "feat/x", target: "develop", prNumber: null });
  });
  it("parses a CLI branch merge without target (defaults to defaultBranch)", () => {
    expect(parseMergeMessage("Merge branch 'feat/x'", "main"))
      .toEqual({ source: "feat/x", target: "main", prNumber: null });
  });
  it("returns nulls for an unrecognized message", () => {
    expect(parseMergeMessage("squash everything", "main"))
      .toEqual({ source: null, target: null, prNumber: null });
  });
});

describe("isRemoteOnly", () => {
  it("true when remote and not local", () => {
    expect(isRemoteOnly(mkBranch({ name: "x", isLocal: false, isRemote: true }))).toBe(true);
  });
  it("false when local", () => {
    expect(isRemoteOnly(mkBranch({ name: "x", isLocal: true, isRemote: true }))).toBe(false);
  });
});

describe("buildTrunkSummary", () => {
  const graph: GitGraphData = {
    commits: [
      mkCommit({ sha: "c2", author: "A" }),
      mkCommit({ sha: "c1", author: "B" }),
      mkCommit({ sha: "c0", author: "A" }),
    ],
    branches: [
      { name: "main", laneIndex: 0, color: "#000", tipSha: "c2" },
      { name: "feat/x", laneIndex: 1, color: "#111", tipSha: "c1" },
    ],
    defaultBranch: "main",
  };
  it("counts commits, unique authors, active (non-default, non-done) branches, and resolves the tip commit", () => {
    const branches = [
      mkBranch({ name: "main" }),
      mkBranch({ name: "feat/x", linkedIssueStatus: "in_progress" }),
      mkBranch({ name: "feat/done", linkedIssueStatus: "done" }),
    ];
    const s = buildTrunkSummary(graph, branches);
    expect(s.commitCount).toBe(3);
    expect(s.contributorCount).toBe(2);          // A, B
    expect(s.activeBranchCount).toBe(1);         // feat/x only (main excluded, feat/done excluded)
    expect(s.latestCommit?.sha).toBe("c2");      // main's tipSha
  });
});

describe("commitBranchContext", () => {
  it("returns the first branch name when present", () => {
    expect(commitBranchContext(mkCommit({ sha: "c1", branchNames: ["feat/a", "feat/b"] }))).toBe("feat/a");
  });
  it("returns null for an interior commit", () => {
    expect(commitBranchContext(mkCommit({ sha: "c1", branchNames: [] }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/__tests__/GitTooltipData.test.ts`
Expected: FAIL — "Failed to resolve import ../components/workspace/git-tooltip-data".

- [ ] **Step 3: Write the implementation**

Create `ui/src/components/workspace/git-tooltip-data.ts`:

```ts
/**
 * git-tooltip-data.ts — pure content helpers for GitHoverCard.
 *
 * No React, no canvas — fully unit-testable. Both the merge/trunk/remote
 * tooltip variants and any future consumer derive their display data here so
 * the logic has a single source.
 */
import type { GitBranchInfo, GitCommitNode, GitGraphData } from "@armyofagents/shared";

export interface MergeInfo {
  /** Branch merged IN (the source), or null if unparseable. */
  source: string | null;
  /** Branch merged INTO (the target); falls back to defaultBranch. */
  target: string | null;
  /** GitHub PR number when the message is a PR merge, else null. */
  prNumber: number | null;
}

/** Parse a git merge commit message into source/target/PR. Best-effort; the
 * three forms below cover GitHub squash/merge + CLI merges. Unknown → all null. */
export function parseMergeMessage(message: string, defaultBranch: string): MergeInfo {
  const pr = message.match(/Merge pull request #(\d+) from \S+?\/(\S+)/);
  if (pr) return { source: pr[2]!, target: defaultBranch, prNumber: Number(pr[1]) };

  const rt = message.match(/Merge remote-tracking branch '([^']+)'(?:\s+into\s+'?([^'\s]+)'?)?/);
  if (rt) return { source: rt[1]!, target: rt[2] ?? defaultBranch, prNumber: null };

  const br = message.match(/Merge branch '([^']+)'(?:\s+into\s+'?([^'\s]+)'?)?/);
  if (br) return { source: br[1]!, target: br[2] ?? defaultBranch, prNumber: null };

  return { source: null, target: null, prNumber: null };
}

/** A branch that exists on the remote but is not checked out locally. */
export function isRemoteOnly(b: GitBranchInfo): boolean {
  return b.isRemote && !b.isLocal;
}

export interface TrunkSummary {
  commitCount: number;
  contributorCount: number;
  /** Non-default branches that are not done/cancelled. */
  activeBranchCount: number;
  latestCommit: GitCommitNode | null;
}

/** Default-branch summary for the trunk-line tooltip. */
export function buildTrunkSummary(graph: GitGraphData, branches: GitBranchInfo[]): TrunkSummary {
  const authors = new Set<string>();
  for (const c of graph.commits) if (c.author) authors.add(c.author);
  const isDone = (s: string | null) => s === "done" || s === "cancelled";
  const activeBranchCount = branches.filter(
    (b) => b.name !== graph.defaultBranch && !isDone(b.linkedIssueStatus),
  ).length;
  const tipSha = graph.branches.find((b) => b.name === graph.defaultBranch)?.tipSha;
  const latestCommit =
    (tipSha ? graph.commits.find((c) => c.sha === tipSha) : undefined) ?? graph.commits[0] ?? null;
  return { commitCount: graph.commits.length, contributorCount: authors.size, activeBranchCount, latestCommit };
}

/** Which branch a commit sits on (first tip name), or null for interior commits. */
export function commitBranchContext(commit: GitCommitNode): string | null {
  return commit.branchNames.length > 0 ? commit.branchNames[0]! : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/__tests__/GitTooltipData.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd ui && npx tsc -b
git add ui/src/components/workspace/git-tooltip-data.ts ui/src/__tests__/GitTooltipData.test.ts
git commit -m "$(cat <<'EOF'
feat(git-map): pure tooltip-data helpers (merge parse, remote-only, trunk summary)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

Expected: tsc exit 0; commit succeeds.

---

## Phase 2 — Pure pipeline-sort helpers (TDD)

### Task 2: `git-pipeline-sort.ts` + tests

**Files:**
- Create: `ui/src/components/workspace/git-pipeline-sort.ts`
- Test: `ui/src/__tests__/GitPipelineSort.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/__tests__/GitPipelineSort.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { GitBranchInfo } from "@armyofagents/shared";
import { statusRank, sortBranches, DEFAULT_DIR } from "../components/workspace/git-pipeline-sort";

function b(name: string, status: string | null, at: string, ahead = 0): GitBranchInfo {
  return {
    name, isLocal: true, isRemote: true, aheadCount: ahead, behindCount: 0,
    lastCommitSha: "s", lastCommitMessage: "", lastCommitAt: at, lastCommitAuthor: name[0]!,
    linkedWorkspaceId: null, linkedIssueId: status ? "i" : null, linkedIssueIdentifier: null,
    linkedIssueTitle: null, linkedIssueStatus: status, linkedIssueWorkMode: null, pr: null,
    overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: [],
  };
}

describe("statusRank", () => {
  it("orders blocked < in_review < in_progress < todo < done", () => {
    expect(statusRank("blocked")).toBeLessThan(statusRank("in_review"));
    expect(statusRank("in_review")).toBeLessThan(statusRank("in_progress"));
    expect(statusRank("in_progress")).toBeLessThan(statusRank("todo"));
    expect(statusRank("todo")).toBeLessThan(statusRank("done"));
  });
  it("unknown status ranks between todo and done", () => {
    expect(statusRank("weird")).toBeGreaterThan(statusRank("todo"));
    expect(statusRank("weird")).toBeLessThan(statusRank("done"));
  });
});

describe("sortBranches — default (status priority, then recency)", () => {
  it("blocked first, then in_review, then in_progress by recency desc", () => {
    const list = [
      b("ip-old", "in_progress", "2026-01-01"),
      b("ip-new", "in_progress", "2026-05-01"),
      b("rev", "in_review", "2026-02-01"),
      b("blk", "blocked", "2026-01-01"),
    ];
    const out = sortBranches(list, "status", DEFAULT_DIR.status).map((x) => x.name);
    expect(out).toEqual(["blk", "rev", "ip-new", "ip-old"]);
  });
});

describe("sortBranches — activity desc puts newest first", () => {
  it("sorts by lastCommitAt descending", () => {
    const list = [b("a", "todo", "2026-01-01"), b("c", "todo", "2026-05-01"), b("b", "todo", "2026-03-01")];
    expect(sortBranches(list, "activity", DEFAULT_DIR.activity).map((x) => x.name)).toEqual(["c", "b", "a"]);
  });
});

describe("sortBranches — does not mutate input", () => {
  it("returns a new array", () => {
    const list = [b("a", "todo", "2026-01-01"), b("b", "blocked", "2026-01-01")];
    const copy = [...list];
    sortBranches(list, "status", DEFAULT_DIR.status);
    expect(list).toEqual(copy);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/__tests__/GitPipelineSort.test.ts`
Expected: FAIL — cannot resolve `../components/workspace/git-pipeline-sort`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/components/workspace/git-pipeline-sort.ts`:

```ts
/**
 * git-pipeline-sort.ts — pure sort logic for the Git Command Centre Pipeline.
 *
 * No React. The default ("status") puts what-needs-you first (blocked → review
 * → in-progress …), tie-broken by most-recent activity, per the locked design.
 */
import type { GitBranchInfo } from "@armyofagents/shared";

export type SortKey = "status" | "pipeline" | "ahead" | "who" | "activity" | "id";
export type SortDir = "asc" | "desc";

/** Lower = higher priority (rendered first) under the default status sort. */
export const STATUS_PRIORITY: Record<string, number> = {
  blocked: 0, in_review: 1, in_progress: 2, todo: 3, backlog: 4, done: 6, cancelled: 7,
};
/** Unknown statuses sort between todo/backlog and done. */
const STATUS_UNKNOWN = 5;

/** Per-column natural starting direction when a header is first clicked. */
export const DEFAULT_DIR: Record<SortKey, SortDir> = {
  status: "asc", pipeline: "desc", ahead: "desc", who: "asc", activity: "desc", id: "asc",
};

export function statusRank(status: string | null): number {
  if (status != null && status in STATUS_PRIORITY) return STATUS_PRIORITY[status]!;
  return STATUS_UNKNOWN;
}

function pipelineRank(b: GitBranchInfo): number {
  if (b.pr?.reviewState === "merged") return 4;
  if (b.pr) return 3;
  if (b.isRemote && b.aheadCount === 0) return 2;
  if (b.aheadCount > 0) return 1;
  return 0;
}

function activityMs(b: GitBranchInfo): number {
  const t = new Date(b.lastCommitAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

export function compareBranches(a: GitBranchInfo, b: GitBranchInfo, key: SortKey, dir: SortDir): number {
  let r = 0;
  switch (key) {
    case "status": r = statusRank(a.linkedIssueStatus) - statusRank(b.linkedIssueStatus); break;
    case "pipeline": r = pipelineRank(a) - pipelineRank(b); break;
    case "ahead": r = (a.aheadCount - a.behindCount) - (b.aheadCount - b.behindCount); break;
    case "who": r = (a.lastCommitAuthor ?? "").localeCompare(b.lastCommitAuthor ?? ""); break;
    case "activity": r = activityMs(a) - activityMs(b); break;
    case "id": r = (a.linkedIssueIdentifier ?? a.name).localeCompare(b.linkedIssueIdentifier ?? b.name); break;
  }
  const primary = dir === "asc" ? r : -r;
  if (primary !== 0) return primary;
  // Stable tie-break: most-recent activity desc, then name (direction-independent).
  const byRecency = activityMs(b) - activityMs(a);
  if (byRecency !== 0) return byRecency;
  return a.name.localeCompare(b.name);
}

export function sortBranches(branches: GitBranchInfo[], key: SortKey, dir: SortDir): GitBranchInfo[] {
  return [...branches].sort((a, b) => compareBranches(a, b, key, dir));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/__tests__/GitPipelineSort.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd ui && npx tsc -b
git add ui/src/components/workspace/git-pipeline-sort.ts ui/src/__tests__/GitPipelineSort.test.ts
git commit -m "$(cat <<'EOF'
feat(git-map): pure pipeline sort (status-priority default + per-column compare)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

Expected: tsc exit 0; commit succeeds.

---

## Phase 3 — GitHoverCard: new variants + enrichments

### Task 3: Extend `HoveredNode` + add/enrich card variants

**Files:**
- Modify: `ui/src/components/workspace/GitHoverCard.tsx`
- Test: `ui/src/__tests__/GitHoverCard.test.tsx`

- [ ] **Step 1: Write the failing render test**

Create `ui/src/__tests__/GitHoverCard.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { GitBranchInfo, GitCommitNode } from "@armyofagents/shared";
import { GitHoverCard, type HoveredNode } from "../components/workspace/GitHoverCard";

afterEach(cleanup);

function mkBranch(p: Partial<GitBranchInfo> & { name: string }): GitBranchInfo {
  return {
    name: p.name, isLocal: p.isLocal ?? true, isRemote: p.isRemote ?? true,
    aheadCount: p.aheadCount ?? 0, behindCount: p.behindCount ?? 0, lastCommitSha: "s",
    lastCommitMessage: p.lastCommitMessage ?? "msg", lastCommitAt: p.lastCommitAt ?? new Date().toISOString(),
    lastCommitAuthor: p.lastCommitAuthor ?? "Claude", linkedWorkspaceId: null,
    linkedIssueId: p.linkedIssueId ?? null, linkedIssueIdentifier: p.linkedIssueIdentifier ?? null,
    linkedIssueTitle: p.linkedIssueTitle ?? null, linkedIssueStatus: p.linkedIssueStatus ?? null,
    linkedIssueWorkMode: null, pr: p.pr ?? null,
    overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: p.tags ?? [],
  };
}
function mkCommit(p: Partial<GitCommitNode> & { sha: string }): GitCommitNode {
  return {
    sha: p.sha, parentShas: p.parentShas ?? [], shortSha: p.sha.slice(0, 7), message: p.message ?? "",
    author: p.author ?? "Claude", committedAt: p.committedAt ?? new Date().toISOString(),
    branchNames: p.branchNames ?? [], isMerge: p.isMerge ?? false, tags: p.tags ?? [],
  };
}
const pos = { x: 100, y: 100 };

describe("GitHoverCard variants", () => {
  it("task card shows id, author (who), and an Open PR action when a PR exists", () => {
    const branch = mkBranch({
      name: "feat/x", linkedIssueId: "i1", linkedIssueIdentifier: "AOA-7",
      linkedIssueTitle: "Do the thing", linkedIssueStatus: "in_progress", lastCommitAuthor: "Claude",
      pr: { number: 142, url: "https://gh/pr/142", reviewState: "open", ciStatus: "passing", ciUrl: null, commentCount: 0, labels: [] },
    });
    render(<GitHoverCard node={{ type: "task", branch }} position={pos} />);
    expect(screen.getByText("AOA-7")).toBeTruthy();
    expect(screen.getByText(/Claude/)).toBeTruthy();
    expect(screen.getByText(/Open PR/)).toBeTruthy();
  });

  it("merge card shows source → target and PR number", () => {
    const commit = mkCommit({ sha: "m1", isMerge: true, message: "Merge pull request #98 from org/feat/login" });
    render(<GitHoverCard node={{ type: "merge", commit, defaultBranch: "main" }} position={pos} />);
    expect(screen.getByText(/Merge/)).toBeTruthy();
    expect(screen.getByText(/feat\/login/)).toBeTruthy();
    expect(screen.getByText(/#98/)).toBeTruthy();
  });

  it("remote-only card shows the not-checked-out badge and a Pull action", () => {
    const branch = mkBranch({ name: "origin/hotfix", isLocal: false, isRemote: true });
    render(<GitHoverCard node={{ type: "remote_marker", branch }} position={pos} />);
    expect(screen.getByText(/remote only/i)).toBeTruthy();
    expect(screen.getByText(/Pull/)).toBeTruthy();
  });

  it("trunk card shows the default-branch summary counts", () => {
    render(<GitHoverCard node={{
      type: "trunk", branch: mkBranch({ name: "main" }),
      summary: { commitCount: 204, contributorCount: 8, activeBranchCount: 13, latestCommit: mkCommit({ sha: "c2", message: "latest" }) },
    }} position={pos} />);
    expect(screen.getByText(/204 commits/)).toBeTruthy();
    expect(screen.getByText(/13 active/)).toBeTruthy();
  });

  it("cluster card lists branches and a total", () => {
    const branches = [mkBranch({ name: "AOA-21 a", linkedIssueIdentifier: "AOA-21" }), mkBranch({ name: "AOA-30 b", linkedIssueIdentifier: "AOA-30" })];
    render(<GitHoverCard node={{ type: "cluster", branches, total: 86 }} position={pos} />);
    expect(screen.getByText(/86 more branches/)).toBeTruthy();
    expect(screen.getByText(/AOA-21/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/__tests__/GitHoverCard.test.tsx`
Expected: FAIL — `HoveredNode` has no `trunk`/`cluster` members; `merge` has no `defaultBranch`; no "Open PR"/"remote only"/"204 commits" text.

- [ ] **Step 3: Update the `HoveredNode` union + imports**

In `ui/src/components/workspace/GitHoverCard.tsx`, replace the import block (lines 17-27) — add `relativeTime` and the tooltip-data import:

```tsx
import React from "react";
import { createPortal } from "react-dom";
import { cn, relativeTime } from "@/lib/utils";
import { issueStatusText, issueStatusTextDefault } from "@/lib/status-colors";
import { parseMergeMessage, commitBranchContext, type TrunkSummary } from "./git-tooltip-data";
import type {
  GitBranchInfo,
  GitCommitNode,
  GitCIStatus,
  GitPrReviewState,
  GitPipelineStage,
} from "@armyofagents/shared";
```

Replace the `HoveredNode` union (lines 33-39) with:

```tsx
export type HoveredNode =
  | { type: "task"; branch: GitBranchInfo }
  | { type: "commit"; commit: GitCommitNode }
  | { type: "merge"; commit: GitCommitNode; defaultBranch: string }
  | { type: "tag"; name: string; sha: string; date: string }
  | { type: "plain_tip"; branch: GitBranchInfo }
  | { type: "remote_marker"; branch: GitBranchInfo }
  | { type: "trunk"; branch: GitBranchInfo | null; summary: TrunkSummary }
  | { type: "cluster"; branches: GitBranchInfo[]; total: number };
```

Add `onOpenPipeline` to the props interface (after `onMouseLeave` in `GitHoverCardProps`, around line 48):

```tsx
  /** Called when the cluster card's "Open Pipeline" button is clicked. */
  onOpenPipeline?: () => void;
```

- [ ] **Step 4: Enrich `TaskCard` — add the "who" row and an Open PR action**

In `TaskCard`, immediately AFTER the branch-name line (the `<p>` with `{branch.name}`, ~line 228) insert the who row:

```tsx
      {/* Who (git author) + relative time */}
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/80">{branch.lastCommitAuthor || "unknown"}</span>
        {branch.lastCommitAt && <span>· last commit {relativeTime(branch.lastCommitAt)}</span>}
      </div>
```

Then, INSIDE the existing `{branch.linkedIssueId && onOpenTask && (...)}` button block, after the "Open task →" button's closing `</button>`, add an Open PR button (still inside the same conditional is fine, but PR may exist without onOpenTask — so add it as its own block right AFTER that conditional):

```tsx
      {/* Open PR (separate from Open task) */}
      {branch.pr && (
        <a
          href={branch.pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full mt-1.5 py-1 rounded text-xs text-center border border-white/10 text-muted-foreground hover:text-foreground transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          Open PR ↗
        </a>
      )}
```

- [ ] **Step 5: Enrich `CommitCard` — relative time + branch context**

Replace the date span line in `CommitCard` (`<span>{new Date(commit.committedAt).toLocaleDateString()}</span>`, ~line 297) with:

```tsx
        <span>{commit.committedAt ? relativeTime(commit.committedAt) : ""}</span>
```

And immediately after the author/date `</div>` (before the tags block), insert:

```tsx
      {commitBranchContext(commit) && (
        <p className="text-[11px] text-muted-foreground">on <span className="font-mono text-foreground/70">{commitBranchContext(commit)}</span></p>
      )}
```

- [ ] **Step 6: Add `MergeCard`, `RemoteCard`, `TrunkCard`, `ClusterCard`**

Insert these four components after `TagCard` (before the "Main component" section, ~line 356):

```tsx
function MergeCard({ commit, defaultBranch }: { commit: GitCommitNode; defaultBranch: string }) {
  const m = parseMergeMessage(commit.message, defaultBranch);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-[#6470DC]">⑃ Merge</div>
      {m.source && (
        <div className="flex items-center gap-1.5 font-mono text-xs">
          <span className="text-foreground/80">{m.source}</span>
          <span className="text-muted-foreground">→</span>
          <span className="text-[#4FB67E]">{m.target}</span>
        </div>
      )}
      <p className="text-sm font-medium leading-snug">{commit.message}</p>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>
          {m.prNumber != null && <span className="text-blue-400 font-mono">PR #{m.prNumber} · </span>}
          <span className="font-mono">{commit.shortSha}</span>
        </span>
        <span>{commit.committedAt ? relativeTime(commit.committedAt) : ""}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">by {commit.author || "unknown"}</p>
    </div>
  );
}

function RemoteCard({ branch }: { branch: GitBranchInfo }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-mono font-medium">{branch.name}</p>
      <span className="inline-block text-[10px] px-1.5 py-0.5 rounded border border-dashed border-[#5a6172] text-muted-foreground">
        remote only · not checked out
      </span>
      <p className="text-[11px] text-muted-foreground leading-snug truncate mt-1">{branch.lastCommitMessage}</p>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{branch.lastCommitAuthor || "unknown"}</span>
        <span>{branch.lastCommitAt ? relativeTime(branch.lastCommitAt) : ""}</span>
      </div>
      <p className="text-[11px] text-muted-foreground/70 pt-1">Pull to work on it locally</p>
    </div>
  );
}

function TrunkCard({ branch, summary }: { branch: GitBranchInfo | null; summary: TrunkSummary }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-mono font-medium text-sm text-[#4FB67E]">{branch?.name ?? "main"}</span>
        <span className="text-[10px] text-muted-foreground">default</span>
      </div>
      {summary.latestCommit && (
        <>
          <p className="text-[13px] font-medium leading-snug truncate">{summary.latestCommit.message}</p>
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span className="font-mono">{summary.latestCommit.shortSha}</span>
            <span>{summary.latestCommit.committedAt ? `updated ${relativeTime(summary.latestCommit.committedAt)}` : ""}</span>
          </div>
        </>
      )}
      <div className="pt-1 mt-1 border-t border-white/10 text-[11px] text-muted-foreground">
        {summary.commitCount} commits · {summary.contributorCount} contributors · {summary.activeBranchCount} active branches
      </div>
    </div>
  );
}

function ClusterCard({ branches, total, onOpenPipeline }: { branches: GitBranchInfo[]; total: number; onOpenPipeline?: () => void }) {
  const shown = branches.slice(0, 8);
  const dotColor = (s: string | null) =>
    s === "blocked" ? "#ef4444" : s === "in_review" ? "#D9A938" : s === "in_progress" ? "#4FB67E" : "#5a6172";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{total} more branches</span>
        <span className="text-[10px] text-muted-foreground">at this commit</span>
      </div>
      <div className="mt-1 max-h-[150px] overflow-auto border-t border-white/10 pt-1.5 space-y-0.5">
        {shown.map((b) => (
          <div key={b.name} className="flex items-center gap-2 text-xs py-0.5">
            <span className="w-1.5 h-1.5 rounded-full flex-none" style={{ background: dotColor(b.linkedIssueStatus) }} />
            <span className="font-mono text-[11px] truncate">{b.linkedIssueIdentifier ?? b.name}</span>
            {b.lastCommitAt && <span className="ml-auto text-[10px] text-muted-foreground">{relativeTime(b.lastCommitAt)}</span>}
          </div>
        ))}
        {branches.length > shown.length && (
          <div className="text-[10px] text-muted-foreground pl-3">…and {branches.length - shown.length} more</div>
        )}
      </div>
      {onOpenPipeline && (
        <button
          className="w-full mt-1 py-1 rounded text-xs bg-[#6470DC]/20 hover:bg-[#6470DC]/30 text-[#6470DC] transition-colors"
          onClick={(e) => { e.stopPropagation(); onOpenPipeline(); }}
        >
          Open all {total} in Pipeline →
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Route the new variants in the main component**

Update the `GitHoverCard` function signature to accept `onOpenPipeline`:

```tsx
export function GitHoverCard({ node, position, onOpenTask, onOpenPipeline, onMouseEnter, onMouseLeave }: GitHoverCardProps) {
```

Replace the variant-dispatch block (the `{node.type === ...}` chain, ~lines 381-392) with:

```tsx
        {node.type === "task" && <TaskCard branch={node.branch} onOpenTask={onOpenTask} />}
        {node.type === "commit" && <CommitCard commit={node.commit} />}
        {node.type === "merge" && <MergeCard commit={node.commit} defaultBranch={node.defaultBranch} />}
        {node.type === "tag" && <TagCard name={node.name} sha={node.sha} date={node.date} />}
        {node.type === "plain_tip" && <PlainTipCard branch={node.branch} />}
        {node.type === "remote_marker" && <RemoteCard branch={node.branch} />}
        {node.type === "trunk" && <TrunkCard branch={node.branch} summary={node.summary} />}
        {node.type === "cluster" && <ClusterCard branches={node.branches} total={node.total} onOpenPipeline={onOpenPipeline} />}
```

Note: `isRemoteOnly` is intentionally NOT imported here — the remote-vs-plain split happens in `resolveTarget` (Phase 4, `GitGraphCanvas.tsx`), so `RemoteCard` just renders whatever `remote_marker` node it is handed.

- [ ] **Step 8: Run render tests + typecheck**

Run: `cd ui && npx vitest run src/__tests__/GitHoverCard.test.tsx && npx tsc -b`
Expected: vitest 5 tests PASS; tsc exit 0.

- [ ] **Step 9: Commit**

```bash
git add ui/src/components/workspace/GitHoverCard.tsx ui/src/__tests__/GitHoverCard.test.tsx
git commit -m "$(cat <<'EOF'
feat(git-map): tooltip variants — merge/remote/trunk/cluster + task/commit enrich

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Hit-registry payload + resolveTarget wiring

### Task 4: `showMore` carries branch names; resolveTarget maps trunk/cluster/remote

**Files:**
- Modify: `ui/src/components/workspace/git-arc-hit.ts`
- Modify: `ui/src/__tests__/GitArcHit.test.ts`
- Modify: `ui/src/components/workspace/GitGraphCanvas.tsx`

- [ ] **Step 1: Update the failing test first (showMore payload)**

In `ui/src/__tests__/GitArcHit.test.ts`, the two `showMore` assertions currently read `toEqual({ kind: "showMore" })`. Change BOTH to include the branch names the stack carries.

In the test "emits a showMore rect for a stack with extra branches…" (the stack `branchNames: ["a","b","c","d","e"]`), change:

```ts
    expect(hitRegionAt(regions, 500 + 50 + 27, 200 + 8 + 7)).toEqual({ kind: "showMore", branchNames: ["a", "b", "c", "d", "e"] });
```

In the test "a stack with absorbed plain branches (extraNames) still emits a showMore pill" (stack `branchNames: ["a","b"], extraNames: ["p1","p2","p3"]`), change:

```ts
    expect(hitRegionAt(regions, 500 + 50 + 27, 200 + 8 + 7)).toEqual({ kind: "showMore", branchNames: ["a", "b", "p1", "p2", "p3"] });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/__tests__/GitArcHit.test.ts`
Expected: FAIL — received `{ kind: "showMore" }`, expected the object with `branchNames`.

- [ ] **Step 3: Extend the `HitTarget` type + emit the names**

In `ui/src/components/workspace/git-arc-hit.ts`, change the `showMore` member of `HitTarget` (currently `| { kind: "showMore" }`) to:

```ts
  | { kind: "showMore"; branchNames: string[] };
```

In `buildHitRegions`, the stack section's showMore push (currently `target: { kind: "showMore" }`) becomes:

```ts
        target: { kind: "showMore", branchNames: [...stack.branchNames, ...(stack.extraNames ?? [])] },
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npx vitest run src/__tests__/GitArcHit.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Wire `resolveTarget` in GitGraphCanvas**

In `ui/src/components/workspace/GitGraphCanvas.tsx`, add to the import from `./git-tooltip-data` (create the import near the other workspace imports, ~line 24):

```tsx
import { buildTrunkSummary, isRemoteOnly } from "./git-tooltip-data";
```

Replace the `plainTip` case (lines 94-97) to split remote-only:

```tsx
    case "plainTip": {
      const b = branchByName.get(target.branchName);
      if (!b) return { hover: null, showMore: false };
      return { hover: { type: isRemoteOnly(b) ? "remote_marker" : "plain_tip", branch: b }, showMore: false };
    }
```

Replace the `merge` case (lines 102-105) to carry defaultBranch:

```tsx
    case "merge": {
      const c = graph.commits.find((x) => x.sha === target.sha);
      return { hover: c ? { type: "merge", commit: c, defaultBranch: graph.defaultBranch } : null, showMore: false };
    }
```

Replace the `trunkLine` case (lines 113-123) to return the trunk summary:

```tsx
    case "trunkLine": {
      const b = branchByName.get(graph.defaultBranch) ?? null;
      const summary = buildTrunkSummary(graph, [...branchByName.values()]);
      return { hover: { type: "trunk", branch: b, summary }, showMore: false };
    }
```

Replace the `showMore` case (lines 124-125) to produce a cluster peek on hover while still signalling showMore for click:

```tsx
    case "showMore": {
      const bs = target.branchNames
        .map((n) => branchByName.get(n))
        .filter((x): x is GitBranchInfo => !!x);
      return { hover: { type: "cluster", branches: bs, total: target.branchNames.length }, showMore: true };
    }
```

- [ ] **Step 6: Verify trunk/cluster no longer reference removed locals**

The old `trunkLine` case used `layoutNodes`/`cx` (the nearest-trunk-node walk). After the replacement those params may be unused in `resolveTarget`. Leave the function signature as-is (callers still pass them) — TypeScript with `noUnusedParameters` would flag a genuinely unused param. If `tsc` reports `cx`/`layoutNodes` unused, prefix with `_` in the signature: `_layoutNodes: ArcCommitLayout[], _cx: number`.

Run: `cd ui && npx tsc -b`
Expected: exit 0 (fix unused-param naming if flagged).

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/workspace/git-arc-hit.ts ui/src/__tests__/GitArcHit.test.ts ui/src/components/workspace/GitGraphCanvas.tsx
git commit -m "$(cat <<'EOF'
feat(git-map): wire trunk/cluster/remote hover targets through resolveTarget

- showMore HitTarget carries the cluster's branch names
- trunkLine -> trunk summary tooltip; showMore -> cluster peek (click still -> Pipeline)
- plainTip splits remote-only from plain_tip

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

### Task 5: Pass `onOpenPipeline` to GitHoverCard

**Files:**
- Modify: `ui/src/components/workspace/GitCommandCentre.tsx`

- [ ] **Step 1: Find the GitHoverCard usage**

Run: `cd ui && grep -n "GitHoverCard" src/components/workspace/GitCommandCentre.tsx`
Expected: a `<GitHoverCard ... />` JSX usage (around line 438) with `node`, `position`, `onOpenTask`, `onMouseEnter`, `onMouseLeave`.

- [ ] **Step 2: Add the prop**

Add `onOpenPipeline={() => setViewMode("pipeline")}` to the `<GitHoverCard>` JSX props (alongside `onOpenTask={onSelectIssue}`).

- [ ] **Step 3: Typecheck**

Run: `cd ui && npx tsc -b`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/workspace/GitCommandCentre.tsx
git commit -m "$(cat <<'EOF'
feat(git-map): cluster tooltip Open-Pipeline button -> setViewMode(pipeline)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Sortable Pipeline

### Task 6: GitPipelineView sortable headers + Who/Last-activity columns

**Files:**
- Modify: `ui/src/components/workspace/GitPipelineView.tsx`

- [ ] **Step 1: Add imports + sort state**

At the top of `GitPipelineView.tsx`, add imports:

```tsx
import { relativeTime } from "@/lib/utils";
import { sortBranches, DEFAULT_DIR, type SortKey, type SortDir } from "./git-pipeline-sort";
```

Inside `GitPipelineView`, after the existing `const [showDone, ...]` / `const [showUnlinked, ...]` state, add:

```tsx
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [sortDir, setSortDir] = useState<SortDir>(DEFAULT_DIR.status);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  };
```

- [ ] **Step 2: Sort the row groups**

Replace the three group derivations (`active`, `done`, `unlinked`) so each is sorted. The `active` group uses the chosen sort; `done`/`unlinked` always sort by recency desc:

```tsx
  const activeRaw = linked.filter(
    (b) => b.linkedIssueStatus !== "done" && b.linkedIssueStatus !== "cancelled",
  );
  const active = sortBranches(activeRaw, sortKey, sortDir);
  const done = sortBranches(
    linked.filter((b) => b.linkedIssueStatus === "done" || b.linkedIssueStatus === "cancelled"),
    "activity", "desc",
  );
  const unlinkedSorted = sortBranches(unlinked, "activity", "desc");
```

Then update the unlinked render (Step 5) to map over `unlinkedSorted` instead of `unlinked`.

- [ ] **Step 3: Make the headers clickable + add a sort indicator helper**

Add this helper component above `GitPipelineView` (after `BranchRow`):

```tsx
function SortHeader({
  label, col, sortKey, sortDir, onSort, align = "left",
}: {
  label: string; col: SortKey; sortKey: SortKey; sortDir: SortDir; onSort: (k: SortKey) => void; align?: "left" | "center";
}) {
  const active = sortKey === col;
  return (
    <th
      className={cn("px-3 py-2 font-normal cursor-pointer select-none hover:text-foreground transition-colors",
        align === "center" ? "text-center" : "text-left", active && "text-foreground")}
      onClick={() => onSort(col)}
    >
      {label}{active && <span className="ml-1 text-[#6470DC]">{sortDir === "asc" ? "▴" : "▾"}</span>}
    </th>
  );
}
```

- [ ] **Step 4: Replace the `<thead>` row**

Replace the entire `<tr>` inside `<thead>` (the ID/Task/Branch/Status/Pipeline/±/PR/CI row) with:

```tsx
            <tr className="border-b border-white/10 text-[11px] text-muted-foreground uppercase tracking-wider">
              <th className="w-1" />
              <SortHeader label="ID" col="id" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <th className="px-3 py-2 text-left font-normal">Task</th>
              <th className="px-3 py-2 text-left font-normal">Branch</th>
              <SortHeader label="Status" col="status" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortHeader label="Pipeline" col="pipeline" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortHeader label="±" col="ahead" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortHeader label="Who" col="who" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortHeader label="Last activity" col="activity" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <th className="px-3 py-2 text-left font-normal">PR</th>
              <th className="px-3 py-2 text-center font-normal">CI</th>
              <th className="px-3 py-2" />
            </tr>
```

(Note: CI stays a plain, non-sortable header — sorting by pipeline stage already orders CI-bearing rows, and reusing the `pipeline` key here would light the active-sort arrow on two headers at once.)

- [ ] **Step 5: Add the two new cells to `BranchRow`**

In `BranchRow`, AFTER the "Ahead/behind" `<td>` (the one with `↑`/`↓`) and BEFORE the "PR badge" `<td>`, insert:

```tsx
      {/* Who (git author) */}
      <td className="px-3 py-2 whitespace-nowrap text-[11px] text-muted-foreground">{branch.lastCommitAuthor || "—"}</td>

      {/* Last activity */}
      <td className="px-3 py-2 whitespace-nowrap text-[11px] text-muted-foreground">
        {branch.lastCommitAt ? relativeTime(branch.lastCommitAt) : "—"}
      </td>
```

Because two columns were added, bump every `colSpan={10}` in the group-separator rows (Show done / Git-only) to `colSpan={12}`.

- [ ] **Step 6: Typecheck**

Run: `cd ui && npx tsc -b`
Expected: exit 0.

- [ ] **Step 7: Run the full UI suite (no regressions)**

Run: `cd ui && npx vitest run`
Expected: all pass (prior 1880 + new GitTooltipData 12 + GitPipelineSort 6 + GitHoverCard 5 ≈ 1903).

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/workspace/GitPipelineView.tsx
git commit -m "$(cat <<'EOF'
feat(git-map): sortable Pipeline — clickable headers, status-priority default, Who + Last-activity columns

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — Map filtered-view sort + cap

### Task 7: Recency sort + cap on running/blocked/prs/merged

**Files:**
- Modify: `ui/src/components/workspace/GitGraphCanvas.tsx`

- [ ] **Step 1: Replace the `visibleBranches` filtered branches**

Replace the `visibleBranches` memo body (the `if (filter === "running") ...` chain, ~lines 166-182). Add a shared recency-sort+cap helper and apply it to every filtered view:

```tsx
    const visibleBranches = useMemo(() => {
      const byRecency = (arr: GitBranchInfo[]) =>
        [...arr]
          .sort((a, b) => (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? ""))
          .slice(0, MAX_DEFAULT_BRANCHES);
      if (filter === "running") return byRecency(branches.filter((b) => b.linkedIssueStatus === "in_progress"));
      if (filter === "blocked") return byRecency(branches.filter((b) => b.linkedIssueStatus === "blocked"));
      if (filter === "prs")     return byRecency(branches.filter((b) => !!b.pr));
      if (filter === "merged")  return byRecency(branches.filter(
        (b) => b.linkedIssueStatus === "done" || b.linkedIssueStatus === "cancelled",
      ));
      // default "all"
      const isDone = (b: GitBranchInfo) =>
        b.linkedIssueStatus === "done" || b.linkedIssueStatus === "cancelled";
      const trunk = branches.filter((b) => b.name === graph.defaultBranch);
      const rest = byRecency(branches.filter((b) => b.name !== graph.defaultBranch && !isDone(b)));
      return [...trunk, ...rest];
    }, [branches, filter, graph.defaultBranch]);
```

(Rationale: filtered chips were unsorted + uncapped. Recency-sort + the same `MAX_DEFAULT_BRANCHES` cap keeps the Map an overview; the Pipeline tab + density hint already cover the full list. The default "all" view's behavior is unchanged in effect — it just reuses the helper.)

- [ ] **Step 2: Typecheck + full suite**

Run: `cd ui && npx tsc -b && npx vitest run`
Expected: tsc exit 0; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/workspace/GitGraphCanvas.tsx
git commit -m "$(cat <<'EOF'
feat(git-map): recency-sort + cap the Map's running/blocked/prs/merged filter views

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 7 — Live verification (browser)

### Task 8: Tooltip + sort probe on real repos

The AoA-2.5 UI dev server runs on **localhost:5176** (5173-5175 are taken by an unrelated project). Three projects exercise different topologies: **Engineering** (TK-Website, broom), **SeaMaster (Map demo)** (124 branches, up+down arcs + merges + cluster), **AoA Codebase (Map demo)** (99 branches, fan). Use `/browse`.

- [ ] **Step 1: Rebuild the esbuild harness (sanity — imports compile)**

Run: `cd ui && npx esbuild dev-harness/arc-harness.ts --bundle --format=iife --outfile=dev-harness/arc-harness.bundle.js`
Expected: "Done"; non-zero file size. (Do NOT `git add` the bundle — it is gitignored.)

- [ ] **Step 2: Trunk tooltip** — hover the trunk line on the SeaMaster demo Map; assert the tooltip shows "N commits · N contributors · N active branches".

```
$B goto "http://localhost:5176/AOA/projects/seamaster-map-demo/workspaces"
$B js "(()=>{const c=document.querySelector('canvas');c.dispatchEvent(new MouseEvent('mousemove',{clientX:400,clientY:551,bubbles:true}));return c.style.cursor;})()"   # expect "pointer"
# then screenshot and confirm the trunk summary card renders
$B screenshot /tmp/probe-trunk.png
```
Expected: cursor `pointer`; a portal tooltip with the trunk summary line.

- [ ] **Step 3: Merge tooltip** — hover a merge diamond on the SeaMaster Map; confirm "⑃ Merge" + `source → target` render (not a plain commit card).

- [ ] **Step 4: Cluster peek** — hover the "+N more" pill (do NOT click); confirm a branch-list tooltip appears. Then click it; confirm `canvasCount === 0` (switched to Pipeline).

- [ ] **Step 5: Remote-only** — hover a remote-only branch tip (a branch with `isLocal=false`); confirm the "remote only · not checked out" badge + "Pull" line. (If none present in the demo repos, note it and rely on the GitHoverCard unit test.)

- [ ] **Step 6: Task "who" + Open PR** — hover a task card; confirm the author + "last commit Xh ago" row, and an "Open PR ↗" link when the branch has a PR.

- [ ] **Step 7: Pipeline sort** — switch to the Pipeline tab; click the **Status** header and confirm Blocked rows float to the top; click **Last activity** and confirm newest-first; confirm the new **Who** and **Last activity** columns render.

```
$B screenshot /tmp/probe-pipeline-sort.png
```

- [ ] **Step 8: Final regression** — `cd ui && npx tsc -b && npx vitest run` (all green), and read each screenshot to confirm visually.

---

## Verification Checklist (end-to-end)

- [ ] Phase 0 review fixes committed; tree clean before feature work.
- [ ] `git-tooltip-data.ts` + `git-pipeline-sort.ts` exist, pure, unit-tested.
- [ ] Merge tooltip shows `source → target` + PR (distinct from commit).
- [ ] Remote-only tooltip distinct from plain-tip (badge + Pull).
- [ ] Trunk-line hover shows default-branch summary (was a commit card).
- [ ] "+N more" hover shows a branch-list peek; click still → Pipeline.
- [ ] Task tooltip shows git-author "who" + relative time + Open PR action.
- [ ] Commit tooltip shows relative time + "on `<branch>`".
- [ ] Pipeline headers are clickable; default = status priority → recency; Who + Last-activity columns present.
- [ ] Map running/blocked/prs/merged views are recency-sorted + capped.
- [ ] `cd ui && npx tsc -b` zero errors; `npx vitest run` all pass; esbuild harness builds.
- [ ] Live `/browse` probes on Engineering / SeaMaster / AoA demos all confirm the above.

---

## Execution Order

Phases strictly in order: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Each task ends green (tsc + relevant vitest) and is committed before the next. Do NOT batch phases.

---

## NOT in scope (deferred deliberately)

- **Tag annotation message / "release" flag** — `HoveredNode.tag` carries only `{name, sha, date}`; surfacing annotations needs a backend `git/graph` change. Tag card stays lean.
- **Agent-vs-human identity badge** — "who" is the git author string (proxy); true assignee/agent attribution needs enrichment (declined for now).
- **Dedicated CI sort key** — CI state tracks pipeline stage; the Pipeline header sorts CI rows via the `pipeline` key, no separate `ci` key.
- **Map filter "group by status" toggle** — the Map keeps recency order; status grouping lives in the Pipeline default sort only.

## What already exists (reused, not rebuilt)

- `relativeTime` (`ui/src/lib/utils.ts`) and `timeAgo` — reused for all relative timestamps; no new date helper.
- `GitHoverCard` `TaskCard`/`CommitCard`/`PlainTipCard`/`TagCard` — enriched in place; only Merge/Remote/Trunk/Cluster are new.
- `resolveTarget` — extended (new cases), not replaced.
- Branch→pipeline-stage logic — was duplicated in `deriveStage` + `PipelineDots`; **A1 consolidates both** into `pipelineStageRank` rather than adding a third copy.
- `issueStatusText` (`status-colors.ts`) — reused by the Pipeline status cell; the sort adds `STATUS_PRIORITY` (no existing ordering helper).

## Failure modes (new codepaths)

| Codepath | Failure | Test? | Error handling | Visible? |
|----------|---------|-------|----------------|----------|
| `parseMergeMessage` unknown format | returns `{null,null,null}` | ✓ (fallback case) | MergeCard hides the source→target row | graceful (shows message only) |
| `relativeTime("")` (missing `lastCommitAt`) | `Invalid Date` string | n/a | callers guard `branch.lastCommitAt && …` | guarded — renders nothing |
| `showMore` cluster name → `branchByName` miss | name dropped | ✓ (filter `(x): x is …`) | filtered out of the peek list | graceful |
| trunk hover, default branch not in `branchByName` | `branch: null` | ✓ (TrunkCard `branch?.name ?? "main"`) | summary still renders | graceful |

No failure mode is both untested AND silent → **0 critical gaps**.

## Parallelization

| Workstream | Modules | Depends on |
|-----------|---------|------------|
| Phase 0 baseline | (commit) | — |
| Lane A: tooltips | git-tooltip-data, GitHoverCard, git-arc-hit, GitGraphCanvas(resolveTarget), GitCommandCentre | Phase 1 |
| Lane B: sorting | git-pipeline-sort, GitPipelineView, GitGraphCanvas(visibleBranches) | Phase 2 |

Lane A and Lane B both touch **`GitGraphCanvas.tsx`** (A → `resolveTarget`; B → `visibleBranches` — different functions) and both depend on `git-tooltip-data.ts` (B imports `pipelineStageRank` per A1). **Recommendation: sequential** (Phases 1→2 first, then 3→4, then 5→6). The shared-file overlap makes parallel worktrees more merge-conflict-prone than the time saved is worth for a one-builder change.

## Implementation Tasks

Synthesized from this review. (JSONL artifact **skipped — `jq` not installed**; install `jq` for `/autoplan` aggregation. Markdown list below is authoritative.)

- [ ] **T1 (P2, human: ~30min / CC: ~6min)** — git-tooltip-data — consolidate `pipelineStageRank` single source (A1/D3); refactor 3 consumers. Verify: `vitest run src/__tests__/GitTooltipData.test.ts`.
- [ ] **T2 (P3, human: ~20min / CC: ~3min)** — GitGraphCanvas — memoize trunk summary; thread `trunkSummary` into `resolveTarget` (A2/D2). Verify: `tsc -b` + live trunk hover.
- [ ] **T3 (P2, human: ~1.5h / CC: ~12min)** — tests — export+test `resolveTarget`, add `GitPipelineView.test.tsx`, extract+test `sortByRecency` (A3/D4). Verify: `vitest run`.
- [ ] **T4 (P3, human: ~15min / CC: ~3min)** — GitPipelineView — `useMemo` sorted groups + commit-variant render test (A4). Verify: `vitest run`.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (design locked via mocks) |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | skipped | outside voice declined (D5) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 4 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | design locked via approved mock |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | n/a |

**Decisions:** D1 one cohesive plan · D2 memoize trunk summary · D3 single-source `pipelineStageRank` · D4 full wiring tests · D5 skip outside voice.
**UNRESOLVED:** none.
**VERDICT:** ENG CLEARED — ready to implement (subagent-driven build).

