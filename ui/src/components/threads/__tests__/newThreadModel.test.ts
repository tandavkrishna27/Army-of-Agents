import { describe, it, expect } from "vitest";
import { resolveCreateTarget, type NewThreadType } from "../newThreadModel";

describe("resolveCreateTarget", () => {
  it("returns thread+goal backend for goal type", () => {
    const result = resolveCreateTarget("goal");
    expect(result.backend).toBe("thread+goal");
    expect(result.requires).toContain("level");
    expect(result.requires).toContain("projectIds");
  });

  it("returns discussion backend for idea type", () => {
    expect(resolveCreateTarget("idea").backend).toBe("discussion");
  });

  it("returns discussion backend for discussion type", () => {
    expect(resolveCreateTarget("discussion").backend).toBe("discussion");
  });

  it("returns discussion backend for transcript type", () => {
    expect(resolveCreateTarget("transcript").backend).toBe("discussion");
  });

  it("returns discussion backend for document type", () => {
    expect(resolveCreateTarget("document").backend).toBe("discussion");
  });

  it("returns empty requires array for non-goal types", () => {
    const types: NewThreadType[] = ["idea", "discussion", "transcript", "document"];
    for (const type of types) {
      expect(resolveCreateTarget(type).requires).toHaveLength(0);
    }
  });
});
