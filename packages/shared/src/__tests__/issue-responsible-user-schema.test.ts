import { describe, expect, it } from "vitest";
import { createIssueSchema, updateIssueSchema } from "../validators/issue.js";

describe("issue responsible user schema", () => {
  it("accepts responsibleUserId on task creation", () => {
    const parsed = createIssueSchema.parse({
      title: "Prepare investor update",
      responsibleUserId: "user-1",
    });

    expect(parsed.responsibleUserId).toBe("user-1");
  });

  it("retains a source discussion link during task creation", () => {
    const sourceDiscussionId = "77777777-7777-4777-8777-777777777777";
    const parsed = createIssueSchema.parse({
      title: "Investigate customer signal",
      sourceDiscussionId,
    });

    expect(parsed.sourceDiscussionId).toBe(sourceDiscussionId);
  });

  it("accepts clearing responsibleUserId on task update", () => {
    const parsed = updateIssueSchema.parse({ responsibleUserId: null });

    expect(parsed.responsibleUserId).toBeNull();
  });
});
