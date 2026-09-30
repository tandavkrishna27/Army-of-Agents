import { describe, expect, it, vi } from "vitest";
import { resolveIssueReviewer } from "../services/issue-reviewer.js";

function sequenceDb(rows: Array<Array<Record<string, unknown>>>) {
  let index = 0;
  const chain = () => {
    const value: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "where", "orderBy"]) {
      value[method] = vi.fn(() => value);
    }
    value.then = (resolve: (result: Array<Record<string, unknown>>) => unknown) =>
      Promise.resolve(resolve(rows[index++] ?? []));
    return value;
  };
  return { select: vi.fn(chain) };
}

describe("resolveIssueReviewer", () => {
  it("keeps an explicit active reviewer", async () => {
    const db = sequenceDb([[{ id: "membership-1" }]]);
    await expect(resolveIssueReviewer(db as never, {
      companyId: "company-1",
      projectId: "project-1",
      explicitReviewerUserId: "user-explicit",
      existingReviewerSource: null,
      responsibleUserId: "user-responsible",
    })).resolves.toEqual({ reviewerUserId: "user-explicit", reviewerSource: "explicit" });
  });

  it("uses the responsible human before hierarchy roles", async () => {
    const db = sequenceDb([[{ id: "membership-1" }]]);
    await expect(resolveIssueReviewer(db as never, {
      companyId: "company-1",
      projectId: "project-1",
      explicitReviewerUserId: null,
      existingReviewerSource: null,
      responsibleUserId: "user-responsible",
    })).resolves.toEqual({ reviewerUserId: "user-responsible", reviewerSource: "responsible" });
  });

  it("falls back from scoped team lead to founder", async () => {
    const db = sequenceDb([[], [{ userId: "user-founder" }]]);
    await expect(resolveIssueReviewer(db as never, {
      companyId: "company-1",
      projectId: "project-1",
      explicitReviewerUserId: null,
      existingReviewerSource: null,
      responsibleUserId: null,
    })).resolves.toEqual({ reviewerUserId: "user-founder", reviewerSource: "founder" });
  });

  it("fails clearly when no review path exists", async () => {
    const db = sequenceDb([[], []]);
    await expect(resolveIssueReviewer(db as never, {
      companyId: "company-1",
      projectId: "project-1",
      explicitReviewerUserId: null,
      existingReviewerSource: null,
      responsibleUserId: null,
    })).rejects.toMatchObject({ status: 422, details: { code: "reviewer_unavailable" } });
  });
});
