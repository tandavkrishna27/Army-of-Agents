import { describe, expect, it } from "vitest";
import { RECOVERY_ORIGIN_KINDS } from "../services/recovery/origins.js";

describe("recovery origins", () => {
  it("exposes the productivity review origin", () => {
    expect(RECOVERY_ORIGIN_KINDS.issueProductivityReview).toBe("issue_productivity_review");
  });
});
