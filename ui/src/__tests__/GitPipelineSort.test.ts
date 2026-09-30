import { describe, it, expect } from "vitest";
import type { GitBranchInfo } from "@armyofagents/shared";
import {
  statusRank,
  sortBranches,
  sortByRecency,
  DEFAULT_DIR,
} from "../components/workspace/git-pipeline-sort";

function b(
  name: string,
  status: string | null,
  at: string,
  ahead = 0,
  author = name[0]!,
  pr: GitBranchInfo["pr"] = null,
): GitBranchInfo {
  return {
    name,
    isLocal: true,
    isRemote: true,
    aheadCount: ahead,
    behindCount: 0,
    lastCommitSha: "s",
    lastCommitMessage: "",
    lastCommitAt: at,
    lastCommitAuthor: author,
    linkedWorkspaceId: null,
    linkedIssueId: status ? "i" : null,
    linkedIssueIdentifier: status ? name.toUpperCase() : null,
    linkedIssueTitle: null,
    linkedIssueStatus: status,
    linkedIssueWorkMode: null,
    pr,
    overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false },
    tags: [],
  };
}

// ---------------------------------------------------------------------------
// statusRank
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// sortBranches — default (status priority, then recency)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// sortBranches — activity desc puts newest first
// ---------------------------------------------------------------------------

describe("sortBranches — activity desc puts newest first", () => {
  it("sorts by lastCommitAt descending", () => {
    const list = [
      b("a", "todo", "2026-01-01"),
      b("c", "todo", "2026-05-01"),
      b("b", "todo", "2026-03-01"),
    ];
    expect(
      sortBranches(list, "activity", DEFAULT_DIR.activity).map((x) => x.name),
    ).toEqual(["c", "b", "a"]);
  });
});

// ---------------------------------------------------------------------------
// sortBranches — does not mutate input
// ---------------------------------------------------------------------------

describe("sortBranches — does not mutate input", () => {
  it("returns a new array", () => {
    const list = [b("a", "todo", "2026-01-01"), b("b", "blocked", "2026-01-01")];
    const copy = [...list];
    sortBranches(list, "status", DEFAULT_DIR.status);
    expect(list).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// sortByRecency (A3)
// ---------------------------------------------------------------------------

describe("sortByRecency", () => {
  it("returns branches newest-first", () => {
    const list = [
      b("old", "todo", "2026-01-01"),
      b("new", "todo", "2026-06-01"),
      b("mid", "todo", "2026-03-01"),
    ];
    const out = sortByRecency(list, 10).map((x) => x.name);
    expect(out).toEqual(["new", "mid", "old"]);
  });

  it("respects the cap", () => {
    const list = [
      b("c", "todo", "2026-06-01"),
      b("b", "todo", "2026-03-01"),
      b("a", "todo", "2026-01-01"),
    ];
    expect(sortByRecency(list, 2)).toHaveLength(2);
    expect(sortByRecency(list, 2)[0]!.name).toBe("c");
  });

  it("does not mutate its input", () => {
    const list = [b("x", "todo", "2026-06-01"), b("y", "todo", "2026-01-01")];
    const copy = [...list];
    sortByRecency(list, 10);
    expect(list).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// sortBranches — pipeline sort key (A3)
// ---------------------------------------------------------------------------

describe("sortBranches — pipeline key", () => {
  it("orders stages: no-ahead < ahead < remote-pushed < pr-open < merged (asc)", () => {
    const prOpen: GitBranchInfo["pr"] = {
      number: 1, url: "", reviewState: "open", ciStatus: null, ciUrl: null,
      commentCount: 0, labels: [],
    };
    const prMerged: GitBranchInfo["pr"] = {
      number: 2, url: "", reviewState: "merged", ciStatus: null, ciUrl: null,
      commentCount: 0, labels: [],
    };
    // asc = lower stage index first
    const list = [
      // stage 4: merged
      { ...b("merged", null, "2026-05-01"), pr: prMerged, isRemote: true, aheadCount: 0 },
      // stage 0: dirty (local only, no ahead)
      { ...b("dirty", null, "2026-05-01"), isLocal: true, isRemote: false, aheadCount: 0 },
      // stage 3: pr open
      { ...b("pr", null, "2026-05-01"), pr: prOpen, isRemote: true, aheadCount: 0 },
      // stage 2: pushed (remote, aheadCount=0)
      { ...b("pushed", null, "2026-05-01"), isRemote: true, aheadCount: 0 },
      // stage 1: committed (aheadCount > 0)
      { ...b("committed", null, "2026-05-01"), aheadCount: 3 },
    ];
    const out = sortBranches(list, "pipeline", "asc").map((x) => x.name);
    // asc: stage 0 first … stage 4 last
    expect(out.indexOf("dirty")).toBeLessThan(out.indexOf("committed"));
    expect(out.indexOf("committed")).toBeLessThan(out.indexOf("pushed"));
    expect(out.indexOf("pushed")).toBeLessThan(out.indexOf("pr"));
    expect(out.indexOf("pr")).toBeLessThan(out.indexOf("merged"));
  });
});

// ---------------------------------------------------------------------------
// sortBranches — who sort key (A3)
// ---------------------------------------------------------------------------

describe("sortBranches — who key", () => {
  it("sorts by lastCommitAuthor alphabetically asc", () => {
    const list = [
      b("b1", "todo", "2026-05-01", 0, "Zara"),
      b("b2", "todo", "2026-05-01", 0, "Alice"),
      b("b3", "todo", "2026-05-01", 0, "Marcus"),
    ];
    const out = sortBranches(list, "who", "asc").map((x) => x.lastCommitAuthor);
    expect(out).toEqual(["Alice", "Marcus", "Zara"]);
  });
});

// ---------------------------------------------------------------------------
// sortBranches — id sort key (A3)
// ---------------------------------------------------------------------------

describe("sortBranches — id key", () => {
  it("sorts by linkedIssueIdentifier (or name) alphabetically asc", () => {
    const list = [
      b("feat/z", "todo", "2026-01-01", 0, "x"),
      b("feat/a", "todo", "2026-01-01", 0, "x"),
      b("feat/m", "todo", "2026-01-01", 0, "x"),
    ];
    // identifiers set to uppercase branch name in helper ("FEAT/Z", etc.)
    const out = sortBranches(list, "id", "asc").map((x) => x.name);
    expect(out).toEqual(["feat/a", "feat/m", "feat/z"]);
  });
});
