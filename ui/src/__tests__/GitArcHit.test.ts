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
    expect(hitRegionAt(regions, 100, 100)).toEqual({ kind: "commit", sha: "c1" });
  });
  it("hits the poly within threshold when no rect overlaps", () => {
    expect(hitRegionAt(regions, 40, 104)).toEqual({ kind: "trunkLine" });
  });
  it("returns null when nothing is near", () => {
    expect(hitRegionAt(regions, 400, 400)).toBeNull();
  });
});

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
    expect(hitRegionAt(regions, 500 + 50 + 27, 200 + 8 + 7)).toEqual({ kind: "showMore", branchNames: ["d", "e"] });
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

  it("emits a HEAD-label rect above the default tip (same target as the tip)", () => {
    const node = mkNode({ sha: "h1", x: 800, y: 200, isTrunk: true, isDefault: true, isBranchTip: true, branchName: "main" });
    const regions = buildHitRegions({
      layout: emptyLayout([node]), visibleNames: new Set(["main"]), arcVisibleNames: new Set(),
      visibleStacks: [], stackedShas: new Set(), branchByName, taskBranchByTipSha: new Map(),
      trunkSpan: null, defaultBranch: "main",
    });
    // drawHeadLabel for a non-task tip: labelY = y - COMMIT_R(5) - 8 = 187.
    expect(hitRegionAt(regions, 800, 200 - 5 - 8)).toEqual({ kind: "plainTip", branchName: "main" });
  });

  it("emits an arc-name-label rect for a plain active arc (not done, not card-labelled)", () => {
    const arc = {
      branchName: "feat/lbl", direction: "down" as const, branchPointX: 100, mergePointX: 300,
      apexY: 260, isOpen: false, color: "#7E8AA8", isDone: false,
      points: [[100, 200], [200, 260], [300, 200]] as Array<[number, number]>,
    };
    const layout: ArcLayoutResult = {
      nodes: [], arcs: [arc], trunkY: 200, totalWidth: 1000, totalHeight: 500, tipStacks: [],
    };
    const regions = buildHitRegions({
      layout, visibleNames: new Set(["feat/lbl"]), arcVisibleNames: new Set(["feat/lbl"]),
      visibleStacks: [], stackedShas: new Set(), branchByName: new Map([["feat/lbl", mkBranch("feat/lbl", null)]]),
      taskBranchByTipSha: new Map(), trunkSpan: null, defaultBranch: "main",
    });
    // labelX = (100+300)/2 = 200; baseY = apexY + 14 = 274 (down arc).
    expect(hitRegionAt(regions, 200, 274 - 4)).toEqual({ kind: "plainTip", branchName: "feat/lbl" });
  });

  it("a stack with absorbed plain branches (extraNames) still emits a showMore pill", () => {
    const stack = { sha: "c1", x: 500, y: 200, branchNames: ["a", "b"], extraNames: ["p1", "p2", "p3"] };
    const bb = new Map([["a", mkBranch("a", "i-a")], ["b", mkBranch("b", "i-b")]]);
    const regions = buildHitRegions({
      layout: emptyLayout([]), visibleNames: new Set(["a", "b"]),
      arcVisibleNames: new Set(), visibleStacks: [stack], stackedShas: new Set(["c1"]),
      branchByName: bb, taskBranchByTipSha: new Map(), trunkSpan: null, defaultBranch: "main",
    });
    expect(hitRegionAt(regions, 500 + 50 + 27, 200 + 8 + 7)).toEqual({ kind: "showMore", branchNames: ["p1", "p2", "p3"] });
  });

  it("emits one tag rect per drawn pill (2nd pill reports the 2nd tag, not tags[0])", () => {
    // Trunk node => visible without arcs. Two tags => drawTagPills paints 2 pills,
    // each sized to its own text, so the builder must too (the old code emitted a
    // single 90px rect hardcoded to tags[0], so the 2nd pill reported tags[0]).
    const node = mkNode({ sha: "c1", x: 500, y: 200, isTrunk: true, branchName: "main", tags: ["v1.0", "v2.0"] });
    const regions = buildHitRegions({
      layout: emptyLayout([node]), visibleNames: new Set(["main"]), arcVisibleNames: new Set(),
      visibleStacks: [], stackedShas: new Set(), branchByName, taskBranchByTipSha: new Map(),
      trunkSpan: null, defaultBranch: "main",
    });
    // pill1: x0 = 500 + COMMIT_R(5) + 4 = 509, w = 4*5.5+10 = 32 -> center ~525
    expect(hitRegionAt(regions, 525, 200)).toEqual({ kind: "tag", name: "v1.0", sha: "c1" });
    // pill2: x = 509 + 32 + 4 = 545, w = 32 -> center ~561
    expect(hitRegionAt(regions, 561, 200)).toEqual({ kind: "tag", name: "v2.0", sha: "c1" });
  });

  it("a non-tip node that resolves a task via taskBranchByTipSha does NOT suppress its arc-name label", () => {
    // feat/x has a linkedIssue and an active arc. Its only node is NOT a task tip
    // (isTaskTip:false) but resolves feat/x via taskBranchByTipSha (the stale
    // lastCommitSha / Phase-4D case). Before the parity fix this wrongly added
    // feat/x to cardBranchNames, so placeArcLabels skipped the label (no region)
    // and re-flowed every later label's y. The label must still be hittable.
    const arc = {
      branchName: "feat/x", direction: "down" as const, branchPointX: 100, mergePointX: 300,
      apexY: 260, isOpen: false, color: "#7E8AA8", isDone: false,
      points: [[100, 200], [200, 260], [300, 200]] as Array<[number, number]>,
    };
    const node = mkNode({ sha: "c1", x: 200, y: 200, isTaskTip: false, arcBranchName: "feat/x", branchName: "feat/x" });
    const layout: ArcLayoutResult = {
      nodes: [node], arcs: [arc], trunkY: 200, totalWidth: 1000, totalHeight: 500, tipStacks: [],
    };
    const regions = buildHitRegions({
      layout, visibleNames: new Set(["feat/x"]), arcVisibleNames: new Set(["feat/x"]),
      visibleStacks: [], stackedShas: new Set(),
      branchByName: new Map([["feat/x", mkBranch("feat/x", "i1")]]),
      taskBranchByTipSha: new Map([["c1", mkBranch("feat/x", "i1")]]),
      trunkSpan: null, defaultBranch: "main",
    });
    // labelX = (100+300)/2 = 200; down-arc baseY = apexY + 14 = 274 (label sits below the apex, clear of the card box).
    expect(hitRegionAt(regions, 200, 274 - 4)).toEqual({ kind: "task", branchName: "feat/x" });
  });
});
