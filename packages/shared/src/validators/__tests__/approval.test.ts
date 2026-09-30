import { describe, expect, it } from "vitest";
import { resolveApprovalSchema, requestApprovalRevisionSchema } from "../approval.js";

describe("resolveApprovalSchema", () => {
  it("accepts decisionNote alone", () => {
    expect(resolveApprovalSchema.safeParse({ decisionNote: "ok" }).success).toBe(true);
  });
  it("accepts empty body", () => {
    expect(resolveApprovalSchema.safeParse({}).success).toBe(true);
  });
  it("rejects body containing decidedByUserId (strict)", () => {
    const result = resolveApprovalSchema.safeParse({
      decisionNote: "ok",
      decidedByUserId: "alice@evil.com",
    });
    expect(result.success).toBe(false);
  });
});

describe("requestApprovalRevisionSchema", () => {
  it("accepts decisionNote alone", () => {
    expect(requestApprovalRevisionSchema.safeParse({ decisionNote: "needs work" }).success).toBe(true);
  });
  it("rejects body containing decidedByUserId", () => {
    const result = requestApprovalRevisionSchema.safeParse({
      decisionNote: "x",
      decidedByUserId: "x",
    });
    expect(result.success).toBe(false);
  });
});
