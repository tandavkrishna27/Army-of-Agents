import { describe, expect, it } from "vitest";
import { ISSUE_WORK_MODES } from "../constants.js";
import { createIssueSchema } from "../validators/issue.js";

describe("ISSUE_WORK_MODES", () => {
  it("contains standard and planning", () => {
    expect(ISSUE_WORK_MODES).toContain("standard");
    expect(ISSUE_WORK_MODES).toContain("planning");
  });
});

describe("createIssueSchema workMode", () => {
  it("defaults to standard when omitted", () => {
    const result = createIssueSchema.parse({ title: "Test task" });
    expect(result.workMode).toBe("standard");
  });

  it("accepts planning", () => {
    const result = createIssueSchema.parse({ title: "Plan task", workMode: "planning" });
    expect(result.workMode).toBe("planning");
  });

  it("rejects unknown modes", () => {
    expect(() => createIssueSchema.parse({ title: "T", workMode: "review" })).toThrow();
  });
});
