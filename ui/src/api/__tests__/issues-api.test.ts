import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();

vi.mock("../client", () => ({
  api: {
    get: (...args: unknown[]) => get(...args),
  },
}));

import { issuesApi } from "../issues";

describe("issuesApi", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serializes createdByUserId with the issue list filters", async () => {
    get.mockResolvedValueOnce([]);

    await issuesApi.list("company-1", {
      createdByUserId: "user-1",
      assigneeUserId: "user-2",
      taskScope: "all",
    });

    expect(get).toHaveBeenCalledWith(
      "/companies/company-1/issues?assigneeUserId=user-2&createdByUserId=user-1&taskScope=all",
    );
  });

  it("serializes responsibleUserId with the issue list filters", async () => {
    get.mockResolvedValueOnce([]);

    await issuesApi.list("company-1", {
      responsibleUserId: "user-1",
      taskScope: "all",
    });

    expect(get).toHaveBeenCalledWith(
      "/companies/company-1/issues?responsibleUserId=user-1&taskScope=all",
    );
  });
  it("observes a task comment submission with a read-only lookup", async () => {
    get.mockResolvedValueOnce({ state: "not_found" });
    await issuesApi.getCommentSubmissionOutcome("task-1", "submission/1");
    expect(get).toHaveBeenCalledWith("/issues/task-1/comments/submissions/submission%2F1");
  });
});
