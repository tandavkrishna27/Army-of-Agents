import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { GitBranchInfo } from "@armyofagents/shared";
import { GitPipelineView } from "../components/workspace/GitPipelineView";

afterEach(cleanup);

function mkBranch(p: Partial<GitBranchInfo> & { name: string }): GitBranchInfo {
  return {
    name: p.name,
    isLocal: p.isLocal ?? true,
    isRemote: p.isRemote ?? true,
    aheadCount: p.aheadCount ?? 0,
    behindCount: p.behindCount ?? 0,
    lastCommitSha: "s",
    lastCommitMessage: p.lastCommitMessage ?? "msg",
    lastCommitAt: p.lastCommitAt ?? "2026-01-01T00:00:00.000Z",
    lastCommitAuthor: p.lastCommitAuthor ?? "Claude",
    linkedWorkspaceId: null,
    linkedIssueId: p.linkedIssueId ?? "issue-" + p.name,
    linkedIssueIdentifier: p.linkedIssueIdentifier ?? p.name.toUpperCase(),
    linkedIssueTitle: p.linkedIssueTitle ?? "Title for " + p.name,
    linkedIssueStatus: p.linkedIssueStatus ?? null,
    linkedIssueWorkMode: null,
    pr: p.pr ?? null,
    overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false },
    tags: p.tags ?? [],
  };
}

describe("GitPipelineView — column headers", () => {
  it("renders Who and Last activity column headers", () => {
    render(<GitPipelineView branches={[mkBranch({ name: "a", linkedIssueStatus: "in_progress" })]} />);
    expect(screen.getByText("Who")).toBeTruthy();
    expect(screen.getByText("Last activity")).toBeTruthy();
  });

  it("renders all sort header columns", () => {
    render(<GitPipelineView branches={[]} />);
    expect(screen.getByText("ID")).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.getByText("Pipeline")).toBeTruthy();
    expect(screen.getByText("Who")).toBeTruthy();
    expect(screen.getByText("Last activity")).toBeTruthy();
  });
});

describe("GitPipelineView — default sort (status priority, blocked-first)", () => {
  it("renders blocked branch before in_progress and in_review", () => {
    const branches = [
      mkBranch({ name: "ip-1", linkedIssueId: "i1", linkedIssueStatus: "in_progress", lastCommitAt: "2026-05-01T00:00:00.000Z" }),
      mkBranch({ name: "rev-1", linkedIssueId: "i2", linkedIssueStatus: "in_review", lastCommitAt: "2026-04-01T00:00:00.000Z" }),
      mkBranch({ name: "blk-1", linkedIssueId: "i3", linkedIssueStatus: "blocked", lastCommitAt: "2026-03-01T00:00:00.000Z" }),
    ];
    render(<GitPipelineView branches={branches} />);

    const rows = screen.getAllByRole("row");
    // row[0] = thead, rows[1..3] = data rows
    const firstDataRow = rows[1];
    const lastDataRow = rows[3];

    // blocked should be first
    expect(firstDataRow?.textContent).toContain("blk");
    // in_progress should be last (after in_review)
    expect(lastDataRow?.textContent).toContain("ip");
  });
});

describe("GitPipelineView — click Status header to toggle sort direction", () => {
  it("clicking Status twice flips the row order (asc→desc→asc cycle reverses position of blocked)", () => {
    const branches = [
      mkBranch({ name: "ip-2", linkedIssueId: "j1", linkedIssueStatus: "in_progress", lastCommitAt: "2026-05-01T00:00:00.000Z" }),
      mkBranch({ name: "rev-2", linkedIssueId: "j2", linkedIssueStatus: "in_review", lastCommitAt: "2026-04-01T00:00:00.000Z" }),
      mkBranch({ name: "blk-2", linkedIssueId: "j3", linkedIssueStatus: "blocked", lastCommitAt: "2026-03-01T00:00:00.000Z" }),
    ];
    render(<GitPipelineView branches={branches} />);

    // Default order (status asc): blocked first (rank 0)
    const rowsBefore = screen.getAllByRole("row");
    expect(rowsBefore[1]?.textContent).toContain("blk");

    // Click Status header once — already active key, flip asc → desc
    // desc = highest rank first: in_progress (2) > in_review (1) > blocked (0)
    const statusHeaders = screen.getAllByText("Status");
    const statusHeader = statusHeaders.find((el) => el.tagName === "TH" || el.closest("th"));
    fireEvent.click(statusHeader!);

    const rowsAfterOneClick = screen.getAllByRole("row");
    // After one click (desc): in_progress first, blocked last
    expect(rowsAfterOneClick[3]?.textContent).toContain("blk");

    // Click Status header again — flip desc → asc, blocked should be first again
    fireEvent.click(statusHeader!);

    const rowsAfterTwoClicks = screen.getAllByRole("row");
    expect(rowsAfterTwoClicks[1]?.textContent).toContain("blk");
  });
});
