import { describe, expect, it } from "vitest";
import { resolveRunMemoryScope } from "../services/memory-run-scope.js";

describe("resolveRunMemoryScope", () => {
  it("scopes to the department when the issue's project is a department", () => {
    expect(
      resolveRunMemoryScope({ projectId: "p1", projectType: "department", goalId: "g1" }),
    ).toEqual({ departmentId: "p1", goalId: "g1" });
  });

  it("does not set departmentId for a project-type issue (dept-only scoping)", () => {
    expect(
      resolveRunMemoryScope({ projectId: "p1", projectType: "project", goalId: null }),
    ).toEqual({});
  });

  it("carries the goal even with no project", () => {
    expect(resolveRunMemoryScope({ projectId: null, projectType: null, goalId: "g1" })).toEqual({
      goalId: "g1",
    });
  });

  it("returns an empty scope for a null issue", () => {
    expect(resolveRunMemoryScope(null)).toEqual({});
  });
});
