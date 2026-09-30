import { describe, expect, it } from "vitest";
import {
  selectTaskOwnedReusableExecutionWorkspace,
  type TaskOwnedWorkspaceCandidate,
} from "../services/execution-workspaces-idempotency.js";

describe("selectTaskOwnedReusableExecutionWorkspace", () => {
  it("selects the first already-ordered non-archived task-owned workspace", () => {
    const selected = selectTaskOwnedReusableExecutionWorkspace(
      [
        {
          id: "active-newest",
          status: "active",
          sourceIssueId: "issue-1",
        },
        {
          id: "active-older",
          status: "idle",
          sourceIssueId: "issue-1",
        },
      ],
      "issue-1",
    );

    expect(selected?.id).toBe("active-newest");
  });

  it("ignores archived rows and rows for other tasks", () => {
    const selected = selectTaskOwnedReusableExecutionWorkspace(
      [
        {
          id: "archived",
          status: "archived",
          sourceIssueId: "issue-1",
        },
        {
          id: "other",
          status: "active",
          sourceIssueId: "issue-2",
        },
      ],
      "issue-1",
    );

    expect(selected).toBeNull();
  });

  it("returns the raced row after a unique-index collision can be re-fetched", () => {
    const rows: TaskOwnedWorkspaceCandidate[] = [
      {
        id: "raced",
        status: "active",
        sourceIssueId: "issue-1",
      },
    ];

    expect(selectTaskOwnedReusableExecutionWorkspace(rows, "issue-1")?.id).toBe("raced");
  });
});
